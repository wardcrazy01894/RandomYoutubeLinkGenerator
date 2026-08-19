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
let seen = 0
export async function videosMeta(key, ids) {
  if (quotaAfter && seen >= quotaAfter) throw new QuotaExceeded('stub quota')
  seen += ids.length
  // Absent from the response == deleted, which is what the real API does.
  return ids.filter((i) => !dead.has(i)).map((i) => ({
    id: i,
    privacyStatus: priv.has(i) ? 'private' : 'public',
    embeddable: !noembed.has(i),
    ageRestricted: age.has(i),
  }))
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
