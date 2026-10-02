import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  cpSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// scripts/revalidate.mjs had no tests at all, which is how a regression to its wipe guard
// shipped: a floor scaled by pool size became unreachable on a partial sweep, silently
// disarming the guard exactly when a bad API response is likeliest. Its failure mode is
// permanent — tombstones are never re-checked — so it earns direct coverage.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let dir, pool

/** Deterministic stand-in for lib/youtube.mjs. STUB_DEAD lists ids to report missing. */
const STUB = `
export const COST = { search: 100, videos: 1 }
export class QuotaExceeded extends Error {}
export class ApiKeyError extends Error {}
export const sleep = () => Promise.resolve()
export async function searchPage() {
  return { ids: [], nextPageToken: null, totalResults: 0 }
}
const dead = new Set((process.env.STUB_DEAD ?? '').split(',').filter(Boolean))
const priv = new Set((process.env.STUB_PRIVATE ?? '').split(',').filter(Boolean))
const age = new Set((process.env.STUB_AGE ?? '').split(',').filter(Boolean))
const noembed = new Set((process.env.STUB_NOEMBED ?? '').split(',').filter(Boolean))
const quotaAfter = Number(process.env.STUB_QUOTA_AFTER ?? 0)
// STUB_TRUNCATE lists 0-based call indices whose response is cut short: HTTP 200, no
// error, the rest silently absent — what videos.list did on 2026-10-01. "0" keeps the
// first two items of call 0; "0:45" keeps the first 45.
const truncate = new Map(
  (process.env.STUB_TRUNCATE ?? '')
    .split(',')
    .filter(Boolean)
    .map((spec) => {
      const [call, keep] = spec.split(':')
      return [Number(call), keep === undefined ? 2 : Number(keep)]
    }),
)
let seen = 0
let calls = 0
export async function videosMeta(key, ids) {
  if (quotaAfter && seen >= quotaAfter) throw new QuotaExceeded('stub quota')
  seen += ids.length
  const call = calls++
  // Absent from the response == deleted, which is what the real API does.
  const items = ids.filter((i) => !dead.has(i)).map((i) => ({
    id: i,
    privacyStatus: priv.has(i) ? 'private' : 'public',
    embeddable: !noembed.has(i),
    ageRestricted: age.has(i),
  }))
  return truncate.has(call) ? items.slice(0, truncate.get(call)) : items
}
`

const id = (i) => `vid${String(i).padStart(8, '0')}`
const rec = (i) => ({
  id: id(i),
  t: 't',
  pub: '2020-01-01T00:00:00Z',
  v: 1,
  dur: 'PT1M',
  emb: true,
  age: false,
  mfk: false,
  h: '2026-01-01T00:00:00Z',
})

function seed(total, { tombstones = [], blocklist = [], cursor = 0 } = {}) {
  mkdirSync(pool, { recursive: true })
  const records = Array.from({ length: total }, (_, i) => rec(i))
  for (let s = 0; s * 1000 < Math.max(total, 1); s++) {
    writeFileSync(
      join(pool, `shard-${String(s).padStart(5, '0')}.json`),
      JSON.stringify(records.slice(s * 1000, (s + 1) * 1000)),
    )
  }
  writeFileSync(
    join(pool, 'manifest.json'),
    JSON.stringify({
      version: 1,
      shardSize: 1000,
      total,
      servable: total,
      generatedAt: null,
      health: {},
      stats: {},
    }),
  )
  writeFileSync(
    join(pool, 'state.json'),
    JSON.stringify({
      counter: 0,
      reharvestCursor: 0,
      sweeps: 0,
      totalBuckets: 0,
      sweepCursor: cursor,
    }),
  )
  writeFileSync(
    join(pool, 'tombstones.json'),
    JSON.stringify({ ids: tombstones }),
  )
  writeFileSync(
    join(pool, 'blocklist.json'),
    JSON.stringify({ ids: blocklist }),
  )
}

