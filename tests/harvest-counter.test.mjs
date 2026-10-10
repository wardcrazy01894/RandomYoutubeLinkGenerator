import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  readdirSync,
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
const KEY = 'RandomYoutubeLinkGenerator/v1' // pinned into the child env below

let dir, pool, log, canaryLog

/** A stand-in for lib/youtube.mjs: deterministic, offline, and instrumented. */
const STUB = `
import { appendFileSync } from 'node:fs'
export const COST = { search: 100, videos: 1 }
export const VIDEOS_CHUNK = 50
export class QuotaExceeded extends Error {}
export class ApiKeyError extends Error {}
export const sleep = () => Promise.resolve()
let calls = 0
const failAt = Number(process.env.STUB_FAIL_AT ?? 0)
const failAll = process.env.STUB_FAIL_ALL === '1'
const quotaAt = Number(process.env.STUB_QUOTA_AT ?? 0)
const perBucket = Number(process.env.STUB_PER_BUCKET ?? 2)
// Bucket-shaped knobs, keyed on the k-th DISTINCT bucket queried (1-based).
const unexhaustedAt = Number(process.env.STUB_UNEXHAUSTED_AT ?? 0)
const goneAt = Number(process.env.STUB_META_GONE_AT ?? 0)
// How many of that bucket's members are gone, counted from the END (default: all).
const goneCount = Number(process.env.STUB_META_GONE_COUNT ?? Infinity)
const metaQuotaOnCall = Number(process.env.STUB_META_QUOTA_ON_CALL ?? 0)
const metaExtra = process.env.STUB_META_EXTRA === '1'
// Every call loses its last N items, and an id once lost STAYS lost — a truncation that
// hits the same ids on the confirming call as on the first.
const tailDrop = Number(process.env.STUB_META_TAIL_DROP ?? 0)
const tailLost = new Set()
// Every call loses the first N items of the request, by POSITION — so an id placed first
// in the confirming call is lost again, exactly as it was in the first call.
const headDrop = Number(process.env.STUB_META_HEAD_DROP ?? 0)
const metaDup = process.env.STUB_META_DUP === '1'
const missingOnce = Number(process.env.STUB_META_MISSING_ONCE ?? 0)
const metaEmpty = process.env.STUB_META_EMPTY === '1'
const nonPublic = process.env.STUB_META_NONPUBLIC === '1'
const buckets = []
// Google's quota is project-wide and stays exhausted until it resets, so once any call
// has hit it, every later call (videos.list included) hits it too. The stub used to let
// videosMeta succeed after a search QuotaExceeded, which no real run can do.
let quotaGone = false
let metaCalls = 0
export async function searchPage(key, q, pageToken) {
  // The canary runs first and must resolve, or harvest aborts before the loop.
  // Logged to its OWN file: the bucket log below cannot distinguish "checked before the
  // canary" from "checked after it", so a regression that burns the canary's 100 units
  // before failing shipped green. Anything asserting ordering needs this marker.
  if (q === 'my8exz') {
    appendFileSync(process.env.STUB_CANARY_LOG, 'canary\\n')
    return { ids: ['my8EXZ-mqpQ'], nextPageToken: null, totalResults: 1 }
  }
  calls++
  if (quotaGone) throw new QuotaExceeded('stub quota (still exhausted)')
  if (quotaAt && calls === quotaAt) {
    quotaGone = true
    throw new QuotaExceeded('stub quota')
  }
  if (failAll) throw new Error('stub total outage')
  if (failAt && calls === failAt) throw new Error('stub 503')
  if (!pageToken) {
    appendFileSync(process.env.STUB_LOG, q + '\\n')
    buckets.push(q)
  }
  const ids = []
  for (let i = 0; i < perBucket; i++) ids.push(q + '-' + String.fromCharCode(97 + i).repeat(5))
  // A bucket that never runs out of pages: the harvester must reject it whole.
  const more = unexhaustedAt && buckets.indexOf(q) === unexhaustedAt - 1
  return { ids, nextPageToken: more ? 'more' : null, totalResults: ids.length }
}
const bucketOf = (id) => id.slice(0, id.lastIndexOf('-'))
export async function videosMeta(key, ids) {
  if (quotaGone) throw new QuotaExceeded('stub quota (still exhausted)')
  metaCalls++
  if (metaQuotaOnCall && metaCalls === metaQuotaOnCall) {
    quotaGone = true
    throw new QuotaExceeded('stub quota on videos.list')
  }
  if (metaEmpty) return []
  let served = ids
  // Permanently absent, on every call: the last goneCount members of the k-th bucket.
  if (goneAt) {
    const members = ids.filter((id) => bucketOf(id) === buckets[goneAt - 1]).sort()
    const dead = new Set(members.slice(Math.max(0, members.length - goneCount)))
    served = served.filter((id) => !dead.has(id))
  }
  // Truncated FIRST response only (the 2026-10-01 shape); a second call returns them.
  if (missingOnce && metaCalls === 1) served = served.slice(0, served.length - missingOnce)
  if (tailDrop) {
    served = served.filter((id) => !tailLost.has(id))
    for (const id of served.slice(Math.max(0, served.length - tailDrop))) tailLost.add(id)
    served = served.slice(0, Math.max(0, served.length - tailDrop))
  }
  if (headDrop) served = served.slice(headDrop)
  if (metaDup && served.length > 0) served = [served[0], ...served]
  if (metaExtra) served = [...served, 'zzzzzzzzzzz']
  return served.map((id) => ({
    id, title: 't', publishedAt: '2020-01-01T00:00:00Z',
    embeddable: true,
    privacyStatus: nonPublic && id.endsWith('-bbbbb') ? 'unlisted' : 'public',
    ageRestricted: false,
    duration: 'PT1M', views: 1, madeForKids: false,
  }))
}
`

