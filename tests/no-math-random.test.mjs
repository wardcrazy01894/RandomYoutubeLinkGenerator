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

  // Guards the guard. A file COUNT is not enough: scripts/ alone has enough files to
  // satisfy any floor, so dropping 'src' from SCANNED left the client-side randomness
  // unscanned while the suite stayed green. Assert the specific files that matter are
  // actually being read.
  it('actually scans the randomness-critical files', () => {
    const relative = files.map((f) => f.slice(ROOT.length))
    for (const sentinel of [
      'src/random.ts', // the client CSPRNG draw
      'src/pool.ts', // the uniform pick
      'scripts/lib/prefix.mjs', // the Feistel sampler
      'scripts/harvest.mjs',
    ]) {
      expect(relative).toContain(sentinel)
    }
    for (const dir of SCANNED) {
      expect(
        files.filter((f) => f.startsWith(join(ROOT, dir))).length,
      ).toBeGreaterThan(1)
    }
  })

  it.each(SCANNED)('finds no Math.random under %s/', (dirName) => {
    const offenders = files
      .filter((f) => f.startsWith(join(ROOT, dirName)))
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length))
    expect(offenders).toEqual([])
  })

  // Makes CLAUDE.md's claim that BOTH layers are mutation-verified literally true: the
  // lint selectors are config, and a typo in any of them would otherwise fail nothing.
  it('has lint selectors that actually fire, for every accidental form', async () => {
    const { ESLint } = await import('eslint')
    const linter = new ESLint({ cwd: ROOT })
    const offending = [
      'export const a = Math.random()',
      "export const b = Math['random']()",
      'export const c = globalThis.Math.random()',
      'const M = Math\nexport const d = M.random()',
      'const { random } = Math\nexport const e = random()',
    ]
    for (const code of offending) {
      const [res] = await linter.lintText(`${code}\n`, {
        filePath: 'probe.mjs',
      })
      expect(res.errorCount, `should be rejected: ${code}`).toBeGreaterThan(0)
    }
    const [clean] = await linter.lintText(
      'export const ok = Math.floor(1.5)\n',
      {
        filePath: 'probe.mjs',
      },
    )
    expect(clean.errorCount, 'Math.floor must stay legal').toBe(0)
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
