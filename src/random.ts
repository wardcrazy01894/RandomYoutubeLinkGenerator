// Unbiased random integers.
//
// `crypto.getRandomValues(u32) % n` is biased whenever n does not divide 2^32: the
// first `2^32 % n` values are reachable by one extra u32 each. The bias is tiny
// (~n/2^32) but it is exactly the kind of silent defect this project exists not to
// have, so we reject-and-resample instead.
//
// docs/DESIGN.md §4.2 explains why this is NOT tested with a chi-square: the bias is
// ~2e-5 and would need ~1e10 samples to detect, while a chi-square over a CSPRNG is
// ~5% flaky by construction. The tests drive the rejection boundary directly instead.

/** Source of 32-bit values. Injectable so tests can drive the rejection boundary. */
export type Uint32Source = () => number

export const cryptoSource: Uint32Source = () => {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0]!
}

/**
 * A uniformly distributed integer in [0, n), with no modulo bias.
 * @throws RangeError if n is not a positive integer within u32 range.
 */
export function randomBelow(
  n: number,
  source: Uint32Source = cryptoSource,
): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`randomBelow requires a positive integer, got ${n}`)
  }
  if (n > 0x100000000) {
    throw new RangeError(`randomBelow supports n <= 2^32, got ${n}`)
  }
  // Largest multiple of n that fits in u32. Values at or above it would skew the
  // distribution, so they are discarded and redrawn.
  const limit = 0x100000000 - (0x100000000 % n)
  for (;;) {
    const value = source() >>> 0
    if (value < limit) return value % n
  }
}

/** Uniform element of a non-empty array. */
export function pick<T>(
  items: readonly T[],
  source: Uint32Source = cryptoSource,
): T {
  if (items.length === 0)
    throw new RangeError('cannot pick from an empty array')
  return items[randomBelow(items.length, source)]!
}