function run(env = {}) {
  // spawnSync rather than execFileSync: the latter returns only stdout, and only on
  // success, so console.warn output was invisible to assertions on a passing run.
  const res = spawnSync('node', [join(dir, 'harvest.mjs')], {
    env: {
      ...process.env,
      YOUTUBE_API_KEY: 'stub',
      POOL_DIR: pool,
      HARVEST_PACING_MS: '0',
      // Pinned: an ambient HARVEST_KEY would otherwise change the prefix order and
      // surface as a confusing "counted but never queried" failure.
      HARVEST_KEY: KEY,
      STUB_LOG: log,
      STUB_CANARY_LOG: canaryLog,
      ...env,
    },
    encoding: 'utf8',
  })
  return {
    code: res.status ?? 1,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  }
}

const state = () => JSON.parse(readFileSync(join(pool, 'state.json'), 'utf8'))
const manifest = () =>
  JSON.parse(readFileSync(join(pool, 'manifest.json'), 'utf8'))
/** Every id committed to the pool, across all shards. */
const pooled = () =>
  readdirSync(pool)
    .filter((f) => /^shard-\d+\.json$/.test(f))
    .flatMap((f) => JSON.parse(readFileSync(join(pool, f), 'utf8')))
    .map((r) => r.id)
const queried = () =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
/** Whether the canary search actually went out — the 100 units a pre-flight must save. */
const canaryRan = () => existsSync(canaryLog)

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
  canaryLog = join(dir, 'canary.log')
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
    // Exact, not a bound: `<= 2` is satisfied by 0, so a harvester that queried
    // nothing would pass. The failure is at the 3rd bucket, so exactly two are consumed.
    expect(s.counter).toBe(2)
  })

  // The round-four bug: freezing the counter while still harvesting poisoned the next
  // run's yield. Nothing may be committed against a frozen counter.
  it('stops issuing fresh queries once a bucket has failed', () => {
    const r = run({ HARVEST_UNITS: '3000', STUB_FAIL_AT: '2' })
    // Exit code asserted too: `queried().length <= 1` is satisfied by 0, so without this
    // the test passed even when the harvester crashed before issuing any query.
    expect(r.code, r.out).toBe(0)
    expect(queried().length).toBeLessThanOrEqual(1)
  })

  // Quota is project-wide, so a QuotaExceeded mid-loop also blocks videos.list. The
  // found ids cannot be enriched; committing nothing and leaving the counter alone means
  // the same buckets are redrawn, rather than skipped with their videos thrown away.
  it('commits nothing and keeps the counter when quota runs out before enrichment', () => {
    const r = run({ HARVEST_UNITS: '3000', STUB_QUOTA_AT: '4' })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(
      /quota ran out before \d+ found ids could be enriched/,
    )
    expect(manifest().health.status).toBe('quota-before-enrich')
    expect(
      state().counter,
      'buckets that were never enriched must be redrawn',
    ).toBe(0)
    expect(pooled()).toEqual([])
  })
})

