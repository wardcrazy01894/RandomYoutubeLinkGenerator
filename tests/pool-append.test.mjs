import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// appendRecords is the only writer of pool data, and shards are immutable by contract
// (docs/DESIGN.md §4.1). Its guards had no coverage at all, which is how the
// offset === 0 hole survived: a lost or truncated manifest reports total 0, so the
// "does the existing shard match the manifest" check was skipped entirely and a full
// 1000-record shard could be silently overwritten.

let dir

/** POOL_DIR is read at module load, so the module is re-imported per fixture. */
async function loadPool(poolDir) {
  vi.resetModules()
  process.env.POOL_DIR = poolDir
  return import('../scripts/lib/pool.mjs')
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

const shardFile = (n) => join(dir, `shard-${String(n).padStart(5, '0')}.json`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pool-append-'))
})
afterEach(() => {
  delete process.env.POOL_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('appendRecords', () => {
  it('writes a new shard and returns the new total', async () => {
    const { appendRecords } = await loadPool(dir)
    expect(appendRecords([record('aaaaaaaaaaa')], 0)).toBe(1)
    expect(JSON.parse(readFileSync(shardFile(0), 'utf8'))).toHaveLength(1)
  })

  // The regression: total 0 (a lost manifest) must never clobber existing data.
  it('refuses to overwrite an existing shard when the manifest implies an empty pool', async () => {
    const { appendRecords } = await loadPool(dir)
    writeFileSync(shardFile(0), JSON.stringify([record('bbbbbbbbbbb')]))
    expect(() => appendRecords([record('aaaaaaaaaaa')], 0)).toThrow(
      /refusing to overwrite/i,
    )
    // The existing shard must be untouched.
    expect(JSON.parse(readFileSync(shardFile(0), 'utf8'))[0].id).toBe(
      'bbbbbbbbbbb',
    )
  })

  it('refuses when an existing shard disagrees with the manifest offset', async () => {
    const { appendRecords } = await loadPool(dir)
    writeFileSync(shardFile(0), JSON.stringify([record('bbbbbbbbbbb')]))
    // Manifest claims 5 records exist, but the shard holds 1.
    expect(() => appendRecords([record('aaaaaaaaaaa')], 5)).toThrow(
      /refusing to write/i,
    )
  })

  it('appends to a partial tail shard without rewriting earlier ones', async () => {
    const { appendRecords } = await loadPool(dir)
    writeFileSync(shardFile(0), JSON.stringify([record('bbbbbbbbbbb')]))
    expect(appendRecords([record('aaaaaaaaaaa')], 1)).toBe(2)
    const shard = JSON.parse(readFileSync(shardFile(0), 'utf8'))
    expect(shard.map((r) => r.id)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa'])
  })

  it('rolls over into a second shard at the size boundary', async () => {
    const { appendRecords, SHARD_SIZE } = await loadPool(dir)
    const full = Array.from({ length: SHARD_SIZE }, (_, i) =>
      record(String(i).padStart(11, 'a')),
    )
    writeFileSync(shardFile(0), JSON.stringify(full))
    expect(appendRecords([record('zzzzzzzzzzz')], SHARD_SIZE)).toBe(
      SHARD_SIZE + 1,
    )
    expect(existsSync(shardFile(1))).toBe(true)
    // Shard 0 is immutable — still exactly full, still the same records.
    expect(JSON.parse(readFileSync(shardFile(0), 'utf8'))).toHaveLength(
      SHARD_SIZE,
    )
    expect(JSON.parse(readFileSync(shardFile(1), 'utf8'))).toHaveLength(1)
  })
})
