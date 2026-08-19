#!/usr/bin/env node
// Nightly harvester. docs/DESIGN.md §3.2, §3.6, §4.4.
//
// Draws buckets from the prefix space in a keyed without-replacement order, retrieves
// every member of each bucket, enriches in bulk, and appends to the pool.
//
// The defining risk here is NOT crashing — it is succeeding quietly while producing
// nothing, forever. So the run asserts its own validity (§4.4) and exits non-zero when
// the mechanism looks broken, which the workflow turns into a GitHub issue.

import {
  searchPage,
  videosMeta,
  COST,
  QuotaExceeded,
  ApiKeyError,
  sleep,
} from './lib/youtube.mjs'
import { prefixAt, PREFIX_SPACE, PREFIX_LENGTH } from './lib/prefix.mjs'
import {
  readManifest,
  writeManifest,
  readState,
  writeState,
  readAllIds,
  appendRecords,
  SHARD_SIZE,
} from './lib/pool.mjs'
import { loadKey } from './lib/env.mjs'

const UNIT_BUDGET = Number(process.env.HARVEST_UNITS ?? 9500)
const REHARVEST_SHARE = 0.3 // fraction of buckets spent re-drawing old ones (§3.3.5)
// Safety quarantine keyed on UPLOAD age, not harvest age (docs/DESIGN.md §5.3).
// YouTube's moderation lag applies to freshly uploaded videos; a 2019 upload gains
// nothing from sitting a week just because we happened to draw it today. Keying on
// harvest date would also have left the site empty for its first week.
const MIN_UPLOAD_AGE_DAYS = 30
const PACING_MS = 350 // stay under the per-minute rate limit
const MAX_PAGES = 3 // a k=5 bucket needing >150 results is anomalous; drop it
const YIELD_FLOOR_RATIO = 0.5 // run-level yield below half baseline is fatal
const FEISTEL_KEY = process.env.HARVEST_KEY ?? 'RandomYoutubeLinkGenerator/v1'

// A known dash-token ID. If this stops resolving, YouTube changed the tokenizer and
// every downstream number is meaningless — this is the one check that catches it.
const CANARY = { token: 'my8exz', id: 'my8EXZ-mqpQ' }

const key = loadKey()
let units = 0
const spend = (n) => {
  units += n
}
const remaining = () => UNIT_BUDGET - units

const manifest = readManifest()
const state = readState()
const existingIds = readAllIds()
const runStarted = new Date()

console.log(
  `pool: ${manifest.total} videos, counter at ${state.counter}/${PREFIX_SPACE}`,
)

// --- canary -----------------------------------------------------------------
// Deliberately uninitialised: every path through the catch below either exits the
// process or rethrows, so a default value would never be observed.
let canaryOk
try {
  const { ids } = await searchPage(key, CANARY.token)
  spend(COST.search)
  canaryOk = ids.includes(CANARY.id)
} catch (err) {
  if (err instanceof ApiKeyError) {
    console.error(`FATAL: ${err.message}`)
    process.exit(1)
  }
  if (err instanceof QuotaExceeded) {
    console.error('quota already exhausted; nothing to do')
    process.exit(0)
  }
  throw err
}
if (!canaryOk) {
  console.error(
    `FATAL: canary "${CANARY.token}" no longer returns ${CANARY.id}.`,
  )
  console.error(
    'The dash-token mechanism has changed. Harvesting is suspended.',
  )
  recordHealth('mechanism-broken', 0, null)
  process.exit(1)
}
console.log('canary OK')

// --- plan the run -----------------------------------------------------------
const affordable = Math.floor(remaining() / COST.search)
const reharvestCount = Math.min(
  Math.floor(affordable * REHARVEST_SHARE),
  state.counter,
)
const freshCount = affordable - reharvestCount

