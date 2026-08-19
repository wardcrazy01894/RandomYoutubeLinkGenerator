#!/usr/bin/env node
// Weekly re-validation sweep. docs/DESIGN.md §5.3.
//
// This is the pool's primary SAFETY mechanism, not just staleness hygiene: videos that
// YouTube has removed, made private, or age-restricted since we harvested them stop
// being served. `videos.list` costs 1 unit per 50 IDs, so sweeping the whole pool is
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

// Blocklisted videos are filtered client-side at draw time, but the sweep never knew
// about them — so pool statistics counted removed videos as live, and the docs claiming
// the blocklist was "honoured by the sweep" were unbacked. Fold them into tombstones,
// which is effectively what they are, and skip spending quota re-checking them.
const blocklisted = readBlocklist().ids ?? []
let newlyBlocked = 0
for (const id of blocklisted) {
  if (!known.has(id)) {
    known.add(id)
    newlyBlocked++
  }
}
if (newlyBlocked > 0) {
  console.log(`folded ${newlyBlocked} blocklisted ids into tombstones`)
}

const shards = Math.ceil(manifest.total / SHARD_SIZE)
const all = []
for (let i = 0; i < shards; i++) {
  for (const r of readShard(i)) if (!known.has(r.id)) all.push(r)
}
console.log(
  `revalidating ${all.length} live records (${known.size} already tombstoned)`,
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
// A minimum sample before the ratio means anything: on an early pool of a dozen records,
// two genuine deletions are 17% and would trip a percentage guard for no reason.
const MIN_SAMPLE_FOR_RATIO = 50
if (
  checked >= MIN_SAMPLE_FOR_RATIO &&
  dead.length / checked > MAX_REMOVAL_RATIO
) {
  console.error(
    `REFUSING: this sweep would tombstone ${dead.length} of ${checked} checked videos ` +
      `(>${MAX_REMOVAL_RATIO * 100}%). That is far more likely to be a bad API response ` +
      `than reality, and tombstones are never re-checked. Nothing was written.`,
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
  `pool: ${manifest.total} harvested, ${manifest.total - known.size} still live`,
)
