import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Defence in depth for the project's central claim.
//
// The lint rule in eslint.config.js is the primary guard, but it is CONFIG: it can be
// narrowed, scoped away, or ignored out of existence. That has already happened once —
// the rule lived inside a `files: ['src/**/*.ts']` block, leaving scripts/lib/prefix.mjs
// (the Feistel sampler) unguarded — so this file checks it rather than trusting it.
//
// Two checks, deliberately different in kind:
//   1. Resolve ESLint's ACTUAL config for every real source file and assert the guard is
//      active there. Earlier versions linted synthetic probe paths instead, which only
//      ever cover globs someone anticipated: blocks scoped to `scripts/**/prefix.mjs` or
//      `**/*.js`, and `ignores` entries, all slipped past while the suite stayed green.
//   2. Scan the same files as text, which holds even if the lint layer is bypassed by an
//      inline eslint-disable comment.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCANNED = ['src', 'scripts']
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js']

/** Math.random, Math?.random, Math['random'] — with arbitrary whitespace. */
const FORBIDDEN = /Math\s*(?:\??\s*\.\s*random\b|\[\s*['"`]random['"`]\s*\])/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

const files = SCANNED.flatMap((d) => walk(join(ROOT, d)))
const rel = (f) => f.slice(ROOT.length)

describe('Math.random is absent from the randomness-critical source', () => {
  it('actually scans the randomness-critical files', () => {
    // Guards the guard. A file COUNT is not enough: scripts/ alone satisfies any floor,
    // so dropping 'src' would leave the client-side draw unscanned while staying green.
    const names = files.map(rel)
    for (const sentinel of [
      'src/random.ts', // the client CSPRNG draw
      'src/pool.ts', // the uniform pick
      'scripts/lib/prefix.mjs', // the Feistel sampler
      'scripts/harvest.mjs',
    ]) {
      expect(names).toContain(sentinel)
    }
  })

  // Asks ESLint what it will actually do to each real file, rather than probing paths we
  // invented. This is what catches file-glob scoping, extension scoping and `ignores`.
  it('has the guard active in the resolved config for every source file', async () => {
    const { ESLint } = await import('eslint')
    const linter = new ESLint({ cwd: ROOT })

    for (const file of files) {
      expect(
        await linter.isPathIgnored(file),
        `${rel(file)} is not linted at all`,
      ).toBe(false)
      const config = await linter.calculateConfigForFile(file)
      const rule = config.rules['no-restricted-syntax']
      // A bare 'off' in a later block merges with the EARLIER options array, so the
      // selectors are still listed while the rule is disabled. Severity is the only
      // reliable signal — checking the selector count alone would pass under that attack.
      const severity = Array.isArray(rule) ? rule[0] : rule
      expect(severity, `Math.random guard is disarmed for ${rel(file)}`).toBe(2)
      expect(
        rule.length - 1,
        `selectors were dropped for ${rel(file)}`,
      ).toBeGreaterThanOrEqual(4)
    }
  })

  it('has selectors that actually reject every accidental form', async () => {
    const { ESLint } = await import('eslint')
    const linter = new ESLint({ cwd: ROOT })
    const offending = [
      'export const aa = Math.random()',
      "export const bb = Math['random']()",
      'export const cc = globalThis.Math.random()',
      'const MM = Math\nexport const dd = MM.random()',
      'const { random } = Math\nexport const ee = random()',
    ]
    // Linted as a real, tracked file so the config resolution is the real one.
    const filePath = join(ROOT, 'scripts', 'lib', 'prefix.mjs')
    const banned = (res) =>
      res.messages.filter((m) => m.ruleId === 'no-restricted-syntax')

    for (const code of offending) {
      const [res] = await linter.lintText(`${code}\n`, {
        filePath,
        warnIgnored: false,
      })
      expect(banned(res), `should be rejected: ${code}`).not.toEqual([])
    }
    const [clean] = await linter.lintText(
      'export const ok = Math.floor(1.5)\n',
      {
        filePath,
        warnIgnored: false,
      },
    )
    expect(banned(clean), 'Math.floor must stay legal').toEqual([])
  })

  it.each(SCANNED)('finds no Math.random under %s/', (dirName) => {
    const offenders = files
      .filter((f) => f.startsWith(join(ROOT, dirName)))
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('detects the patterns it claims to detect', () => {
    for (const sample of [
      'const x = Math.random()',
      "const x = Math['random']()",
      'const x = Math . random ()',
      'const x = Math[ "random" ]()',
      'const x = Math?.random()',
    ]) {
      expect(FORBIDDEN.test(sample)).toBe(true)
    }
    for (const ok of ['Math.floor(1.5)', 'Math.min(a, b)', 'randomBelow(10)']) {
      expect(FORBIDDEN.test(ok)).toBe(false)
    }
  })
})
