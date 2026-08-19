// Client-side pool access and uniform draw.
//
// Shards are fixed-size and immutable (docs/DESIGN.md §4.1), so locating record `i`
// is arithmetic — `shard = floor(i/K)`, `idx = i%K` — and only that one shard is
// fetched. No cumulative-offset table, no binary search, and a manifest that stays
// ~100 bytes however large the pool grows.

import { randomBelow } from './random'

export interface PoolRecord {
  id: string
  t: string
  pub: string | null
  v: number
  dur: string | null
  emb: boolean
  age: boolean
  mfk: boolean
  h: string
}

export interface Manifest {
  version: number
  shardSize: number
  total: number
  /** Leading records that have cleared the safety quarantine. Only these are served. */
  servable: number
  generatedAt: string | null
  health: {
    status: string
    lastRunUtc: string | null
    buckets: number
    /** New videos per FRESH bucket. Re-harvest buckets are excluded deliberately. */
    yield: number | null
    /** Overall yield across fresh AND re-harvest buckets — diagnosis only. */
    yieldAll?: number
    /** Threshold the yield gate compares against. Only healthy, untruncated runs move it. */
    baselineYield?: number | null
    /** Run shape: distinguishes a complete run from one that abandoned its fresh plan. */
    freshPlanned?: number
    freshAttempted?: number
    reharvestAttempted?: number
    truncated?: boolean
  }
  stats: Record<string, unknown>
}

export interface DrawOptions {
  /** Exclude age-restricted / non-embeddable videos. Default frame; see §5.2. */
  safeMode: boolean
  /** Locally-known-dead IDs (failed playback) plus the published blocklist. */
  excluded: ReadonlySet<string>
}

const base = `${import.meta.env.BASE_URL}data/pool`
const shardCache = new Map<number, PoolRecord[]>()

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${base}/manifest.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`manifest unavailable (${res.status})`)
  return res.json()
}

/**
 * IDs the weekly sweep found gone or made private.
 *
 * This was written by `scripts/revalidate.mjs` and deployed, but never fetched — so the
 * sweep that docs/DESIGN.md §5.3 calls the primary safety mechanism produced output no
 * viewer ever saw, and videos YouTube had already removed kept being served.
 */
export async function loadTombstones(): Promise<string[]> {
  try {
    const res = await fetch(`${base}/tombstones.json`, { cache: 'no-cache' })
    if (!res.ok) return []
    const ids = (await res.json())?.ids
    // Shape-checked: a malformed `ids` (a string, say) would otherwise spread into the
    // exclusion Set one character at a time.
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

export async function loadBlocklist(): Promise<string[]> {
  try {
    const res = await fetch(`${base}/blocklist.json`, { cache: 'no-cache' })
    if (!res.ok) return []
    return (await res.json()).ids ?? []
  } catch {
    return []
  }
}

/** Drop cached shards. Exposed for tests and for a manifest refresh. */
export function clearShardCache(): void {
  shardCache.clear()
}

async function loadShard(
  manifest: Manifest,
  index: number,
): Promise<PoolRecord[]> {
  const cached = shardCache.get(index)
  if (cached) return cached
  const name = `shard-${String(index).padStart(5, '0')}.json`
  const res = await fetch(`${base}/${name}`)
  if (!res.ok) throw new Error(`shard ${index} unavailable (${res.status})`)
  const records: PoolRecord[] = await res.json()
  // Only FULL shards are immutable. The tail shard is rewritten by every harvest, so
  // caching it would pin stale data for the lifetime of the page.
  if (records.length === manifest.shardSize) shardCache.set(index, records)
  return records
}

export class EmptyPoolError extends Error {}

/**
 * One uniform draw from the servable pool.
 *
 * Excluded records are rejected and REDRAWN, never skipped to `i+1` — advancing to a
 * neighbour would hand the excluded video's probability mass to whoever follows it,
 * which is a real (if small) bias.
 */
export async function drawRandom(
  manifest: Manifest,
  options: DrawOptions,
  maxAttempts = 40,
): Promise<PoolRecord> {
  if (manifest.servable <= 0) {
    throw new EmptyPoolError('the pool has no videos cleared for serving yet')
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const i = randomBelow(manifest.servable)
    const shard = await loadShard(manifest, Math.floor(i / manifest.shardSize))
    const record = shard[i % manifest.shardSize]
    if (!record) continue
    if (options.excluded.has(record.id)) continue
    if (options.safeMode && (record.age || !record.emb)) continue
    return record
  }
  throw new EmptyPoolError(
    `no playable video found in ${maxAttempts} draws — the filters may be excluding almost everything`,
  )
}

/** Days since the pool was last updated, for the staleness banner. */
export function poolAgeDays(
  manifest: Manifest,
  now = Date.now(),
): number | null {
  if (!manifest.generatedAt) return null
  return Math.floor(
    (now - new Date(manifest.generatedAt).getTime()) / 86400_000,
  )
}
