import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  drawRandom,
  poolAgeDays,
  clearShardCache,
  EmptyPoolError,
  type Manifest,
  type PoolRecord,
} from '../src/pool'

const rec = (id: string, over: Partial<PoolRecord> = {}): PoolRecord => ({
  id,
  t: `title ${id}`,
  pub: '2020-01-01T00:00:00Z',
  v: 10,
  dur: 'PT1M',
  emb: true,
  age: false,
  mfk: false,
  h: '2026-01-01T00:00:00Z',
  ...over,
})

const manifest = (total: number, servable = total): Manifest => ({
  version: 1,
  shardSize: 10,
  total,
  servable,
  generatedAt: '2026-08-19T00:00:00Z',
  health: { status: 'ok', lastRunUtc: null, buckets: 0, yield: null },
  stats: {},
})

/** Serves shards of 10 records: shard s holds ids `s-0` .. `s-9`. */
function mockShards(overrides: Record<string, Partial<PoolRecord>> = {}) {
  vi.stubGlobal('fetch', async (url: string) => {
    const m = /shard-(\d+)\.json$/.exec(String(url))
    if (!m) return { ok: false, status: 404 }
    const s = Number(m[1])
    const records = Array.from({ length: 10 }, (_, i) => {
      const id = `${s}-${i}`
      return rec(id, overrides[id] ?? {})
    })
    return { ok: true, status: 200, json: async () => records }
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  clearShardCache()
})

describe('drawRandom', () => {
  it('throws when the pool has nothing servable', async () => {
    mockShards()
    await expect(
      drawRandom(manifest(100, 0), { safeMode: true, excluded: new Set() }),
    ).rejects.toBeInstanceOf(EmptyPoolError)
  })

  it('only ever draws from the servable prefix, never beyond it', async () => {
    mockShards()
    // 50 records exist but only the first 10 are servable.
    for (let i = 0; i < 200; i++) {
      const r = await drawRandom(manifest(50, 10), {
        safeMode: true,
        excluded: new Set(),
      })
      expect(r.id.startsWith('0-')).toBe(true)
    }
  })

  // Assert the invariant (an excluded id is never returned) rather than "the single
  // survivor comes back" — the latter needs a rare hit and makes CI randomly red.
  it('never returns an excluded id', async () => {
    mockShards()
    const excluded = new Set(['0-0', '0-1', '0-2', '0-3', '0-4'])
    for (let i = 0; i < 200; i++) {
      const r = await drawRandom(manifest(10, 10), { safeMode: true, excluded })
      expect(excluded.has(r.id)).toBe(false)
    }
  })

  it('never returns an age-restricted or non-embeddable video in safe mode', async () => {
    mockShards({
      '0-0': { age: true },
      '0-1': { age: true },
      '0-2': { emb: false },
      '0-3': { emb: false },
      '0-4': { age: true, emb: false },
    })
    for (let i = 0; i < 200; i++) {
      const r = await drawRandom(manifest(10, 10), {
        safeMode: true,
        excluded: new Set(),
      })
      expect(r.age).toBe(false)
      expect(r.emb).toBe(true)
    }
  })

  it('serves age-restricted videos when safe mode is off', async () => {
    mockShards({ '0-0': { age: true } })
    const ids = new Set<string>()
    for (let i = 0; i < 300; i++) {
      ids.add(
        (
          await drawRandom(manifest(10, 10), {
            safeMode: false,
            excluded: new Set(),
          })
        ).id,
      )
    }
    expect(ids.has('0-0')).toBe(true)
  })

  it('gives up rather than looping forever when everything is filtered out', async () => {
    mockShards()
    const excluded = new Set(Array.from({ length: 10 }, (_, i) => `0-${i}`))
    await expect(
      drawRandom(manifest(10, 10), { safeMode: true, excluded }),
    ).rejects.toBeInstanceOf(EmptyPoolError)
  })

  // Rejection must redraw, not advance to i+1 — advancing would hand an excluded
  // video's probability mass to its neighbour (docs/DESIGN.md §4.1).
  it('spreads draws evenly rather than piling onto an excluded video’s neighbour', async () => {
    mockShards()
    const counts = new Map<string, number>()
    const excluded = new Set(['0-5'])
    for (let i = 0; i < 4000; i++) {
      const r = await drawRandom(manifest(10, 10), { safeMode: true, excluded })
      counts.set(r.id, (counts.get(r.id) ?? 0) + 1)
    }
    expect(counts.get('0-5')).toBeUndefined()
    // If exclusion advanced to i+1, '0-6' would receive roughly double everyone else.
    const six = counts.get('0-6')!
    const four = counts.get('0-4')!
    expect(six / four).toBeGreaterThan(0.7)
    expect(six / four).toBeLessThan(1.4)
  })
})

describe('toggle-governed filters are filters, not deletions', () => {
  // The direction that regressed: tombstoning age-restricted videos excluded them even
  // with safe mode OFF, silently converting a filter the viewer can lift into a removal
  // they cannot. The sweep now tombstones only permanent states; these pin the contract
  // the sweep must not violate.
  it('draws an age-restricted video when safe mode is off', async () => {
    mockShards({ '0-0': { age: true } })
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) {
      seen.add(
        (
          await drawRandom(manifest(10, 10), {
            safeMode: false,
            excluded: new Set(),
          })
        ).id,
      )
    }
    expect(
      seen.has('0-0'),
      'age-restricted must be reachable with the toggle off',
    ).toBe(true)
  })

  it('draws a non-embeddable video when safe mode is off', async () => {
    mockShards({ '0-0': { emb: false } })
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) {
      seen.add(
        (
          await drawRandom(manifest(10, 10), {
            safeMode: false,
            excluded: new Set(),
          })
        ).id,
      )
    }
    expect(
      seen.has('0-0'),
      'non-embeddable must be reachable with the toggle off',
    ).toBe(true)
  })

  it('excludes a tombstoned video under BOTH toggle states', async () => {
    mockShards({ '0-0': { age: true } })
    for (const safeMode of [true, false]) {
      for (let i = 0; i < 100; i++) {
        const r = await drawRandom(manifest(10, 10), {
          safeMode,
          excluded: new Set(['0-0']),
        })
        expect(r.id).not.toBe('0-0')
      }
    }
  })
})

describe('tombstones', () => {
  // The re-validation sweep writes tombstones.json, and it was deployed but never fetched — so
  // videos YouTube had removed kept being drawn while three comments claimed the client
  // filtered them. These pin that the exclusion set is honoured however it is composed.
  it('never draws a tombstoned id', async () => {
    mockShards()
    const excluded = new Set(['0-0', '0-1', '0-2', '0-3', '0-4'])
    for (let i = 0; i < 200; i++) {
      const r = await drawRandom(manifest(10, 10), { safeMode: true, excluded })
      expect(excluded.has(r.id)).toBe(false)
    }
  })

  it('applies exclusions even with safe mode off', async () => {
    mockShards()
    const excluded = new Set(['0-0', '0-1', '0-2', '0-3', '0-4'])
    for (let i = 0; i < 200; i++) {
      const r = await drawRandom(manifest(10, 10), {
        safeMode: false,
        excluded,
      })
      expect(excluded.has(r.id)).toBe(false)
    }
  })
})

describe('poolAgeDays', () => {
  it('returns null when the pool has never been generated', () => {
    expect(poolAgeDays({ ...manifest(0), generatedAt: null })).toBeNull()
  })
  it('counts whole days since the last harvest', () => {
    expect(poolAgeDays(manifest(10), Date.parse('2026-08-22T00:00:00Z'))).toBe(
      3,
    )
  })
})
