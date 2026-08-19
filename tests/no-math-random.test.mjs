import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Defence in depth for the project's central claim.
//
// The lint rule is CONFIG, and config has been wrong here in five distinct ways already:
// scoped to src/**/*.ts only (the Feistel sampler unguarded); a companion rule that was
// dead and never fired; disarmed per-directory, per-filename, per-extension, and via
// `ignores`; and — the subtlest — kept at severity 2 with the right NUMBER of selectors
// but four entirely different ones, leaving `Math.random()` live in src/random.ts with
// every gate green.
//
// So this file does not inspect the config's shape. It asks what ESLint actually DOES to
// every file it lints, and separately scans the source as text.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// `public` is included: it is ESLint-ignored under public/data, so a source file there
// would be invisible to the lint layer entirely. NOTE: do not add 'tests' — this file and
// eslint.config.js both contain a literal `const M = Math` in their prose, so the scan
// would flag itself.
const SCANNED = ['src', 'scripts', 'public']
const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
]

/** Math.random, Math?.random, Math['random'] — with arbitrary whitespace. */
const FORBIDDEN = /Math\s*(?:\??\s*\.\s*random\b|\[\s*['"`]random['"`]\s*\])/

// Alias form is otherwise covered ONLY by the lint selectors, which makes this layer
// depend on how ESLint happens to be invoked: narrowing `npm run lint` from `eslint .`
// to `eslint src` stops CI linting scripts/ at all, and an aliased Math.random in the
// Feistel sampler then passes both layers. Detecting the alias here keeps layer 2
// independent of any ESLint invocation.
// Deliberately narrow: `Math` must not be followed by `.`, `[` or a word character, so
// `Math.floor(...)` and `Mathematics` do not match.
const ALIAS_FORMS = [
  /(?:const|let|var)\s+[\w$]+\s*=\s*Math\s*(?![.[\w$])/,
  /(?:const|let|var)\s*\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/,
]
const forbidden = (text) =>
  FORBIDDEN.test(text) || ALIAS_FORMS.some((re) => re.test(text))

// Every accidental form, in one snippet. Each line must draw its own complaint.
const OFFENDING = [
  // Prepended deliberately: if a later block re-enables inline config for some glob,
  // this comment silences the rule there and the file reports zero hits. A separate
  // test pinned to one path could not see that — the same hardcoded-probe blind spot
  // this file exists to avoid.
  '/* eslint-disable no-restricted-syntax */',
  'export const aa = Math.random()',
  "export const bb = Math['random']()",
  'export const cc = globalThis.Math.random()',
  'const MM = Math',
  'const { random } = Math',
].join('\n')

// `public` is deliberately NOT skipped: public/data is ESLint-ignored, so a source file
// there would be invisible to both layers. Nothing lives there today, so walking it costs
// nothing.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

const sourceFiles = SCANNED.flatMap((d) => walk(join(ROOT, d)))
// Everything in the repo ESLint ought to be linting, so a NEW top-level directory is
// covered without anyone remembering to extend a list.
const repoFiles = walk(ROOT)
const rel = (f) => f.slice(ROOT.length)

describe('Math.random is absent from the randomness-critical source', () => {
  it('actually scans the randomness-critical files', () => {
    const names = sourceFiles.map(rel)
    for (const sentinel of [
      'src/random.ts', // the client CSPRNG draw
      'src/pool.ts', // the uniform pick
      'scripts/lib/prefix.mjs', // the Feistel sampler
      'scripts/harvest.mjs',
    ]) {
      expect(names).toContain(sentinel)
    }
  })

  // The load-bearing test. Asserting on config shape (severity, selector COUNT) is not
  // enough — four unrelated selectors at severity 2 satisfied that while Math.random ran
  // free. This lints the real forms against every file ESLint actually lints.
  it('rejects every accidental form in every file ESLint lints', async () => {
    const { ESLint } = await import('eslint')
    const linter = new ESLint({ cwd: ROOT })

    const linted = (await linter.lintFiles(['.'])).map((r) => r.filePath)
    expect(
      linted.length,
      'ESLint linted nothing — the check would be vacuous',
    ).toBeGreaterThan(5)

    // A source file missing from ESLint's own list means it was ignored out of linting
    // entirely, which is how `ignores` silently removed the sampler.
    for (const file of repoFiles) {
      expect(linted, `${rel(file)} is not linted at all`).toContain(file)
    }

    const unguarded = []
    for (const filePath of linted) {
      const [res] = await linter.lintText(`${OFFENDING}\n`, {
        filePath,
        warnIgnored: false,
      })
      const hits = res.messages.filter(
        (m) => m.ruleId === 'no-restricted-syntax' && m.severity === 2,
      )
      if (hits.length < 5) unguarded.push(`${rel(filePath)} (${hits.length}/5)`)
    }
    expect(
      unguarded,
      'Math.random guard is not enforced for these files',
    ).toEqual([])
  })

  it.each(SCANNED)('finds no Math.random under %s/', (dirName) => {
    const offenders = sourceFiles
      .filter((f) => f.startsWith(join(ROOT, dirName)))
      .filter((f) => forbidden(readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('detects the patterns it claims to detect', () => {
    for (const sample of [
      'const M = Math',
      'const { random } = Math',
      'const x = Math.random()',
      "const x = Math['random']()",
      'const x = Math . random ()',
      'const x = Math[ "random" ]()',
      'const x = Math?.random()',
    ]) {
      expect(forbidden(sample), `should be detected: ${sample}`).toBe(true)
    }
    // Legitimate Math usage must stay clean, or the layer becomes noise people disable.
    for (const ok of [
      'Math.floor(1.5)',
      'Math.min(a, b)',
      'randomBelow(10)',
      'const x = Math.floor(n / K)',
      'const limit = 2 ** 32 - (2 ** 32 % n)',
    ]) {
      expect(forbidden(ok), `must not be flagged: ${ok}`).toBe(false)
    }
  })
})
