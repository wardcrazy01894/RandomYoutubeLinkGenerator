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

/**
 * Env numbers, parsed so that an explicit 0 survives and an empty/garbage value does not.
 * `Number(x ?? d)` treats '' as 0; `Number(x) || d` throws away a deliberate 0. Both were
 * wrong here: the first would mean zero pacing (429s), the second silently ignored the
 * HARVEST_PACING_MS=0 the tests set.
 */
const envNum = (raw, fallback) => {
  // Trimmed: Number(' ') is 0, so a whitespace-only value would otherwise read as an
  // explicit zero rather than "unset".
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

// 9000, not 9500: the nightly sweep shares the same 10,000-unit day and takes 500,
// and a 9500 default left the day with no margin at all for a retry.
const UNIT_BUDGET = envNum(process.env.HARVEST_UNITS, 9000)
const REHARVEST_SHARE = 0.3 // fraction of buckets spent re-drawing old ones (§3.3.5)
// Safety quarantine keyed on UPLOAD age, not harvest age (docs/DESIGN.md §5.3).
// YouTube's moderation lag applies to freshly uploaded videos; a 2019 upload gains
// nothing from sitting a week just because we happened to draw it today. Keying on
// harvest date would also have left the site empty for its first week.
const MIN_UPLOAD_AGE_DAYS = 30
const PACING_MS = envNum(process.env.HARVEST_PACING_MS, 350) // per-minute rate limit
const MAX_PAGES = 3 // a k=5 bucket needing >150 results is anomalous; drop it
const YIELD_FLOOR_RATIO = 0.5 // run-level yield below half baseline is fatal
// Deliberately relearn the baseline instead of being measured against the stored one.
// Must apply to BOTH the gate and recordHealth: applying it only to the latter would
// leave the gate failing against the old baseline and exiting before writeState, so
// nothing would ever be relearned. See docs/OPERATIONS.md.
// Strictly '1'. Boolean() treated '0' and 'false' as ON, so the most natural way to
// write "off" silently disabled the yield gate and relearned the baseline from a
// collapsed run — the exact self-silencing this whole change exists to remove.
const BASELINE_RESET = process.env.HARVEST_BASELINE_RESET === '1'
// `??` let HARVEST_KEY='' through literally, silently re-keying the Feistel permutation
// while state.counter kept advancing — a different prefix sequence over the same counter,
// which is the frame-shrinking P0 this file warns about below.
const FEISTEL_KEY = process.env.HARVEST_KEY || 'RandomYoutubeLinkGenerator/v1'

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

// Run-shape counters, declared before the canary so runShape() is safe to call from any
// recordHealth site. The canary runs before the plan is built, so these bindings would
// otherwise sit in the temporal dead zone there — a future edit adding runShape() to that
// call would crash with a ReferenceError instead of recording the status.
let freshCount = 0
let freshAttempted = 0
let reharvestAttempted = 0
// The fresh counter may only advance over a CONTIGUOUS run of queried prefixes, because
// state.counter is a single integer resume point. Once one fresh bucket fails, every
// later success in this run must not be counted, or the failed prefix is skipped for good
// while a later one gets queried twice.
let freshHole = false
let freshNew = 0

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
freshCount = affordable - reharvestCount

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
let bucketsDone = 0
let unexhausted = 0
let quotaHit = false

for (const { n, fresh } of plan) {
  if (remaining() < COST.search * (MAX_PAGES + 1)) break
  // Once a fresh bucket has failed, the counter is frozen for this run, so any further
  // fresh query would be re-harvested tomorrow anyway — and worse, committing its records
  // while the counter stays put collapses tomorrow's yield, trips the yield gate, and the
  // gate exits BEFORE writeState. That loops: same frozen counter, same collapse, night
  // after night. Skipping the rest of the fresh plan keeps the damage to a single run and
  // lets the remaining budget fall through to the re-harvest entries.
  if (fresh && freshHole) continue
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
      // freshHole is impossible here: the loop `continue`s every fresh entry once it is
      // set, and nothing can set it during the await above.
      freshAttempted++
    } else {
      // The re-harvest cursor tolerates holes: a skipped bucket simply comes back one
      // rotation later, so it needs no contiguity rule.
      reharvestAttempted++
    }
    if (!exhausted) {
      unexhausted++
      continue
    } // never take a partial bucket (§3.3.3)
    for (const id of ids) {
      if (existingIds.has(id) || found.has(id)) continue
      found.set(id, q)
      // Counted separately: the baseline and the gate must measure FRESH buckets only.
      // Mixing in re-harvest buckets — which legitimately return nothing new — diluted
      // the number being compared against a fresh-derived threshold.
      if (fresh) freshNew++
    }
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
// What the baseline tracks and the gate compares: new videos per FRESH bucket. null when
// no fresh bucket completed — a distinct condition from "zero yield", alarmed separately.
const freshYield = freshAttempted > 0 ? freshNew / freshAttempted : null
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
const baseline = BASELINE_RESET
  ? null
  : (manifest.health?.baselineYield ?? null)
// No fresh bucket completed at all, though the run planned some and had budget to run
// them. This is NOT a low yield — there is no measurement — so the yield gate below
// cannot see it, and gating on freshAttempted made that case permanently silent: counter
// frozen, nothing published, "ok" reported every night. Excludes the quota-capped and
// no-budget endings, which are normal.
if (
  freshCount > 0 &&
  freshAttempted === 0 &&
  !quotaHit &&
  (bucketsDone > 0 || freshHole)
) {
  console.error(
    `FATAL: ${bucketsDone} buckets ran but not one of the ${freshCount} planned fresh ` +
      `buckets completed. The sampling frontier is not advancing.`,
  )
  recordHealth('no-fresh-progress', bucketsDone, null, runShape())
  process.exit(1)
}

// Gate on the FRESH yield. Comparing a fresh-derived baseline against a mixed
// fresh+re-harvest number made a healthy truncated run look collapsed right at the
// threshold, and a fully-failed fresh plan look fine.
if (
  baseline &&
  freshAttempted >= 20 &&
  freshYield !== null &&
  freshYield < baseline * YIELD_FLOOR_RATIO
) {
  console.error(
    `FATAL: fresh yield ${freshYield.toFixed(2)}/bucket is below half the ${baseline.toFixed(2)} baseline.`,
  )
  recordHealth('yield-collapsed', bucketsDone, freshYield, runShape())
  process.exit(1)
}

// --- commit -----------------------------------------------------------------
const total = appendRecords(records, manifest.total)
// Everything in the pool has already cleared the upload-age quarantine at harvest time,
// so the whole pool is servable; the client filters blocklist, tombstones and flags.
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
recordHealth(
  quotaHit ? 'ok-quota-capped' : 'ok',
  bucketsDone,
  freshYield,
  runShape(),
)

console.log(`pool now ${total} videos (${servable} servable)`)
console.log(`spent ~${units} quota units`)

/**
 * What this run actually did, as opposed to what it planned. Without this, a run that
 * abandoned its fresh plan after one failure is indistinguishable from a complete one.
 */
function runShape() {
  return {
    freshPlanned: freshCount,
    freshAttempted,
    reharvestAttempted,
    truncated: freshHole,
    // Overall yield across fresh AND re-harvest buckets, for diagnosis only. The
    // baseline deliberately tracks the fresh-only number.
    yieldAll: yieldPer,
  }
}

function pct(rows, pred) {
  if (rows.length === 0) return null
  return Math.round((rows.filter(pred).length / rows.length) * 1000) / 10
}

function recordHealth(status, buckets, y, extra = {}) {
  // Removing the decay removed the only way a permanently-changed yield could unstick
  // itself: a collapsed run now exits before writeState, so the same night repeats
  // forever. That is correct — an alarm must not silence itself — but the operator needs
  // a deliberate way to accept a new normal. See docs/OPERATIONS.md.
  const stored = manifest.health?.baselineYield ?? null
  const prior = BASELINE_RESET ? null : stored
  // ONLY a healthy run may move the baseline. Folding a collapsed yield into it made the
  // gate self-silencing: each failed night dragged the baseline toward the broken value
  // (4.5 -> 3.7 -> ... -> 1.2), and once it fell below the residual yield the run started
  // reporting "ok" while harvesting a fraction of the buckets. That is exactly the
  // "succeeds quietly while producing nothing" mode CLAUDE.md says to design against,
  // reached by the alarm quietly lowering its own threshold.
  // A truncated run is unrepresentative by construction — it abandoned its fresh plan
  // and is mostly re-harvest buckets — so letting it move the baseline walks the
  // threshold down over successive nights, reaching the same self-silencing state via
  // 'ok' rather than via failure.
  const healthy =
    (status === 'ok' || status === 'ok-quota-capped') && !freshHole
  const canLearn = healthy && y != null && buckets >= 20
  if (BASELINE_RESET && !canLearn) {
    console.warn(
      `HARVEST_BASELINE_RESET was set, but this run cannot relearn a baseline ` +
        `(${buckets} buckets, status "${status}"). Keeping the stored value rather than ` +
        `erasing it — re-run with a full budget to make the reset take effect.`,
    )
  }
  manifest.health = {
    ...extra,
    status,
    lastRunUtc: runStarted.toISOString(),
    buckets,
    yield: y,
    // Slow-moving so the gate adapts to real drift rather than firing on noise. When a
    // run cannot learn, the STORED value is kept rather than `prior` — otherwise a reset
    // on a run too small to relearn would erase the baseline and leave the gate off
    // until some later run happened to rebuild it unattended.
    baselineYield: canLearn ? (prior ? prior * 0.8 + y * 0.2 : y) : stored,
  }
  writeManifest(manifest)
}
