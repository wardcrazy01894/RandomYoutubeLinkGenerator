import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// These exercise scripts/check-pool.mjs as CI actually runs it — as a process, against a
// fixture pool. It is the gate standing between a broken harvest and a published pool,
// and it used to pass an EMPTY pool ("Pool OK: 0 records", exit 0), which would have let
// a failed restore publish nothing over a good pool.

const SCRIPT = fileURLToPath(
  new URL('../scripts/check-pool.mjs', import.meta.url),
)
let dir

const run = () => {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      env: { ...process.env, POOL_DIR: dir },
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

const record = (id) => ({
  id,
  t: `title ${id}`,
  pub: '2020-01-01T00:00:00Z',
  v: 1,
  dur: 'PT1M',
  emb: true,
  age: false,
  mfk: false,
  h: '2026-01-01T00:00:00Z',
})

const writeManifest = (over = {}) =>
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      shardSize: 1000,
      total: 2,
      servable: 2,
      ...over,
    }),
  )

const writeShard = (n, ids) =>
  writeFileSync(
    join(dir, `shard-${String(n).padStart(5, '0')}.json`),
    JSON.stringify(ids.map(record)),
  )

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pool-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('check-pool', () => {
  it('accepts a well-formed pool', () => {
    writeManifest()
    writeShard(0, ['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    const r = run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('Pool OK')
  })

  // The regression that motivated these tests.
  it('rejects an empty pool directory instead of reporting "Pool OK: 0 records"', () => {
    const r = run()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/manifest\.json missing/)
  })

  it('rejects a pool whose manifest is missing but whose shards exist', () => {
    writeShard(0, ['aaaaaaaaaaa'])
    expect(run().code).toBe(1)
  })

  it('rejects a manifest claiming zero records', () => {
    writeManifest({ total: 0, servable: 0 })
    const r = run()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/empty pool is never a valid publish/)
  })

  // Pins the servable floor specifically: total is healthy and servable > total does
  // NOT apply, so only the dedicated guard can reject this. Deleting that guard must
  // turn this test red.
  it('rejects a pool whose records exist but none are servable', () => {
    writeManifest({ total: 2, servable: 0 })
    writeShard(0, ['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    const r = run()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/nothing would be drawable/)
  })

  it('rejects a fractional servable, which would reach randomBelow()', () => {
    writeManifest({ total: 2, servable: 1.5 })
    writeShard(0, ['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(run().code).toBe(1)
  })

  it('rejects a shard that parses but is not an array, with a diagnosis not a stack trace', () => {
    writeManifest({ total: 1, servable: 1 })
    writeFileSync(
      join(dir, 'shard-00000.json'),
      JSON.stringify({ not: 'an array' }),
    )
    const r = run()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/not a JSON array/)
    expect(r.out).not.toMatch(/TypeError/)
  })

  it('rejects a record count that disagrees with the manifest', () => {
    writeManifest({ total: 5 })
    writeShard(0, ['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(run().code).toBe(1)
  })

  it('rejects duplicate ids across the pool', () => {
    writeManifest()
    writeShard(0, ['aaaaaaaaaaa', 'aaaaaaaaaaa'])
    expect(run().code).toBe(1)
  })

  it('rejects a malformed video id', () => {
    writeManifest()
    writeShard(0, ['aaaaaaaaaaa', 'too-short'])
    expect(run().code).toBe(1)
  })

  it('rejects servable exceeding total', () => {
    writeManifest({ servable: 99 })
    writeShard(0, ['aaaaaaaaaaa', 'bbbbbbbbbbb'])
    expect(run().code).toBe(1)
  })
})