function run(env = {}) {
  const res = spawnSync('node', [join(dir, 'revalidate.mjs')], {
    env: { ...process.env, YOUTUBE_API_KEY: 'stub', POOL_DIR: pool, ...env },
    encoding: 'utf8',
  })
  return {
    code: res.status ?? 1,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  }
}

const state = () => JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'))
const tombs = () =>
  JSON.parse(readFileSync(join(pool, 'tombstones.json'), 'utf8')).ids

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reval-'))
  cpSync(join(ROOT, 'scripts'), dir, { recursive: true })
  writeFileSync(join(dir, 'lib', 'youtube.mjs'), STUB)
  pool = join(dir, 'pool')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('incremental cursor', () => {
  it('advances by the window and wraps around the pool', () => {
    seed(250)
    expect(run({ REVALIDATE_UNITS: '2' }).code).toBe(0) // 2 units = 100 records
    expect(state().sweepCursor).toBe(100)
    run({ REVALIDATE_UNITS: '2' })
    expect(state().sweepCursor).toBe(200)
    run({ REVALIDATE_UNITS: '2' })
    expect(state().sweepCursor, 'must wrap, not run off the end').toBe(50)
  })

  it('counts a completed pass only when the whole pool has been walked', () => {
    seed(250)
    for (let i = 0; i < 2; i++) run({ REVALIDATE_UNITS: '2' })
    expect(state().sweeps).toBe(0)
    run({ REVALIDATE_UNITS: '2' })
    expect(state().sweeps).toBe(1)
  })

  it('covers the entire pool in one run when the budget allows', () => {
    seed(120)
    run({ REVALIDATE_UNITS: '500' })
    expect(state().sweepCursor).toBe(0) // wrapped exactly
    expect(state().sweeps).toBe(1)
  })

  // A run cut short must not skip what it never reached — that leaves permanent holes,
  // which is the failure the cursor exists to prevent.
  it('advances only past records it actually checked when quota runs out', () => {
    seed(250)
    run({ REVALIDATE_UNITS: '5', STUB_QUOTA_AFTER: '100' })
    // EXACT, not a range: a loose bound let an off-by-one survive that skipped one
    // record on every truncated run — a permanent coverage hole.
    expect(
      state().sweepCursor,
      'must resume exactly after the last checked record',
    ).toBe(100)
  })

  // Truncation AND interleaved skips together: the arithmetic has to count positions,
  // not checked records, or the resume point drifts.
  it('resumes exactly after the last checked record when skips are interleaved', () => {
    seed(400, { tombstones: [id(0), id(1), id(2), id(50), id(51)] })
    run({ REVALIDATE_UNITS: '5', STUB_QUOTA_AFTER: '60' })
    // Quota is spent per 50-id batch, so two batches complete: 100 records checked,
    // plus the 5 skipped positions among them = position 105.
    expect(state().sweepCursor).toBe(105)
  })

  it('steps over already-excluded records rather than stalling on them', () => {
    // A dead patch at the head: the cursor must advance past it, not re-examine it.
    seed(250, { tombstones: Array.from({ length: 60 }, (_, i) => id(i)) })
    run({ REVALIDATE_UNITS: '2' })
    expect(state().sweepCursor).toBe(100)
  })
})

