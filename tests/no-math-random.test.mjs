import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Defence in depth for the project's central claim.
//
// The lint rule (eslint.config.js) is the primary guard, but it is config: it can be
// narrowed, scoped to the wrong files, or silently stop matching — all three of which
// have already happened here once. The rule previously applied only to src/**/*.ts, so
// scripts/lib/prefix.mjs (the Feistel sampler) was unguarded, and its companion
// no-restricted-globals entry never fired at all.
//
// This test does not care about AST selectors or config layering. It reads the source
// and asserts the text is not there.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCANNED = ['src', 'scripts']
const EXTENSIONS = ['.ts', '.mjs', '.js']

/** Math.random, Math['random'], Math [ "random" ] — with arbitrary whitespace. */
const FORBIDDEN = /Math\s*(?:\.\s*random\b|\[\s*['"`]random['"`]\s*\])/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

describe('Math.random is absent from the randomness-critical source', () => {
  const files = SCANNED.flatMap((d) => walk(join(ROOT, d)))

  it('scans a non-trivial number of files', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(SCANNED)('finds no Math.random under %s/', (dirName) => {
    const offenders = files
      .filter((f) => f.startsWith(join(ROOT, dirName)))
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length))
    expect(offenders).toEqual([])
  })

  it('detects the patterns it claims to detect', () => {
    // Without this, a typo in FORBIDDEN would make the suite pass for the wrong reason.
    for (const sample of [
      'const x = Math.random()',
      "const x = Math['random']()",
      'const x = Math . random ()',
      'const x = Math[ "random" ]()',
    ]) {
      expect(FORBIDDEN.test(sample)).toBe(true)
    }
    for (const ok of ['Math.floor(1.5)', 'Math.min(a, b)', 'randomBelow(10)']) {
      expect(FORBIDDEN.test(ok)).toBe(false)
    }
  })
})
