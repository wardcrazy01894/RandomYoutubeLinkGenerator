#!/usr/bin/env node
// Incremental re-validation sweep. docs/DESIGN.md §5.3.
//
// This removes videos YouTube has deleted or made private since we harvested them. It is
// deliberately NOT described as the primary safety mechanism (see DESIGN §5.3, "What it
// is not") — a deleted video cannot play anyway, and the client's onError already hides
// it. The value here is pool-wide removal and an honest served count.
// Age-restriction and embeddability are deliberately NOT swept — they are governed by the
// safe-mode toggle, and tombstoning them would convert a filter the viewer can lift into
// a removal they cannot. See the dead-detection block below.
//
// The sweep is INCREMENTAL: each run re-checks a window starting at the persisted
// `sweepCursor` and stops when REVALIDATE_UNITS is spent, so its cost is fixed no matter
// how large the pool grows. `videos.list` costs 1 unit per 50 IDs, so the default 500
// units covers 25,000 records per night — a 100k pool comes fully round every ~4 nights.
//
// Shards are immutable, so removals are recorded in tombstones.json rather than edited
// out of the shards.

import { videosMeta, QuotaExceeded, ApiKeyError } from './lib/youtube.mjs'
import {
  readManifest,
  writeManifest,
  readShard,
  readTombstones,
  writeTombstones,
  readBlocklist,
  readState,
  writeState,
  SHARD_SIZE,
} from './lib/pool.mjs'
import { loadKey } from './lib/env.mjs'

/**
 * Records to examine per run, expressed as quota units (1 unit per 50 ids).
 *
 * The sweep used to re-check the WHOLE pool every run, which costs 1 unit per 50 videos
 * and therefore grows without bound: 20% of a day's entire quota at 100k videos, and more
 * than a day's worth past ~500k. A cursor makes the cost constant and the coverage period
 * the thing that grows instead — an explicit dial rather than a cliff.
 *
 * 500 units = 25,000 records per run. Under ~25k videos that is the entire pool every
 * run; at 100k it is full coverage every ~4 runs.
 */
const envNum = (raw, fallback) => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const REVALIDATE_UNITS = envNum(process.env.REVALIDATE_UNITS, 500)
const BATCH = 50

const key = loadKey()
const manifest = readManifest()
const state = readState()
const tombstones = readTombstones()
const known = new Set(tombstones.ids)

// Blocklisted ids are SKIPPED to save quota but deliberately NOT written into
// tombstones. Folding them in made blocklist removal irreversible: `main` restores
// blocklist.json on every deploy, but nothing restores tombstones.json — so deleting an
// id from the blocklist left the video excluded forever via a file no one edits back. It
// also made every description of tombstones.json ("only permanent states") untrue.
//
// The trade: a blocklisted video that is ALSO deleted never gets tombstoned, so
// un-blocklisting it briefly resurrects a dead one. That self-heals — the player's
// onError hides it locally and auto-advances, and the next sweep tombstones it — which is
// a better failure than a removal nobody can undo.
const blocklisted = new Set(readBlocklist().ids ?? [])
const skip = new Set([...known, ...blocklisted])

/**
 * Walk `count` pool positions from `start`, wrapping at the end.
 *
 * Positional rather than filtered: the cursor has to advance past tombstoned and
 * blocklisted records too, or a pool with a dead patch would stall on it forever.
 * Records are append-ordered and shards immutable, so a position is stable.
 */
function* poolSlice(total, start, count) {
  if (total <= 0) return
  let idx = ((start % total) + total) % total // tolerate a negative stored cursor
  let shardIndex = null
  let shard = null
  for (let scanned = 0; scanned < count && scanned < total; scanned++) {
    const si = Math.floor(idx / SHARD_SIZE)
    if (si !== shardIndex) {
      shardIndex = si
      shard = readShard(si)
    }
    const rec = shard[idx % SHARD_SIZE]
    // `offset` is the position count, which advances even where a record is missing.
    if (rec) yield { rec, offset: scanned }
    idx = (idx + 1) % total
  }
}

const start = Number.isInteger(state.sweepCursor) ? state.sweepCursor : 0
const maxRecords = REVALIDATE_UNITS * BATCH
const window = [...poolSlice(manifest.total, start, maxRecords)]
const positionsScanned = Math.min(maxRecords, manifest.total)
const all = window.filter(({ rec }) => !skip.has(rec.id)).map(({ rec }) => rec)
const wrapped = start + window.length >= manifest.total

console.log(
  `sweep window: positions ${start}..${(start + window.length) % Math.max(manifest.total, 1)} ` +
    `of ${manifest.total} (${all.length} to check, ${window.length - all.length} already excluded)`,
)

