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
      // Absent from the response => deleted or made private. Otherwise re-check the
      // serving preconditions, which can change after upload.
      if (!m) dead.push({ id: r.id, why: 'gone' })
      else if (m.privacyStatus !== 'public')
        dead.push({ id: r.id, why: 'not-public' })
      else if (!m.embeddable) dead.push({ id: r.id, why: 'not-embeddable' })
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