describe('total API outage', () => {
  // The alarm was guarded by `bucketsDone > 0`, so when EVERY search throws — zero
  // buckets complete — it was skipped and the run exited 0 forever. `freshHole`
  // distinguishes "buckets failed" from "no budget was available".
  it('alarms when every search fails and no bucket completes', () => {
    seed({ baselineYield: 3 })
    const r = run({ HARVEST_UNITS: '9000', STUB_FAIL_ALL: '1' })
    expect(r.code, 'a total outage must never report ok').toBe(1)
    const h = manifest().health
    expect(h.status).toBe('no-fresh-progress')
    expect(h.buckets).toBe(0)
  })

  // ...but the quota-capped ending also completes zero buckets, and IS normal. Without
  // !quotaHit the new disjunct would turn every quota-exhausted night into an alarm.
  it('stays quiet when a generic failure is followed by quota exhaustion', () => {
    seed({ baselineYield: 3 })
    // A non-zero counter is what makes re-harvest entries exist. Without them the loop
    // ends the moment the fresh plan is abandoned, so quota is never reached and this
    // would exercise the outage path instead of the one it names.
    writeFileSync(
      join(pool, 'state.json'),
      JSON.stringify({
        counter: 400,
        reharvestCursor: 0,
        sweeps: 0,
        totalBuckets: 400,
      }),
    )
    const r = run({
      HARVEST_UNITS: '9000',
      STUB_FAIL_AT: '1',
      STUB_QUOTA_AT: '2',
    })
    expect(r.code, r.out).toBe(0)
    expect(manifest().health.status).toBe('ok-quota-capped')
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
    const r = run({ HARVEST_UNITS: '3000', STUB_FAIL_AT: '2' })
    expect(r.code, r.out).toBe(0)
    const h = manifest().health
    expect(h.truncated).toBe(true)
    expect(h.freshPlanned).toBeGreaterThan(h.freshAttempted)
  })
})

describe('baseline escape hatch and truncation', () => {
  // A truncated run is mostly re-harvest buckets, so its yield is unrepresentative.
  // Letting it move the baseline reaches the same self-silencing state via 'ok'.
  it('does not move the baseline on a truncated run', () => {
    seed({ baselineYield: 4 })
    // A non-zero counter is what makes re-harvest entries exist, so the run can still
    // clear the 20-bucket threshold after abandoning its fresh plan.
    writeFileSync(
      join(pool, 'state.json'),
      JSON.stringify({
        counter: 400,
        reharvestCursor: 0,
        sweeps: 0,
        totalBuckets: 400,
      }),
    )
    // The plan interleaves fresh and re-harvest (F R F F R F ...), so search 6 is the
    // fourth fresh bucket: three fresh buckets complete first, making this
    // truncated-but-HEALTHY rather than a total fresh-plan failure (which has its own
    // alarm). Yield clears the gate, so this is the case that would otherwise walk the
    // baseline down under 'ok'.
    const r = run({
      HARVEST_UNITS: '9000',
      STUB_FAIL_AT: '6',
      STUB_PER_BUCKET: '3',
    })
    expect(r.code, r.out).toBe(0)
    const h = manifest().health
    expect(h.truncated).toBe(true)
    expect(h.baselineYield, 'a truncated run must not move the threshold').toBe(
      4,
    )
  })

  // Removing the decay removed the only self-recovery path, so the hatch must actually
  // work — it has to bypass the GATE as well as recordHealth, or the run exits before
  // writeState and relearns nothing.
  it('relearns the baseline when explicitly reset', () => {
    seed({ baselineYield: 5 })
    const r = run({
      HARVEST_UNITS: '2600',
      STUB_PER_BUCKET: '1',
      HARVEST_BASELINE_RESET: '1',
    })
    expect(r.code, r.out).toBe(0)
    const h = manifest().health
    expect(h.status).toBe('ok')
    expect(
      h.baselineYield,
      'the hatch must relearn, not keep the old threshold',
    ).toBe(1)
  })

  it('still fails without the reset, so the hatch is required to be deliberate', () => {
    seed({ baselineYield: 5 })
    const r = run({ HARVEST_UNITS: '2600', STUB_PER_BUCKET: '1' })
    expect(r.code).toBe(1)
    // Asserts the STATUS too: baselineYield alone is the seeded value, so this test
    // passed even when the harvester crashed before running.
    expect(manifest().health.status).toBe('yield-collapsed')
    expect(manifest().health.baselineYield).toBe(5)
  })
})

