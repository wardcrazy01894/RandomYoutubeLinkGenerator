import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(
  new URL('../scripts/merge-tombstones.mjs', import.meta.url),
)
const id = (n) => `vid${String(n).padStart(8, '0')}`

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tomb-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (name, doc) => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(doc))
  return p
}
const run = (base, add) => {
  const out = join(dir, 'out.json')
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--base', base, '--add', add, '--out', out],
    {
      encoding: 'utf8',
    },
  )
  return { ...r, out, doc: () => JSON.parse(readFileSync(out, 'utf8')) }
}

describe('merge-tombstones', () => {
  // The bug this exists for: a sweep wrote tombstones onto the pool branch, then the
  // post-promotion reset copied main's pool over them and they were gone. The next
  // promotion put those deleted videos back in front of viewers.
  it('keeps ids that exist only in the file being copied over', () => {
    const base = write('base.json', { ids: [id(1)], note: 'main' })
    const add = write('add.json', { ids: [id(2), id(3)], note: 'branch' })
    const r = run(base, add)
    expect(r.status).toBe(0)
    expect(r.doc().ids).toEqual([id(1), id(2), id(3)])
  })

  it('never drops an id from either side, whichever way round they are', () => {
    const a = { ids: [id(1), id(2)], note: 'a' }
    const b = { ids: [id(2), id(9)], note: 'b' }
    const one = run(write('a.json', a), write('b.json', b)).doc().ids
    const two = run(write('b2.json', b), write('a2.json', a)).doc().ids
    expect(one).toEqual(two)
    expect(one).toEqual([id(1), id(2), id(9)])
  })

  it('deduplicates rather than accumulating', () => {
    const base = write('base.json', { ids: [id(1), id(1)], note: 'n' })
    const add = write('add.json', { ids: [id(1)], note: 'n' })
    expect(run(base, add).doc().ids).toEqual([id(1)])
  })

  // main is authoritative for prose the same way it is for blocklist.json. The branch
  // carried a stale note claiming embeddability is tombstoned, which the code
  // deliberately does not do.
  it('keeps the base note, not the incoming one', () => {
    const base = write('base.json', { ids: [], note: 'the accurate one' })
    const add = write('add.json', { ids: [], note: 'the stale one' })
    expect(run(base, add).doc().note).toBe('the accurate one')
  })

  it('treats a missing add file as nothing to add, not as an error', () => {
    const base = write('base.json', { ids: [id(4)], note: 'n' })
    const r = run(base, join(dir, 'does-not-exist.json'))
    expect(r.status).toBe(0)
    expect(r.doc().ids).toEqual([id(4)])
  })

  // Failing loudly matters more than succeeding here: silently writing {ids:[]} over a
  // real tombstone file is the exact data loss this script exists to prevent.
  it('refuses a missing base rather than writing an empty file', () => {
    const add = write('add.json', { ids: [id(5)], note: 'n' })
    const r = run(join(dir, 'nope.json'), add)
    expect(r.status).not.toBe(0)
  })

  it('refuses malformed JSON rather than silently emptying the list', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{not json')
    const r = run(p, write('add.json', { ids: [], note: 'n' }))
    expect(r.status).not.toBe(0)
  })

  it('refuses an id that is not a YouTube id', () => {
    const base = write('base.json', { ids: ['../../etc/passwd'], note: 'n' })
    const r = run(base, write('add.json', { ids: [], note: 'n' }))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/malformed id/)
  })

  it('refuses a file with no ids array', () => {
    const base = write('base.json', { note: 'n' })
    expect(
      run(base, write('add.json', { ids: [], note: 'n' })).status,
    ).not.toBe(0)
  })
})