// A sweep that suddenly declares most of the pool dead is far more likely to be a bad
// API response than reality: videos.list returning HTTP 200 with an empty `items` array
// is neither QuotaExceeded nor ApiKeyError, and would mark every id checked as 'gone'.
// Tombstones are also never re-checked, so a false mass-tombstone is permanent.
const MAX_REMOVAL_RATIO = 0.2
// Deliberate override for a genuinely large cleanup, so a >20% removal cannot wedge the
// sweep forever (every later run would re-check the same records and refuse again).
const ALLOW_MASS_REMOVAL = process.env.ALLOW_MASS_REMOVAL === '1'

// `dead === checked` is refused unconditionally, floor or no floor: a sweep in which
// NOTHING survived is a bad response, not a pool that vanished. The ratio floor alone
// left a 49-record pool wipeable in a single run.
// A flat absolute floor alongside the ratio, so two genuine deletions on a young pool do
// not trip a percentage guard. Deliberately a constant: an earlier version scaled it with
// pool size, which made it unreachable on a partial sweep and switched the guard off
// precisely when a bad response is likeliest. A `checked`-scaled version was then shown
// to be inert — whenever dead/checked exceeds the ratio, dead already exceeds any small
// percentage of checked, so the ratio always decides. A constant says what it does.
const MIN_ABSOLUTE_REMOVALS = 3

const dead = []
let checked = 0
let truncatedBatches = 0
let refusedBatches = 0
try {
  for (let i = 0; i < all.length; i += 50) {
    const batch = all.slice(i, i + 50)
    const meta = await videosMeta(
      key,
      batch.map((r) => r.id),
    )
    const seen = new Map(meta.map((m) => [m.id, m]))

    // An id absent from the response is NOT yet gone. On 2026-10-01, 22 of 219
    // `videos.list` batches came back HTTP 200 with only 1-4 of their 50 items — no
    // error, no quota signal — and the sweep tombstoned the other 1,062 live videos. That
    // run removed 9.7% of the pool, under the whole-run guard below, and tombstones are
    // never re-checked. So an id is written as gone only when two independent responses
    // agree AND nothing in its batch suggests the API was truncating:
    //
    //   - A first response already missing more than the guard ratio is refused outright,
    //     no second call: that shape is what truncation looks like, and whether a retry
    //     happens to recover it says nothing about the ids it would still leave out.
    //   - Otherwise the misses are re-queried in a second call for exactly those ids (one
    //     unit per batch that had any). If that call returns anything the first omitted,
    //     the API flaked on this batch, and the remainder is not trusted either: a genuine
    //     deletion among them simply waits for the next pass. Only misses both calls
    //     agree on are tombstoned.
    //
    // Only `gone` is guarded this way. A private video is an item the API DID return, so
    // mass-private is left to the whole-run guard below.
    const missing = batch.filter((r) => !seen.has(r.id))
    let gone = new Set()
    if (
      !ALLOW_MASS_REMOVAL &&
      missing.length >= MIN_ABSOLUTE_REMOVALS &&
      missing.length / batch.length > MAX_REMOVAL_RATIO
    ) {
      refusedBatches++
      console.error(
        `REFUSING to tombstone ${missing.length} of ${batch.length} ids in one batch ` +
          `(>${MAX_REMOVAL_RATIO * 100}%): that many deletions among ${batch.length} ` +
          `neighbours is far less likely than a truncated response. Nothing was written ` +
          `for this batch; it is re-examined on the next pass. If the cluster really is ` +
          `dead, re-run with ALLOW_MASS_REMOVAL=1 on a night the API is healthy.`,
      )
    } else if (missing.length > 0) {
      const again = await videosMeta(
        key,
        missing.map((r) => r.id),
      )
      for (const m of again) seen.set(m.id, m)
      const still = missing.filter((r) => !seen.has(r.id))
      if (still.length < missing.length) {
        truncatedBatches++
        if (!ALLOW_MASS_REMOVAL && still.length > 0) {
          console.error(
            `deferring ${still.length} miss(es): the second call returned ` +
              `${missing.length - still.length} id(s) the first omitted, so this batch's ` +
              `responses are not trusted tonight`,
          )
          still.length = 0
        }
      }
      gone = new Set(still.map((r) => r.id))
    }

    for (const r of batch) {
      const m = seen.get(r.id)
      // ONLY permanent states are tombstoned, because a tombstone is a deletion: the
      // client applies `excluded` before the safeMode check, so anything in here is gone
      // for every viewer regardless of their toggle.
      //
      // Embeddability and age-restriction are deliberately NOT tombstoned. Both are
      // toggle-GOVERNED filters — docs/DESIGN.md §5.2 promises the opt-out lifts both —
      // so tombstoning them would silently convert a filter the viewer can turn off into
      // a deletion they cannot. The client already applies both from the harvest-time
      // flags, and a non-embeddable video that slips through fails in the player and
      // auto-advances.
      if (!m) {
        if (gone.has(r.id)) dead.push({ id: r.id, why: 'gone' })
      } else if (m.privacyStatus !== 'public')
        dead.push({ id: r.id, why: 'not-public' })
    }
    checked += batch.length
  }
} catch (err) {
  if (err instanceof ApiKeyError) {
    console.error(`FATAL: ${err.message}`)
    process.exit(1)
  }
  if (!(err instanceof QuotaExceeded)) throw err
  console.log('quota exhausted mid-sweep; recording what was checked')
}

