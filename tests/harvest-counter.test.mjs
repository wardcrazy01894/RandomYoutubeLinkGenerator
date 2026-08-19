import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  cpSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { prefixAt, PREFIX_SPACE } from '../scripts/lib/prefix.mjs'

// The harvest loop's counting rules have been rewritten three times, and each rewrite
// broke differently: advancing by prefixes PLANNED rather than queried; incrementing
// before the try so a throw still burned one; counting non-contiguously so a mid-plan
// failure lost a prefix forever. None of it was covered by a test.
//
// state.counter is a single integer resume point, so the invariant is exact and worth
// pinning: EVERY prefix index in [priorCounter, newCounter) must have been successfully
// queried. These tests run the real harvest.mjs against a stubbed API and assert it.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEY = 'RandomYoutubeLinkGenerator/v1' // must match FEISTEL_KEY's default

let dir, pool, log

/** A stand-in for lib/youtube.mjs: deterministic, offline, and instrumented. */
const STUB = `
import { appendFileSync } from 'node:fs'
export const COST = { search: 100, videos: 1 }
export class QuotaExceeded extends Error {}
export class ApiKeyError extends Error {}
export const sleep = () => Promise.resolve()
let calls = 0
const failAt = Number(process.env.STUB_FAIL_AT ?? 0)
const quotaAt = Number(process.env.STUB_QUOTA_AT ?? 0)
const perBucket = Number(process.env.STUB_PER_BUCKET ?? 2)
export async function searchPage(key, q) {
  // The canary runs first and must resolve, or harvest aborts before the loop.
  if (q === 'my8exz') return { ids: ['my8EXZ-mqpQ'], nextPageToken: null, totalResults: 1 }
  calls++
  if (quotaAt && calls === quotaAt) throw new QuotaExceeded('stub quota')
  if (failAt && calls === failAt) throw new Error('stub 503')
  appendFileSync(process.env.STUB_LOG, q + '\\n')
  const ids = []
  for (let i = 0; i < perBucket; i++) ids.push(q + '-' + String.fromCharCode(97 + i).repeat(5))
  return { ids, nextPageToken: null, totalResults: ids.length }
}
export async function videosMeta(key, ids) {
  return ids.map((id) => ({
    id, title: 't', publishedAt: '2020-01-01T00:00:00Z',
    embeddable: true, privacyStatus: 'public', ageRestricted: false,
    duration: 'PT1M', views: 1, madeForKids: false,
  }))
}
`

function run(env = {}) {
  try {
    const stdout = execFileSync('node', [join(dir, 'harvest.mjs')], {
      env: {
        ...process.env,
        YOUTUBE_API_KEY: 'stub',
        POOL_DIR: pool,
        HARVEST_PACING_MS: '0',
        STUB_LOG: log,
        ...env,
      },
      encoding: 'utf8',
    })
    return { code: 0, out: stdout }
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    }
  }
}

const state = () => JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'))
const manifest = () =>
  JSON.parse(readFileSync(join(pool, 'manifest.json'), 'utf8'))
const queried = () =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []

/** The invariant: nothing below the counter may be unqueried. */
function assertNoGaps(priorCounter, newCounter) {
  const asked = new Set(queried())
  const missed = []
  for (let n = priorCounter; n < newCounter; n++) {
    const p = prefixAt(KEY, n)
    if (!asked.has(p)) missed.push({ n, prefix: p })
  }
  expect(missed, 'prefixes counted as consumed but never queried').toEqual([])
}

function seed(health = {}) {
  mkdirSync(pool, { recursive: true })
  writeFileSync(
    join(pool, 'manifest.json'),
    JSON.stringify({
      version: 1,
      shardSize: 1000,
      total: 0,
      servable: 0,
      generatedAt: null,
      health: {
        status: 'ok',
        lastRunUtc: null,
        buckets: 0,
        yield: null,
        ...health,
      },
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
    }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harvest-'))
  cpSync(join(ROOT, 'scripts'), dir, { recursive: true })
  writeFileSync(join(dir, 'lib', 'youtube.mjs'), STUB)
  pool = join(dir, 'pool')
  log = join(dir, 'queried.log')
  seed()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('harvest counter', () => {
  it('advances by exactly the prefixes it queried, with no gaps', () => {
    const r = run({ HARVEST_UNITS: '1200' })
    expect(r.code).toBe(0)
    const s = state()
    expect(s.counter).toBeGreaterThan(0)
    expect(s.counter).toBeLessThanOrEqual(PREFIX_SPACE)
    assertNoGaps(0, s.counter)
    // Every fresh bucket queried is counted, and nothing else is.
    expect(s.counter).toBe(queried().length)
  })

  // The round-three bug: a mid-plan failure left a hole below the counter.
  it('never counts past a bucket that failed', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_FAIL_AT: '3' })
    expect(r.code).toBe(0)
    const s = state()
    assertNoGaps(0, s.counter)
    // The failure is at the 3rd bucket, so at most the first two may be consumed.
    expect(s.counter).toBeLessThanOrEqual(2)
  })

  // The round-four bug: freezing the counter while still harvesting poisoned the next
  // run's yield. Nothing may be committed against a frozen counter.
  it('stops issuing fresh queries once a bucket has failed', () => {
    run({ HARVEST_UNITS: '3000', STUB_FAIL_AT: '2' })
    expect(queried().length).toBeLessThanOrEqual(1)
  })

  it('exits cleanly on quota exhaustion and still counts only what it queried', () => {
    const r = run({ HARVEST_UNITS: '3000', STUB_QUOTA_AT: '4' })
    expect(r.code).toBe(0)
    const s = state()
    assertNoGaps(0, s.counter)
    expect(s.counter).toBe(queried().length)
  })
})

describe('yield baseline', () => {
  // The gate used to lower its own threshold: a collapsed yield was folded into the
  // baseline, so repeated failures decayed it until the run reported "ok" while
  // harvesting almost nothing.
  it('does not move the baseline on a collapsed run', () => {
    seed({ baselineYield: 5 })
    const r = run({ HARVEST_UNITS: '2600', STUB_PER_BUCKET: '0' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/yield-collapsed|below half/i)
    const h = manifest().health
    expect(h.status).toBe('yield-collapsed')
    expect(
      h.baselineYield,
      'a failed run must not lower the alarm threshold',
    ).toBe(5)
  })

  it('records the run shape so a truncated run is distinguishable from a full one', () => {
    run({ HARVEST_UNITS: '3000', STUB_FAIL_AT: '2' })
    const h = manifest().health
    expect(h.truncated).toBe(true)
    expect(h.freshPlanned).toBeGreaterThan(h.freshAttempted)
  })
})
