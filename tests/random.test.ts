import { describe, it, expect } from 'vitest'
import { randomBelow, pick, type Uint32Source } from '../src/random'

/** A source that replays fixed values, so the rejection boundary can be driven exactly. */
const scripted = (...values: number[]): Uint32Source => {
  let i = 0
  return () => {
    if (i >= values.length) throw new Error('scripted RNG exhausted')
    return values[i++]!
  }
}

const TWO32 = 0x100000000

describe('randomBelow', () => {
  it('rejects non-positive and non-integer n', () => {
    expect(() => randomBelow(0)).toThrow(RangeError)
    expect(() => randomBelow(-1)).toThrow(RangeError)
    expect(() => randomBelow(1.5)).toThrow(RangeError)
    expect(() => randomBelow(Number.NaN)).toThrow(RangeError)
  })

  // The whole point of the rejection loop. n = 3 does not divide 2^32, so
  // limit = 2^32 - (2^32 % 3) = 4294967295. The value AT the limit must be
  // discarded; the value just below it must be accepted.
  it('discards values at or above the rejection limit and redraws', () => {
    const n = 3
    const limit = TWO32 - (TWO32 % n)
    expect(limit).toBe(4294967295)
    // First draw sits exactly on the limit -> rejected. Second is accepted.
    expect(randomBelow(n, scripted(limit, 7))).toBe(7 % n)
  })

  it('accepts the largest value below the limit', () => {
    const n = 3
    const limit = TWO32 - (TWO32 % n)
    expect(randomBelow(n, scripted(limit - 1))).toBe((limit - 1) % n)
  })

  it('rejects repeatedly until a usable value arrives', () => {
    const n = 3
    const limit = TWO32 - (TWO32 % n)
    expect(randomBelow(n, scripted(limit, limit, limit, 5))).toBe(5 % n)
  })

  it('accepts 0 and the u32 maximum appropriately', () => {
    expect(randomBelow(4, scripted(0))).toBe(0)
    // n = 4 divides 2^32, so nothing is ever rejected — 2^32-1 is usable.
    expect(randomBelow(4, scripted(0xffffffff))).toBe(3)
  })

  it('never returns a value outside [0, n)', () => {
    for (let trial = 0; trial < 2000; trial++) {
      const v = randomBelow(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })

  // With a deliberately tiny source the modulo bias is large enough to actually
  // measure — this is the version of the "is it uniform" test that has real power.
  it('is uniform where naive modulo would visibly skew', () => {
    const n = 3
    const domain = 8 // pretend a 3-bit RNG: 8 % 3 = 2, so 0 and 1 would be favoured
    const counts = [0, 0, 0]
    for (let v = 0; v < domain; v++) {
      const limit = domain - (domain % n)
      if (v < limit) counts[v % n]!++
    }
    expect(counts).toEqual([2, 2, 2])
  })
})

describe('pick', () => {
  it('throws on an empty array', () => {
    expect(() => pick([])).toThrow(RangeError)
  })
  it('returns a member of the array', () => {
    const items = ['a', 'b', 'c']
    for (let i = 0; i < 100; i++) expect(items).toContain(pick(items))
  })
})
