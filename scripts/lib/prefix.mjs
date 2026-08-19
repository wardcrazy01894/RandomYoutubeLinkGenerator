// Prefix space for dash-token sampling.
//
// See docs/DESIGN.md §3.2-3.4. Two facts drive everything here:
//
//  1. YouTube's search tokenizer splits video IDs on '-' (and only '-'; '_' does not
//     split). The segment before the first dash is an indexed, case-insensitively
//     matched token. So a k-char query retrieves the bucket of videos whose ID begins
//     `<query>-`.
//
//  2. A video ID's 11th character is restricted to 16 of the 64 base64url values,
//     because it encodes only 4 bits. That matters: a query whose LAST character
//     case-folds into that set also matches as the *trailing* token of IDs shaped
//     `XXXXXX-qqqq`. Those competitors outnumber the bucket we want roughly 4:1 and
//     fight for the same result slots — and truncation is relevance-ranked, so the
//     survivors skew popular. That is the exact bias this method exists to avoid, so
//     we forbid those characters in the final position.

import { createHmac } from 'node:crypto'

/** Case-folded base64url minus '-': 26 letters + 10 digits + '_'. */
export const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_'

/**
 * The 16 values a video ID's 11th character can take, case-folded.
 * Canonical set: A E I M Q U Y c g k o s w 0 4 8.
 */
export const LAST_CHAR_CLASSES = 'aeimquycgkosw048'

/** The 21 classes that CANNOT be an 11th character — legal for our final position. */
export const TAIL_ALPHABET = [...PREFIX_ALPHABET]
  .filter((c) => !LAST_CHAR_CLASSES.includes(c))
  .join('')

/**
 * Prefix length.
 *
 * Chosen empirically against the Data API, not by arithmetic (docs/DESIGN.md §3.7):
 *   k=4 -> ~41 members/bucket, but 0/12 buckets could be proven exhausted. A bucket
 *          truncated at rank 50 is truncated in RELEVANCE order, so the survivors
 *          skew popular — the exact bias this method exists to avoid. Disqualified.
 *   k=5 -> ~5 members/bucket, ~83% of buckets exhaustible in a single page. Chosen.
 *   k=6 -> ~0.25 members/bucket, always exhaustible but wastes 100 units per video.
 */
export const PREFIX_LENGTH = 5

const HEAD = PREFIX_ALPHABET.length // 37
const TAIL = TAIL_ALPHABET.length // 21

/** Total distinct prefixes: 37^(k-1) * 21. */
export const PREFIX_SPACE = HEAD ** (PREFIX_LENGTH - 1) * TAIL

/**
 * Map an index in [0, PREFIX_SPACE) to its prefix string.
 * First k-1 characters are base-37; the final character is base-21 (see above).
 */
export function prefixFromIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= PREFIX_SPACE) {
    throw new RangeError(`prefix index out of range: ${index}`)
  }
  let n = index
  const tail = TAIL_ALPHABET[n % TAIL]
  n = Math.floor(n / TAIL)
  let head = ''
  for (let i = 0; i < PREFIX_LENGTH - 1; i++) {
    head = PREFIX_ALPHABET[n % HEAD] + head
    n = Math.floor(n / HEAD)
  }
  return head + tail
}

// --- Feistel permutation over the prefix space ------------------------------
//
// We enumerate prefixes in a pseudorandom order WITHOUT replacement, so the
// harvester never re-draws a bucket by accident and its entire state is one
// integer counter in git (docs/DESIGN.md §3.4).
//
// A 4-round balanced Feistel network is a bijection on [0, 2^26). Cycle-walking
// (re-encrypting any output >= PREFIX_SPACE until it lands in range) restricts
// that bijection to [0, PREFIX_SPACE) while keeping it a bijection. Expected
// ~1.7 iterations per call, which is free at our volumes.

const HALF_BITS = 13
const HALF_MASK = (1 << HALF_BITS) - 1
const BLOCK = 1 << (HALF_BITS * 2) // 2^26 = 67,108,864, the smallest power of 4 above PREFIX_SPACE
const ROUNDS = 4

function roundFn(key, round, value) {
  const h = createHmac('sha256', key)
  h.update(
    Uint8Array.from([
      round,
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
    ]),
  )
  return h.digest().readUInt16BE(0) & HALF_MASK
}

function feistel(key, input) {
  let left = (input >> HALF_BITS) & HALF_MASK
  let right = input & HALF_MASK
  for (let r = 0; r < ROUNDS; r++) {
    const next = left ^ roundFn(key, r, right)
    left = right
    right = next
  }
  return ((left << HALF_BITS) | right) >>> 0
}

/**
 * The n-th prefix index in the keyed pseudorandom enumeration order.
 * Bijective over [0, PREFIX_SPACE): distinct n always yield distinct prefixes.
 */
export function prefixIndexAt(key, n) {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`counter must be a non-negative integer: ${n}`)
  if (n >= PREFIX_SPACE)
    throw new RangeError(`prefix space exhausted at ${PREFIX_SPACE}`)
  let x = n % BLOCK
  // Cycle-walk until we land inside the real domain.
  for (let guard = 0; guard < 1000; guard++) {
    x = feistel(key, x)
    if (x < PREFIX_SPACE) return x
  }
  throw new Error(
    'cycle-walking failed to converge — this should be impossible',
  )
}

/** Convenience: the n-th prefix string in enumeration order. */
export function prefixAt(key, n) {
  return prefixFromIndex(prefixIndexAt(key, n))
}