describe('mass-removal guard', () => {
  it('refuses when a run would remove more than the ratio allows', () => {
    seed(200)
    const r = run({
      STUB_DEAD: Array.from({ length: 80 }, (_, i) => id(i)).join(','),
    })
    expect(r.out).toMatch(/REFUSING/)
    expect(tombs(), 'nothing may be written when the guard fires').toEqual([])
  })

  it('refuses when nothing at all survived, whatever the count', () => {
    seed(5)
    const r = run({
      STUB_DEAD: Array.from({ length: 5 }, (_, i) => id(i)).join(','),
    })
    expect(r.out).toMatch(/REFUSING/)
    expect(tombs()).toEqual([])
  })

  // The guard used to exit(1) BEFORE advancing the cursor, so the identical window was
  // retried every night forever — budget burned, nothing else re-validated, and under
  // continue-on-error the job reported success while doing it.
  it('keeps sweeping after a refusal instead of retrying the same window forever', () => {
    seed(200)
    const r = run({
      STUB_DEAD: Array.from({ length: 80 }, (_, i) => id(i)).join(','),
      REVALIDATE_UNITS: '1',
    })
    expect(r.code, 'a refusal must not fail the run that contains it').toBe(0)
    expect(
      state().sweepCursor,
      'the cursor must advance past a refused window',
    ).toBe(50)
  })

  it('flags a refusal in the manifest so CI can alarm on it', () => {
    seed(200)
    run({ STUB_DEAD: Array.from({ length: 80 }, (_, i) => id(i)).join(',') })
    const m = JSON.parse(readFileSync(join(pool, 'manifest.json'), 'utf8'))
    expect(m.stats.lastSweep.refused, 'a refusal must not be silent').toBe(true)
  })

  it('does not flag a healthy sweep as refused', () => {
    seed(200)
    run({ STUB_DEAD: id(0) })
    const m = JSON.parse(readFileSync(join(pool, 'manifest.json'), 'utf8'))
    expect(m.stats.lastSweep.refused).toBe(false)
  })

  // The ratio alone would refuse this: 2/9 is 22%, over the 20% cap. The flat floor is
  // what lets a young pool lose two genuinely-deleted videos. Dropping the floor left
  // the whole suite green, so this case is the only thing holding it in place.
  it('lets a tiny pool lose a couple of videos the ratio alone would refuse', () => {
    seed(9)
    const r = run({ STUB_DEAD: [id(0), id(1)].join(',') })
    expect(
      r.out,
      'below the absolute floor, so the ratio must not decide',
    ).not.toMatch(/REFUSING/)
    expect(tombs().sort()).toEqual([id(0), id(1)].sort())
  })

  it('allows a small genuine cleanup', () => {
    seed(200)
    const r = run({ STUB_DEAD: [id(0), id(1)].join(',') })
    expect(r.code, r.out).toBe(0)
    expect(tombs().sort()).toEqual([id(0), id(1)].sort())
  })

  it('lets a deliberate override through', () => {
    seed(200)
    const dead = Array.from({ length: 80 }, (_, i) => id(i))
    const r = run({ STUB_DEAD: dead.join(','), ALLOW_MASS_REMOVAL: '1' })
    expect(r.code, r.out).toBe(0)
    expect(tombs()).toHaveLength(80)
  })
})