describe('escape hatch cannot be turned into a silencer', () => {
  // Boolean('0') is true, so HARVEST_BASELINE_RESET=0 — the most natural way to write
  // "off" — disabled the gate and relearned the baseline from a collapsed run.
  it('treats HARVEST_BASELINE_RESET=0 as OFF, leaving the gate armed', () => {
    seed({ baselineYield: 5 })
    const r = run({
      HARVEST_UNITS: '2600',
      STUB_PER_BUCKET: '1',
      HARVEST_BASELINE_RESET: '0',
    })
    expect(
      r.code,
      'a collapsed run must still fail with the hatch set to 0',
    ).toBe(1)
    // Asserts the STATUS too: baselineYield alone is the seeded value, so this test
    // passed even when the harvester crashed before running.
    expect(manifest().health.status).toBe('yield-collapsed')
    expect(manifest().health.baselineYield).toBe(5)
  })

  it('ignores any value that is not exactly 1', () => {
    seed({ baselineYield: 5 })
    const r = run({
      HARVEST_UNITS: '2600',
      STUB_PER_BUCKET: '1',
      HARVEST_BASELINE_RESET: 'false',
    })
    expect(r.code).toBe(1)
    // Asserts the STATUS too: baselineYield alone is the seeded value, so this test
    // passed even when the harvester crashed before running.
    expect(manifest().health.status).toBe('yield-collapsed')
    expect(manifest().health.baselineYield).toBe(5)
  })

  // A reset on a run too small to relearn used to write null, leaving the gate off until
  // some later run rebuilt it unattended.
  it('keeps the stored baseline when the run is too small to relearn', () => {
    seed({ baselineYield: 5 })
    const r = run({
      HARVEST_UNITS: '600',
      STUB_PER_BUCKET: '4',
      HARVEST_BASELINE_RESET: '1',
    })
    expect(r.code, r.out).toBe(0)
    expect(manifest().health.baselineYield, 'must not be erased').toBe(5)
    expect(r.out).toMatch(/cannot relearn a baseline/i)
  })

  // The gate measures FRESH buckets: a truncated run is mostly re-harvest buckets that
  // legitimately return little, so measuring it against the baseline false-alarms.
  // Gating on freshAttempted made a TOTAL fresh-plan failure silent: freshAttempted 0 is
  // below the threshold, so the gate was skipped and the run reported ok — counter
  // frozen, nothing published, every night identical. That case has no yield to measure,
  // so it gets its own alarm rather than falling through the yield gate.
  it('alarms when not one fresh bucket completes', () => {
    seed({ baselineYield: 5 })
    writeFileSync(
      join(pool, 'state.json'),
      JSON.stringify({
        counter: 400,
        reharvestCursor: 0,
        sweeps: 0,
        totalBuckets: 400,
      }),
    )
    const r = run({
      HARVEST_UNITS: '9000',
      STUB_FAIL_AT: '1',
      STUB_PER_BUCKET: '3',
    })
    expect(r.code, 'a frozen sampling frontier must never report ok').toBe(1)
    expect(manifest().health.status).toBe('no-fresh-progress')
    expect(r.out).toMatch(/frontier is not advancing/i)
  })

  // The quota-capped ending is a normal one, not a fault: it must not trip that alarm.
  it('does not alarm when the run simply ran out of quota', () => {
    seed({ baselineYield: 5 })
    const r = run({
      HARVEST_UNITS: '9000',
      STUB_QUOTA_AT: '1',
      STUB_PER_BUCKET: '3',
    })
    expect(r.code, r.out).toBe(0)
    expect(manifest().health.status).toBe('ok-quota-capped')
    // Nothing was found, so nothing needed enriching: a clean stop, no bucket counted.
    expect(state().counter).toBe(0)
  })
})

