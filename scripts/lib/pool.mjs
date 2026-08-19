// Pool storage: immutable, fixed-size, append-only shards.
//
// docs/DESIGN.md §4.1. The shape is chosen to kill three problems at once:
//
//   - Rewriting shards nightly grows git history quadratically (~4 GB packed at one
//     year). Append-only keeps it linear.
//   - Fixed SHARD_SIZE means the client computes `shard = floor(i/K), idx = i%K`.
//     No cumulative-offset array, no binary search, no linearly-growing manifest —
//     the subtlest bug in revision 1 is deleted rather than tested.
//   - Records are appended in harvest order, which keeps every shard but the tail
//     immutable.
//
// `servable` is a leftover from an earlier design in which the safety quarantine was a
// leading prefix of the pool. The quarantine is now an upload-age filter applied at
// HARVEST time (nothing under 30 days old is ever added), so `servable === total` and the
// client draws over the whole pool. Keep it that way: the client indexes shard POSITIONS
// with an index drawn from [0, servable), so any future design that makes servable < total
// must also guarantee the non-servable records are a contiguous suffix, or the tail of the
// pool silently becomes undrawable.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHARD_SIZE = 1000
// Overridable so the integrity guards can be exercised against fixtures in tests.
export const POOL_DIR = process.env.POOL_DIR
  ? resolve(process.env.POOL_DIR)
  : join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'public',
      'data',
      'pool',
    )

const MANIFEST = join(POOL_DIR, 'manifest.json')
const STATE = join(POOL_DIR, 'state.json')
const TOMBSTONES = join(POOL_DIR, 'tombstones.json')
const BLOCKLIST = join(POOL_DIR, 'blocklist.json')

const readJson = (p, fallback) =>
  existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)
}

export const shardPath = (n) =>
  join(POOL_DIR, `shard-${String(n).padStart(5, '0')}.json`)

export const readManifest = () =>
  readJson(MANIFEST, {
    version: 1,
    shardSize: SHARD_SIZE,
    total: 0,
    servable: 0,
    generatedAt: null,
    health: { status: 'never-run', lastRunUtc: null, buckets: 0, yield: null },
    stats: {},
  })

export const writeManifest = (m) => writeJson(MANIFEST, m)

/** Harvester state: the without-replacement counter and the re-harvest cursor. */
export const readState = () =>
  readJson(STATE, {
    counter: 0,
    reharvestCursor: 0,
    sweeps: 0,
    totalBuckets: 0,
  })
export const writeState = (s) => writeJson(STATE, s)

export const readTombstones = () => readJson(TOMBSTONES, { ids: [] })
export const writeTombstones = (t) => writeJson(TOMBSTONES, t)
export const readBlocklist = () => readJson(BLOCKLIST, { ids: [] })

export const readShard = (n) => readJson(shardPath(n), [])

/** Every ID currently in the pool — used to keep appends unique. */
export function readAllIds() {
  const ids = new Set()
  if (!existsSync(POOL_DIR)) return ids
  for (const f of readdirSync(POOL_DIR)) {
    if (!/^shard-\d+\.json$/.test(f)) continue
    for (const r of JSON.parse(readFileSync(join(POOL_DIR, f), 'utf8')))
      ids.add(r.id)
  }
  return ids
}

/**
 * Append records, filling the partial tail shard first. Only the tail shard is ever
 * rewritten; every full shard is immutable once written.
 * Returns the new total.
 */
export function appendRecords(records, total) {
  let written = total
  let queue = [...records]
  while (queue.length > 0) {
    const shardIndex = Math.floor(written / SHARD_SIZE)
    const offset = written % SHARD_SIZE
    const room = SHARD_SIZE - offset
    const batch = queue.slice(0, room)
    queue = queue.slice(room)
    // offset === 0 means "start a new shard". If a shard file is already there, the
    // manifest disagrees with the data on disk (a lost or truncated manifest reports
    // total 0), and writing would clobber up to SHARD_SIZE immutable records.
    if (offset === 0 && existsSync(shardPath(shardIndex))) {
      throw new Error(
        `shard ${shardIndex} already exists but the manifest implies an empty pool — refusing to overwrite`,
      )
    }
    const existing = offset === 0 ? [] : readShard(shardIndex)
    if (existing.length !== offset) {
      throw new Error(
        `shard ${shardIndex} has ${existing.length} records but manifest implies ${offset} — refusing to write`,
      )
    }
    writeJson(shardPath(shardIndex), [...existing, ...batch])
    written += batch.length
  }
  return written
}