// 2026-10-01: 22 of 219 videos.list batches returned HTTP 200 with 1-4 of 50 items and
// 1,062 live videos were tombstoned — 9.7% of the pool, under the whole-run guard. The
// stub's call order is: batch 0, its confirmation (only if a small number was missing),
// batch 1, ...
describe('truncated API responses', () => {
  const manifest = () =>
    JSON.parse(readFileSync(join(pool, 'manifest.json'), 'utf8'))

  it('refuses a batch whose first response lost most of it, without a second call', () => {
    seed(100)
    const r = run({ STUB_TRUNCATE: '0' })
    expect(r.code, 'a refused batch must not fail the run').toBe(0)
    expect(r.out).toMatch(/REFUSING/)
    expect(tombs()).toEqual([])
    expect(manifest().stats.lastSweep.refusedBatches).toBe(1)
    expect(manifest().stats.lastSweep.truncatedBatches).toBe(0)
    expect(manifest().stats.lastSweep.refused, 'must not be silent').toBe(true)
    expect(state().sweepCursor, 'the cursor must still advance').toBe(0) // wrapped
    expect(state().sweeps).toBe(1)
  })

  it('confirms a small miss with a second call instead of trusting one response', () => {
    seed(100)
    const r = run({ STUB_TRUNCATE: '0:45' }) // 5 missing: under the ratio, so confirmed
    expect(r.code, r.out).toBe(0)
    expect(
      tombs(),
      'ids the second call returned must not be tombstoned',
    ).toEqual([])
    expect(manifest().stats.lastSweep.truncatedBatches).toBe(1)
    expect(manifest().stats.lastSweep.refusedBatches).toBe(0)
    expect(manifest().stats.lastSweep.refused).toBe(false)
  })

  // The leak the first version had: a confirmation call that is itself partly truncated
  // leaves a remainder under the ratio, which was then tombstoned.
  it('does not trust the remainder when the confirmation call revived anything', () => {
    seed(100)
    run({ STUB_TRUNCATE: '0:45,1:3' }) // 5 missing, the second call returns only 3
    expect(tombs()).toEqual([])
    expect(manifest().stats.lastSweep.truncatedBatches).toBe(1)
  })

  it('defers a genuine deletion in a batch the API flaked on to the next pass', () => {
    seed(100)
    run({ STUB_TRUNCATE: '0:45', STUB_DEAD: id(7) })
    expect(
      tombs(),
      'a dead video can wait a night; a live one cannot come back',
    ).toEqual([])
  })

  it('tombstones a genuine deletion both responses agree on', () => {
    seed(100)
    run({ STUB_DEAD: id(7) })
    expect(tombs()).toEqual([id(7)])
    expect(manifest().stats.lastSweep.truncatedBatches).toBe(0)
  })

  it('does not let a refused batch block findings elsewhere in the window', () => {
    seed(100)
    run({ STUB_TRUNCATE: '0', STUB_DEAD: id(60) }) // batch 1 is calls 1 and 2
    expect(tombs()).toEqual([id(60)])
  })

  it('lets the deliberate override through at batch level too', () => {
    seed(100)
    run({ STUB_TRUNCATE: '0,1', ALLOW_MASS_REMOVAL: '1' })
    // Under the override the batch is confirmed rather than refused, and the remainder
    // is trusted: each truncated call keeps two items, so 46 of 50 are written.
    expect(tombs()).toHaveLength(46)
  })
})

// The batch guard sits in front of the whole-run guard and catches most mass-`gone`
// windows first, so these reach the whole-run guard through private videos, which the
// API returns as items and the batch guard therefore ignores.
describe('whole-run guard behind the batch guard', () => {
  it('still refuses a window where most of what was checked went private', () => {
    seed(200)
    const r = run({
      STUB_PRIVATE: Array.from({ length: 80 }, (_, i) => id(i)).join(','),
    })
    expect(r.out).toMatch(/REFUSING to tombstone 80 of 200/)
    expect(tombs()).toEqual([])
    const m = JSON.parse(readFileSync(join(pool, 'manifest.json'), 'utf8'))
    expect(m.stats.lastSweep.refused).toBe(true)
    expect(m.stats.lastSweep.refusedBatches).toBe(0)
  })

  it('still refuses a window in which nothing survived, below the floor', () => {
    seed(2)
    const r = run({ STUB_PRIVATE: [id(0), id(1)].join(',') })
    expect(r.out).toMatch(/REFUSING/)
    expect(tombs()).toEqual([])
  })
})

describe('what the sweep may tombstone', () => {
  it('tombstones deleted and private videos', () => {
    seed(200)
    const r = run({ STUB_DEAD: id(0), STUB_PRIVATE: id(1) })
    expect(r.code, r.out).toBe(0)
    expect(tombs().sort()).toEqual([id(0), id(1)].sort())
  })

  // Toggle-governed filters must never become deletions: the viewer can lift them.
  it('never tombstones age-restricted or non-embeddable videos', () => {
    seed(200)
    const r = run({ STUB_AGE: id(2), STUB_NOEMBED: id(3) })
    expect(r.code, r.out).toBe(0)
    expect(tombs()).toEqual([])
  })

  it('skips blocklisted ids without writing them to tombstones', () => {
    seed(200, { blocklist: [id(4), id(5)] })
    const r = run({})
    expect(r.code, r.out).toBe(0)
    expect(tombs(), 'blocklist removal must stay reversible').toEqual([])
  })
})
