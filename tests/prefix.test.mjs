import { describe, it, expect } from 'vitest'
import {
  PREFIX_ALPHABET,
  TAIL_ALPHABET,
  LAST_CHAR_CLASSES,
  PREFIX_SPACE,
  PREFIX_LENGTH,
  prefixFromIndex,
  prefixIndexAt,
  prefixAt,
} from '../scripts/lib/prefix.mjs'

describe('prefix alphabet', () => {
  it('has 37 case-folded non-dash classes', () => {
    expect(PREFIX_ALPHABET.length).toBe(37)
    expect(PREFIX_ALPHABET).not.toContain('-')
  })

  // The last-token collision fix (docs/DESIGN.md §3.3.2). If any tail character could
  // also be an ID's 11th character, queries would match trailing tokens and pull in
  // ~4x relevance-ranked competitors — reintroducing popularity bias.
  it('excludes every possible 11th-character class from the tail alphabet', () => {
    expect(TAIL_ALPHABET.length).toBe(21)
    for (const c of TAIL_ALPHABET) expect(LAST_CHAR_CLASSES).not.toContain(c)
    for (const c of LAST_CHAR_CLASSES) expect(TAIL_ALPHABET).not.toContain(c)
  })

  it('sizes the prefix space as 37^(k-1) * 21', () => {
    expect(PREFIX_SPACE).toBe(37 ** (PREFIX_LENGTH - 1) * 21)
    expect(PREFIX_SPACE).toBe(39_357_381)
  })
})

describe('prefixFromIndex', () => {
  it('rejects out-of-range indices', () => {
    expect(() => prefixFromIndex(-1)).toThrow(RangeError)
    expect(() => prefixFromIndex(PREFIX_SPACE)).toThrow(RangeError)
  })

  it('always produces a legal prefix', () => {
    for (const i of [0, 1, 999, 500_000, PREFIX_SPACE - 1]) {
      const p = prefixFromIndex(i)
      expect(p).toHaveLength(PREFIX_LENGTH)
      expect(TAIL_ALPHABET).toContain(p.at(-1))
      for (const c of p.slice(0, -1)) expect(PREFIX_ALPHABET).toContain(c)
    }
  })

  it('is injective', () => {
    const seen = new Set()
    for (let i = 0; i < 5000; i++) seen.add(prefixFromIndex(i))
    expect(seen.size).toBe(5000)
  })
})

describe('prefixIndexAt (without-replacement enumeration)', () => {
  it('never repeats a bucket', () => {
    const seen = new Set()
    for (let n = 0; n < 30_000; n++) seen.add(prefixIndexAt('k', n))
    expect(seen.size).toBe(30_000)
  })

  it('stays inside the prefix space', () => {
    for (let n = 0; n < 5000; n++) {
      const i = prefixIndexAt('k', n)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(PREFIX_SPACE)
    }
  })

  it('is deterministic for a key and differs between keys', () => {
    expect(prefixAt('key-a', 42)).toBe(prefixAt('key-a', 42))
    const a = Array.from({ length: 50 }, (_, n) => prefixAt('key-a', n))
    const b = Array.from({ length: 50 }, (_, n) => prefixAt('key-b', n))
    expect(a).not.toEqual(b)
  })

  it('refuses to run past the end of the space', () => {
    expect(() => prefixIndexAt('k', PREFIX_SPACE)).toThrow(RangeError)
    expect(() => prefixIndexAt('k', -1)).toThrow(RangeError)
  })
})