const plan = []
for (let i = 0; i < freshCount && state.counter + i < PREFIX_SPACE; i++) {
  plan.push({ n: state.counter + i, fresh: true })
}
for (let i = 0; i < reharvestCount; i++) {
  plan.push({
    n: (state.reharvestCursor + i) % Math.max(state.counter, 1),
    fresh: false,
  })
}
console.log(
  `plan: ${freshCount} fresh + ${reharvestCount} re-harvest buckets (${remaining()} units)`,
)

// --- harvest ----------------------------------------------------------------
const found = new Map()
const priorCounter = state.counter
let freshAttempted = 0
let reharvestAttempted = 0
// The fresh counter may only advance over a CONTIGUOUS run of queried prefixes, because
// state.counter is a single integer resume point. Once one fresh bucket fails, every
// later success in this run must not be counted, or the failed prefix is skipped for
// good while a later one gets queried twice.
let freshHole = false
let bucketsDone = 0
let unexhausted = 0
let quotaHit = false

for (const { n, fresh } of plan) {
  if (remaining() < COST.search * (MAX_PAGES + 1)) break
  await sleep(PACING_MS)
  const q = prefixAt(FEISTEL_KEY, n)
  try {
    const { ids, exhausted } = await harvestBucket(q)
    bucketsDone++
    // Count the prefix consumed only once the query actually came back. Counting
    // before the try burned prefixes on every throw — and because HARVEST_UNITS sits
    // just under the daily quota, a QuotaExceeded throw is the NORMAL way a run ends.
    // An unexhausted bucket still counts: it was queried and deliberately rejected,
    // so retrying it forever would stall the counter behind one bad prefix.
    if (fresh) {
      if (!freshHole) freshAttempted++
    } else {
      // The re-harvest cursor tolerates holes: a skipped bucket simply comes back one
      // rotation later, so it needs no contiguity rule.
      reharvestAttempted++
    }
    if (!exhausted) {
      unexhausted++
      continue
    } // never take a partial bucket (§3.3.3)
    for (const id of ids) if (!existingIds.has(id)) found.set(id, q)
  } catch (err) {
    if (err instanceof QuotaExceeded) {
      quotaHit = true
      break
    }
    if (err instanceof ApiKeyError) {
      console.error(`FATAL: ${err.message}`)
      process.exit(1)
    }
    // A generic failure (persistent 5xx, network) does not stop the run, but it does
    // punch a hole in the fresh sequence — so freeze the fresh counter here. The cost is
    // re-querying a few prefixes next run; the alternative is losing one permanently.
    if (fresh) freshHole = true
    console.warn(`bucket ${q} failed: ${err.message}`)
  }
}

async function harvestBucket(q) {
  const ids = []
  let pageToken
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await searchPage(key, q, pageToken)
    spend(COST.search)
    ids.push(...res.ids.filter((id) => id.toLowerCase().startsWith(`${q}-`)))
    if (!res.nextPageToken) return { ids, exhausted: true }
    pageToken = res.nextPageToken
  }
  return { ids, exhausted: false }
}

const yieldPer = bucketsDone > 0 ? found.size / bucketsDone : 0
console.log(
  `harvested ${bucketsDone} buckets -> ${found.size} new IDs (${yieldPer.toFixed(2)}/bucket)`,
)
if (unexhausted > 0)
  console.warn(`${unexhausted} buckets dropped as unexhausted`)

