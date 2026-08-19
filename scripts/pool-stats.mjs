#!/usr/bin/env node
// Regenerates the measured numbers in docs/RANDOMNESS.md.
//
// Those numbers are the project's central claim, so they are computed from the actual
// pool rather than typed by hand — a hand-typed statistic rots the first time the pool
// grows, and a rotted randomness claim is worse than no claim.

import {
  readManifest,
  readShard,
  readTombstones,
  readBlocklist,
  SHARD_SIZE,
} from './lib/pool.mjs'
import { PREFIX_SPACE, PREFIX_LENGTH } from './lib/prefix.mjs'

const manifest = readManifest()
const dead = new Set([...readTombstones().ids, ...readBlocklist().ids])
const records = []
for (let i = 0; i < Math.ceil(manifest.total / SHARD_SIZE); i++)
  records.push(...readShard(i))
const live = records.filter((r) => !dead.has(r.id))

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)
const median = (xs) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const views = live.map((r) => r.v)
const years = {}
for (const r of live) {
  if (!r.pub) continue
  const y = new Date(r.pub).getFullYear()
  years[y] = (years[y] ?? 0) + 1
}

// Corpus estimate. P(first dash at position k+1) for a k-char prefix.
const P = Math.pow(63 / 64, PREFIX_LENGTH) * (1 / 64)
const buckets = manifest.stats?.bucketsEverDrawn ?? 0
const yieldPer = manifest.health?.yield ?? null
const corpus = yieldPer ? (yieldPer * PREFIX_SPACE) / P : null

console.log(`# Pool statistics

Pool:            ${manifest.total} harvested, ${live.length} live, ${dead.size} tombstoned/blocked
Buckets drawn:   ${buckets} of ${PREFIX_SPACE.toLocaleString()} (${pct(buckets, PREFIX_SPACE)} of the space)
Yield:           ${yieldPer ? yieldPer.toFixed(2) : '—'} videos/bucket
Last harvest:    ${manifest.generatedAt ?? 'never'} (${manifest.health?.status ?? 'unknown'})

Median views:    ${median(views)}
Mean views:      ${views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0}
Zero-view:       ${pct(views.filter((v) => v === 0).length, views.length)}
Under 100 views: ${pct(views.filter((v) => v < 100).length, views.length)}

Embeddable:      ${pct(live.filter((r) => r.emb).length, live.length)}
Age-restricted:  ${pct(live.filter((r) => r.age).length, live.length)}
Made for kids:   ${pct(live.filter((r) => r.mfk).length, live.length)}

Upload years:
${Object.entries(years)
  .sort()
  .map(([y, n]) => `  ${y}  ${String(n).padStart(6)}  ${pct(n, live.length)}`)
  .join('\n')}

Corpus estimate (LOWER BOUND on token-indexed searchable videos):
  ${corpus ? corpus.toExponential(2) : '—'}
  Not publishable until >= 2000 buckets have been drawn (currently ${buckets}).
`)