const wipedEverything = checked > 0 && dead.length === checked
const refusedWindow =
  !ALLOW_MASS_REMOVAL &&
  (wipedEverything ||
    (dead.length >= MIN_ABSOLUTE_REMOVALS &&
      dead.length / checked > MAX_REMOVAL_RATIO))

if (refusedWindow) {
  // Discard this window's findings but KEEP MOVING. Exiting here left the cursor
  // unadvanced, so the identical window was retried every night forever — burning the
  // budget, never re-validating anything else, and (under continue-on-error in CI)
  // reporting success while doing so. The suspicious window is simply re-examined on the
  // next full pass; meanwhile the client's onError still hides any dead video it serves.
  console.error(
    `REFUSING to tombstone ${dead.length} of ${checked} checked videos ` +
      `(>${MAX_REMOVAL_RATIO * 100}%). That is far more likely to be a bad API response ` +
      `than reality, and tombstones are never re-checked, so nothing was written for this ` +
      `window. The cursor still advances, so the rest of the pool keeps being swept. ` +
      `If this really is a legitimate cleanup, re-run with ALLOW_MASS_REMOVAL=1.`,
  )
  dead.length = 0
}
// Either kind of refusal is surfaced the same way: a refused batch is not a crash, but
// it must not be quiet either.
const refused = refusedWindow || refusedBatches > 0

// Advance only past what was actually CHECKED. A run cut short by quota must not skip the
// records it never reached — that would leave permanent holes in coverage, which is the
// failure the cursor exists to avoid. Counted in POSITIONS, so a missing record cannot
// desync the cursor from the walk.
let consumed = positionsScanned
if (checked < all.length) {
  let seen = 0
  for (const { rec, offset } of window) {
    if (skip.has(rec.id)) continue
    seen++
    if (seen >= checked) {
      consumed = offset + 1
      break
    }
  }
  if (checked === 0) consumed = 0
}

// Tombstones first, then the cursor. The reverse order loses findings on a crash between
// the two writes: the cursor would say a window was swept while its results were never
// recorded.
for (const d of dead) known.add(d.id)
writeTombstones({
  ids: [...known],
  note: tombstones.note,
  updatedAt: new Date().toISOString(),
})

state.sweepCursor = manifest.total > 0 ? (start + consumed) % manifest.total : 0
if (manifest.total > 0 && wrapped && checked >= all.length) {
  state.sweeps = (state.sweeps ?? 0) + 1
}
writeState(state)

const byReason = dead.reduce(
  (acc, d) => ({ ...acc, [d.why]: (acc[d.why] ?? 0) + 1 }),
  {},
)
manifest.stats = {
  ...manifest.stats,
  lastSweep: {
    at: new Date().toISOString(),
    checked,
    removed: dead.length,
    byReason,
    // Surfaced so CI can alarm on it: a refusal is not a crash, but it must not be quiet.
    refused,
    // How often a response was missing ids that a second call then returned, and how
    // often a batch was refused outright. One of either is routine; a run of them means
    // videos.list is flaking.
    truncatedBatches,
    refusedBatches,
  },
  tombstoned: known.size,
  sweepCursor: state.sweepCursor,
  sweepsCompleted: state.sweeps ?? 0,
}
writeManifest(manifest)

console.log(`checked ${checked}, removed ${dead.length}`, byReason)
console.log(
  `pool: ${manifest.total} harvested, ` +
    `${manifest.total - new Set([...known, ...blocklisted]).size} still served`,
)
console.log(
  `cursor: ${start} -> ${state.sweepCursor}` +
    (manifest.total > 0
      ? ` (${Math.ceil(manifest.total / Math.max(positionsScanned, 1))} run(s) per full pass)`
      : ''),
)
if (refused) console.log('sweep-refused: see the REFUSING line above')