// A budget below one bucket's worst-case cost produced a run that spent the canary's 100
// units, harvested nothing, and exited 0 reporting "ok" — observed live at
// HARVEST_UNITS=300. The plan sizes a bucket at one page (100), but the loop will not
// START a bucket without MAX_PAGES+1 pages (400) in reserve, so it planned work it could
// never run. That is the "succeeds while producing nothing" failure this project exists
// to design against, so it is now fatal and detected before any API call.
describe('budget floor', () => {
  it('refuses a budget too small to start a single bucket', () => {
    seed()
    const r = run({ HARVEST_UNITS: '300' })
    expect(r.code, 'a run that cannot harvest must not report success').toBe(1)
    expect(r.out).toMatch(/cannot harvest anything/)
  })

  it('refuses before spending anything on the API', () => {
    seed()
    run({ HARVEST_UNITS: '300' })
    // Both assertions matter. The bucket log alone passed even when the check was moved
    // to AFTER the canary, because the canary is a special-cased early return that never
    // reached the bucket log — so the test could not see the 100 units being burned.
    expect(canaryRan(), 'the check must precede even the canary').toBe(false)
    expect(queried(), 'no bucket may be queried either').toEqual([])
  })

  it('does run the canary when the budget is usable', () => {
    seed()
    run({ HARVEST_UNITS: '500' })
    expect(canaryRan(), 'otherwise the assertion above proves nothing').toBe(
      true,
    )
  })

  it('names the minimum that would work', () => {
    seed()
    expect(run({ HARVEST_UNITS: '300' }).out).toMatch(
      /minimum useful budget is 500/,
    )
  })

  it('allows the smallest budget that can actually run a bucket', () => {
    seed()
    const r = run({ HARVEST_UNITS: '500' })
    expect(r.code, '500 is exactly canary + one bucket reserve').toBe(0)
    // The stub does not log the canary, so this counts real buckets. Exactly one fits:
    // the first search leaves 300, below the 400 reserve, so the loop stops there.
    expect(queried().length, 'the floor must permit exactly one bucket').toBe(1)
  })
})

