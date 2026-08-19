#!/usr/bin/env node
// Weekly re-validation sweep. docs/DESIGN.md §5.3.
//
// This is the pool's primary SAFETY mechanism, not just staleness hygiene: videos that
// YouTube has removed or made private since we harvested them stop being served.
// Age-restriction and embeddability are deliberately NOT swept — they are governed by the
// safe-mode toggle, and tombstoning them would convert a filter the viewer can lift into
// a removal they cannot. See the dead-detection block below. `videos.list` costs 1 unit per 50 IDs, so sweeping the whole pool is
// nearly free — a 100k pool costs 2,000 of 10,000 daily units.
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
  SHARD_SIZE,
} from './lib/pool.mjs'
import { loadKey } from './lib/env.mjs'

const key = loadKey()
const manifest = readManifest()
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

const shards = Math.ceil(manifest.total / SHARD_SIZE)
const all = []
for (let i = 0; i < shards; i++) {
  for (const r of readShard(i)) if (!skip.has(r.id)) all.push(r)
}
console.log(
  `revalidating ${all.length} live records (${known.size} tombstoned, ` +
    `${blocklisted.size} blocklisted)`,
)

const dead = []
let checked = 0
try {
  for (let i = 0; i < all.length; i += 50) {
    const batch = all.slice(i, i + 50)
    const meta = await videosMeta(
      key,
      batch.map((r) => r.id),
    )
    const seen = new Map(meta.map((m) => [m.id, m]))
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
      if (!m) dead.push({ id: r.id, why: 'gone' })
      else if (m.privacyStatus !== 'public')
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

// A sweep that suddenly declares most of the pool dead is far more likely to be a bad
// API response than reality: videos.list returning HTTP 200 with an empty `items` array
// is neither QuotaExceeded nor ApiKeyError, and would mark every id checked as 'gone'.
// Tombstones are also never re-checked, so a false mass-tombstone is permanent.
const MAX_REMOVAL_RATIO = 0.2
// Deliberate override for a genuinely large cleanup, so a >20% removal cannot wedge the
// sweep forever (every later run would re-check the same records and refuse again).
const ALLOW_MASS_REMOVAL = process.env.ALLOW_MASS_REMOVAL === '1'
// An absolute floor alongside the ratio, so two genuine deletions on an early pool do
// not trip a percentage guard. It scales with the pool: a fixed floor of 10 let 9 dead
// out of 10 checked (90%) through, and a small pool is exactly where one bad response
// wipes everything.
const MIN_ABSOLUTE_REMOVALS = Math.max(3, Math.ceil(manifest.total * 0.05))
// `dead === checked` is refused unconditionally, floor or no floor: a sweep in which
// NOTHING survived is a bad response, not a pool that vanished. The ratio floor alone
// left a 49-record pool wipeable in a single run.
const wipedEverything = checked > 0 && dead.length === checked
if (
  !ALLOW_MASS_REMOVAL &&
  (wipedEverything ||
    (dead.length >= MIN_ABSOLUTE_REMOVALS &&
      dead.length / checked > MAX_REMOVAL_RATIO))
) {
  console.error(
    `REFUSING: this sweep would tombstone ${dead.length} of ${checked} checked videos ` +
      `(>${MAX_REMOVAL_RATIO * 100}%). That is far more likely to be a bad API response ` +
      `than reality, and tombstones are never re-checked. Nothing was written. ` +
      `If this really is a legitimate cleanup, re-run with ALLOW_MASS_REMOVAL=1.`,
  )
  process.exit(1)
}

for (const d of dead) known.add(d.id)
writeTombstones({
  ids: [...known],
  note: tombstones.note,
  updatedAt: new Date().toISOString(),
})

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
  },
  tombstoned: known.size,
}
writeManifest(manifest)

console.log(`checked ${checked}, removed ${dead.length}`, byReason)
console.log(
  `pool: ${manifest.total} harvested, ` +
    `${manifest.total - known.size - blocklisted.size} still served`,
)