// --- enrich -----------------------------------------------------------------
let records = []
if (found.size > 0 && remaining() > 0) {
  const meta = await videosMeta(key, [...found.keys()])
  spend(Math.ceil(found.size / 50) * COST.videos)
  const stamp = runStarted.toISOString()
  const uploadCutoff = runStarted.getTime() - MIN_UPLOAD_AGE_DAYS * 86400_000
  const isSeasoned = (m) =>
    m.publishedAt && new Date(m.publishedAt).getTime() < uploadCutoff
  const publicMeta = meta.filter((m) => m.privacyStatus === 'public')
  const tooFresh = publicMeta.filter((m) => !isSeasoned(m)).length
  if (tooFresh > 0)
    console.log(
      `held back ${tooFresh} videos uploaded in the last ${MIN_UPLOAD_AGE_DAYS}d`,
    )
  records = publicMeta.filter(isSeasoned).map((m) => ({
    id: m.id,
    t: m.title,
    pub: m.publishedAt,
    v: m.views,
    dur: m.duration,
    emb: m.embeddable,
    age: m.ageRestricted,
    mfk: m.madeForKids,
    h: stamp,
  }))
  console.log(
    `enriched ${records.length} public videos (${meta.length - records.length} non-public dropped)`,
  )
}

// --- validity gates ---------------------------------------------------------
const baseline = manifest.health?.baselineYield ?? null
if (baseline && bucketsDone >= 20 && yieldPer < baseline * YIELD_FLOOR_RATIO) {
  console.error(
    `FATAL: yield ${yieldPer.toFixed(2)}/bucket is below half the ${baseline.toFixed(2)} baseline.`,
  )
  recordHealth('yield-collapsed', bucketsDone, yieldPer)
  process.exit(1)
}

// --- commit -----------------------------------------------------------------
const total = appendRecords(records, manifest.total)
// Everything in the pool has already cleared the upload-age quarantine at harvest time,
// so the whole pool is servable; the client still filters safety flags and tombstones.
const servable = total

// Advance by prefixes we actually QUERIED, not by the number planned. The loop exits
// early on budget exhaustion or quotaExceeded, and `affordable` assumes one page per
// bucket while a bucket may cost up to MAX_PAGES. Advancing by the plan permanently
// burned prefixes that were never sampled, silently shrinking the frame (P0 per
// CLAUDE.md). Only a contiguous run of successfully queried fresh buckets counts; see
// freshHole above.
state.counter = Math.min(state.counter + freshAttempted, PREFIX_SPACE)
// Same correction for the re-harvest cursor. The plan's fresh entries all precede the
// re-harvest ones, so a break during the fresh section runs ZERO re-harvest buckets while
// the cursor would still jump by the planned count, skipping those old buckets for a full
// rotation. Reduce modulo the PRIOR counter, since the plan indices were built against it
// and state.counter has already advanced on the line above.
state.reharvestCursor =
  priorCounter > 0
    ? (state.reharvestCursor + reharvestAttempted) % priorCounter
    : 0
state.totalBuckets += bucketsDone
writeState(state)

manifest.total = total
manifest.servable = servable
manifest.shardSize = SHARD_SIZE
manifest.generatedAt = runStarted.toISOString()
manifest.stats = {
  prefixLength: PREFIX_LENGTH,
  prefixSpace: PREFIX_SPACE,
  bucketsEverDrawn: state.totalBuckets,
  embeddablePct: pct(records, (r) => r.emb),
  ageRestrictedPct: pct(records, (r) => r.age),
  minUploadAgeDays: MIN_UPLOAD_AGE_DAYS,
}
recordHealth(quotaHit ? 'ok-quota-capped' : 'ok', bucketsDone, yieldPer)

console.log(`pool now ${total} videos (${servable} servable)`)
console.log(`spent ~${units} quota units`)

function pct(rows, pred) {
  if (rows.length === 0) return null
  return Math.round((rows.filter(pred).length / rows.length) * 1000) / 10
}

function recordHealth(status, buckets, y) {
  const prior = manifest.health?.baselineYield ?? null
  manifest.health = {
    status,
    lastRunUtc: runStarted.toISOString(),
    buckets,
    yield: y,
    // Slow-moving baseline so the yield gate adapts rather than drifting into false alarms.
    baselineYield:
      y != null && buckets >= 20 ? (prior ? prior * 0.8 + y * 0.2 : y) : prior,
  }
  writeManifest(manifest)
}