// The stub used to report every bucket exhausted and every id public, so none of the
// paths below — the ones that decide WHICH videos enter the pool — had a test.
describe('what enters the pool', () => {
  it('drops an unexhausted bucket whole and keeps the others', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_UNEXHAUSTED_AT: '2' })
    expect(r.code, r.out).toBe(0)
    const [first, second, third] = queried()
    expect(second, 'the run must reach the bucket under test').toBeDefined()
    const ids = pooled()
    expect(ids.filter((id) => id.startsWith(`${second}-`))).toEqual([])
    expect(ids).toContain(`${first}-aaaaa`)
    if (third) expect(ids).toContain(`${third}-aaaaa`)
    expect(r.out).toMatch(/1 buckets dropped as unexhausted/)
  })

  it('keeps ids that a truncated first videos.list response omitted but a retry returned', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_META_MISSING_ONCE: '2' })
    expect(r.code, r.out).toBe(0)
    expect(pooled()).toHaveLength(queried().length * 2)
    expect(r.out).toMatch(/2 came back on a second call/)
    expect(manifest().health.bucketsDroppedUnconfirmed).toBe(0)
    expect(manifest().health.revivedOnRetry).toBe(2)
  })

  // A handful missing on BOTH calls, with nothing revived, are deletions: only those ids
  // go. Dropping the bucket would keep the siblings out for a whole re-harvest rotation.
  it('drops just a deleted id, keeping its bucket-mates, when nothing suggests truncation', () => {
    const r = run({
      HARVEST_UNITS: '1200',
      STUB_META_GONE_AT: '1',
      STUB_META_GONE_COUNT: '1',
    })
    expect(r.code, r.out).toBe(0)
    const [first] = queried()
    const ids = pooled()
    expect(ids).toContain(`${first}-aaaaa`)
    expect(ids).not.toContain(`${first}-bbbbb`)
    const h = manifest().health
    expect(h.gone).toBe(1)
    expect(h.bucketsDroppedUnconfirmed).toBe(0)
  })

  // The non-negotiable: once responses are known to truncate, a bucket with ANY member
  // unconfirmed is dropped whole. The sibling assertion is what pins it — a bucket whose
  // every member is missing looks the same whether it was dropped whole or id by id.
  it('drops the whole bucket when the retry shows responses are truncating', () => {
    const r = run({
      HARVEST_UNITS: '1200',
      STUB_META_GONE_AT: '1',
      STUB_META_GONE_COUNT: '1',
      STUB_META_MISSING_ONCE: '2',
    })
    expect(r.code, r.out).toBe(0)
    const [first] = queried()
    expect(pooled(), 'a partial bucket must never be kept').not.toContain(
      `${first}-aaaaa`,
    )
    expect(manifest().health.bucketsDroppedUnconfirmed).toBe(1)
    expect(r.out).toMatch(/Responses look truncated/)
  })

  it('treats too many still-missing ids as truncation even if none were revived', () => {
    const r = run({
      HARVEST_UNITS: '1200',
      STUB_PER_BUCKET: '6',
      STUB_META_GONE_AT: '1',
      STUB_META_GONE_COUNT: '4',
    })
    expect(r.code, r.out).toBe(0)
    const [first] = queried()
    const ids = pooled()
    expect(ids).not.toContain(`${first}-aaaaa`)
    expect(ids).not.toContain(`${first}-bbbbb`)
    expect(manifest().health.bucketsDroppedUnconfirmed).toBe(1)
  })

  // The slip the controls close: a truncation that drops the TAIL of every request loses
  // the same ids on both calls, revives nothing, and stays under the deletion budget — so
  // without controls it passed as deletions and kept the rest of the bucket.
  it('catches a truncation that drops the same tail on both calls', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_META_TAIL_DROP: '1' })
    expect(r.code, r.out).toBe(0)
    const last = queried().at(-1)
    expect(pooled(), 'a partial bucket must never be kept').not.toContain(
      `${last}-aaaaa`,
    )
    const h = manifest().health
    expect(h.gone).toBe(0)
    expect(h.bucketsDroppedUnconfirmed).toBe(1)
    expect(h.controlsLost).toBeGreaterThan(0)
  })

  // With controls only at the end, the missing id would sit first in the confirming call,
  // be lost again, and pass as a deletion — keeping its bucket-mate.
  it('catches a truncation that drops the head of every request', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_META_HEAD_DROP: '1' })
    expect(r.code, r.out).toBe(0)
    const ids = new Set(pooled())
    for (const q of queried()) {
      const present = [`${q}-aaaaa`, `${q}-bbbbb`].filter((id) => ids.has(id))
      expect(
        present.length === 0 || present.length === 2,
        `bucket ${q} kept partial: ${present}`,
      ).toBe(true)
    }
    const h = manifest().health
    expect(h.gone).toBe(0)
    expect(h.controlsLost).toBeGreaterThan(0)
  })

  // Boundaries of max(GONE_FLOOR, ceil(GONE_RATIO * found)), so `>` vs `>=` and each
  // term are pinned.
  it('treats exactly the floor of 3 still-missing as deletions', () => {
    // 7 buckets x 6 = 42 found, so 2% rounds up to 1 and the floor of 3 governs.
    const r = run({
      HARVEST_UNITS: '1200',
      STUB_PER_BUCKET: '6',
      STUB_META_GONE_AT: '1',
      STUB_META_GONE_COUNT: '3',
    })
    expect(r.code, r.out).toBe(0)
    const [first] = queried()
    expect(pooled()).toContain(`${first}-aaaaa`)
    expect(manifest().health.gone).toBe(3)
  })

  it('lets the 2% term raise the budget above the floor on a large run', () => {
    // 26 buckets x 6 = 156 found; 2% is 3.12, rounded up to 4, above the floor of 3.
    const r = run({
      HARVEST_UNITS: '3000',
      STUB_PER_BUCKET: '6',
      STUB_META_GONE_AT: '1',
      STUB_META_GONE_COUNT: '4',
    })
    expect(r.code, r.out).toBe(0)
    expect(manifest().health.found).toBe(156)
    const [first] = queried()
    expect(pooled()).toContain(`${first}-aaaaa`)
    expect(manifest().health.gone).toBe(4)
  })

  // With fewer controls than required there is no proof the confirming response was
  // whole, so it must be treated as truncation rather than waved through as deletions.
  it('treats a confirmation without enough controls as inconclusive', () => {
    // One bucket of two; one member missing leaves a single id to use as a control.
    const r = run({
      HARVEST_UNITS: '500',
      STUB_META_GONE_AT: '1',
      STUB_META_GONE_COUNT: '1',
    })
    expect(r.code, r.out).toBe(0)
    const [only] = queried()
    expect(pooled()).not.toContain(`${only}-aaaaa`)
    expect(manifest().health.conclusive).toBe(false)
  })

  it('appends a video only once even if videos.list repeats it', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_META_DUP: '1' })
    expect(r.code, r.out).toBe(0)
    const ids = pooled()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never appends an id videos.list returned without being asked for', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_META_EXTRA: '1' })
    expect(r.code, r.out).toBe(0)
    expect(pooled()).not.toContain('zzzzzzzzzzz')
    expect(pooled()).toHaveLength(queried().length * 2)
  })

  it('commits nothing when quota runs out on the confirming call', () => {
    const r = run({
      HARVEST_UNITS: '1200',
      STUB_META_MISSING_ONCE: '2',
      STUB_META_QUOTA_ON_CALL: '2',
    })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/quota ran out while confirming/)
    expect(manifest().health.status).toBe('quota-before-enrich')
    expect(state().counter).toBe(0)
    expect(pooled()).toEqual([])
  })

  it('reports non-public and too-fresh separately, and they sum to what was found', () => {
    const r = run({ HARVEST_UNITS: '1200', STUB_META_NONPUBLIC: '1' })
    expect(r.code, r.out).toBe(0)
    const h = manifest().health
    expect(h.nonPublic).toBe(queried().length)
    expect(
      h.appended + h.nonPublic + h.heldBackFresh + h.inDroppedBuckets + h.gone,
    ).toBe(h.found)
    expect(r.out).toMatch(new RegExp(`${h.nonPublic} non-public`))
  })

  // The yield gate measures search, so a videos.list that silently returns nothing
  // would append zero records every night under "ok".
  it('alarms when enrichment keeps almost nothing, and commits nothing', () => {
    const r = run({ HARVEST_UNITS: '2600', STUB_META_EMPTY: '1' })
    expect(r.code, r.out).toBe(1)
    expect(manifest().health.status).toBe('enrich-collapsed')
    expect(state().counter).toBe(0)
    expect(pooled()).toEqual([])
  })
})

