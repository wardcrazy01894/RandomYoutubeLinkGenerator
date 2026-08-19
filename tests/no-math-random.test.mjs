import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

  // The lint layer is config, so a typo in any selector — or a later block redefining
  // the rule for some path — would otherwise fail nothing in CI. This is what makes
  // CLAUDE.md's claim about scoping hold.
  it('has lint selectors that actually fire, in every guarded tree', async () => {
    const { ESLint } = await import('eslint')
    const linter = new ESLint({ cwd: ROOT })
    const offending = [
      'export const aa = Math.random()',
      "export const bb = Math['random']()",
      'export const cc = globalThis.Math.random()',
      'const MM = Math\nexport const dd = MM.random()',
      'const { random } = Math\nexport const ee = random()',
    ]
    // Probes are DERIVED from the scanned tree, not hardcoded. Flat config is
    // later-wins per rule, so a block scoped to any subdirectory silently deletes these
    // selectors there — and a fixed probe list only covers the directories someone
    // happened to think of. Hardcoding src/ and scripts/ missed scripts/lib/, which is
    // where the Feistel sampler lives: a block scoped to `scripts/lib/**` disarmed the
    // guard for the sampler while every test stayed green.
    const probeDirs = [ROOT, ...new Set(files.map((f) => dirname(f)))]
    const probes = probeDirs.flatMap((d) => [
      join(d, '__probe.ts'),
      join(d, '__probe.mjs'),
    ])

    // Assert on the RULE, not errorCount: an unrelated rule firing would otherwise make
    // a completely dead guard look alive, and an unrelated rule on the clean sample
    // would look like the guard had broken.
    const banned = (res) =>
      res.messages.filter((m) => m.ruleId === 'no-restricted-syntax')

    for (const filePath of probes) {
      for (const code of offending) {
        const [res] = await linter.lintText(`${code}\n`, { filePath })
        expect(
          banned(res),
          `should be rejected in ${filePath}: ${code}`,
        ).not.toEqual([])
      }
      const [clean] = await linter.lintText(
        'export const ok = Math.floor(1.5)\n',
        { filePath },
      )
      expect(
        banned(clean),
        `Math.floor must stay legal in ${filePath}`,
      ).toEqual([])
    }
  })

  it('detects the patterns it claims to detect', () => {
    // Without this, a typo in FORBIDDEN would make the suite pass for the wrong reason.
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