// Fresh-first planning meant the entries left unrun when the budget ran short were always
// the re-harvest ones — 0-4 of 26 a night in production, so the recency mitigation was
// effectively off. Interleaving must give re-harvest its share of whatever does run.
describe('re-harvest share', () => {
  it('runs re-harvest buckets in proportion even when the run stops early', () => {
    writeFileSync(
      join(pool, 'state.json'),
      JSON.stringify({
        counter: 400,
        reharvestCursor: 0,
        sweeps: 0,
        totalBuckets: 400,
      }),
    )
    // Stops after 10 searches; fresh-first would have spent all 10 on fresh buckets.
    const r = run({ HARVEST_UNITS: '9000', STUB_QUOTA_AT: '11' })
    const h = manifest().health
    expect(h.freshAttempted + h.reharvestAttempted, r.out).toBe(10)
    expect(h.reharvestAttempted).toBeGreaterThanOrEqual(2)
    expect(h.reharvestAttempted).toBeLessThanOrEqual(4)
  })

  it('keeps fresh buckets in counter order, so the contiguity rule still holds', () => {
    writeFileSync(
      join(pool, 'state.json'),
      JSON.stringify({
        counter: 400,
        reharvestCursor: 0,
        sweeps: 0,
        totalBuckets: 400,
      }),
    )
    const r = run({ HARVEST_UNITS: '3000' })
    expect(r.code, r.out).toBe(0)
    const s = state()
    expect(s.counter).toBeGreaterThan(400)
    assertNoGaps(400, s.counter)
    expect(s.reharvestCursor).toBeGreaterThan(0)
  })
})
