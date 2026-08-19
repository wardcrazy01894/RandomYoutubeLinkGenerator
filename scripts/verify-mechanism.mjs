#!/usr/bin/env node
// VERIFICATION GATE — docs/DESIGN.md §3.1.
//
// Every measurement behind this project was taken against YouTube's WEB search. The
// harvester queries the Data API, which is a different surface and may tokenize
// differently. Nothing downstream is trustworthy until this passes.
//
// Three things are checked:
//   1. Dash-token retrieval  — does q="my8exz" return the video "my8EXZ-mqpQ"?
//   2. Case-insensitivity    — does it work with the query in the wrong case?
//   3. Random-prefix yield   — what is the real videos-per-bucket at k=4?
//
// Usage: YOUTUBE_API_KEY=... node scripts/verify-mechanism.mjs [numProbes]

import { randomInt } from 'node:crypto'
import { searchPage } from './lib/youtube.mjs'
import { prefixAt, PREFIX_SPACE, PREFIX_LENGTH } from './lib/prefix.mjs'
import { loadKey } from './lib/env.mjs'

// Real IDs observed in the wild, each with a dash-delimited leading token.
const KNOWN = [
  { token: 'my8exz', id: 'my8EXZ-mqpQ' },
  { token: '7cbrv9h', id: '7Cbrv9h-0cY' },
  { token: 'xvp3n9h', id: 'xVp3N9h-DQY' },
]

const key = loadKey()
const probes = Number(process.argv[2] ?? 25)
let failures = 0

console.log('=== 1. dash-token retrieval (exact case as observed) ===')
for (const { token, id } of KNOWN) {
  const { ids, totalResults } = await searchPage(key, token)
  const hit = ids.includes(id)
  console.log(
    `  q=${token.padEnd(9)} -> ${ids.length} ids, total~${totalResults}, target ${hit ? 'FOUND' : 'MISSING'}`,
  )
  if (!hit) failures++
}

console.log('\n=== 2. case-insensitivity ===')
for (const { token, id } of KNOWN) {
  const upper = token.toUpperCase()
  const { ids } = await searchPage(key, upper)
  const hit = ids.includes(id)
  console.log(`  q=${upper.padEnd(9)} -> target ${hit ? 'FOUND' : 'MISSING'}`)
  if (!hit) failures++
}

console.log(
  `\n=== 3. random-prefix yield at k=${PREFIX_LENGTH} (${probes} probes) ===`,
)
let matched = 0
let pagesAtCap = 0
for (let i = 0; i < probes; i++) {
  const q = prefixAt('verify', randomInt(PREFIX_SPACE))
  const { ids, totalResults } = await searchPage(key, q)
  const inBucket = ids.filter((id) => id.toLowerCase().startsWith(`${q}-`))
  matched += inBucket.length
  if (ids.length >= 50) pagesAtCap++
  console.log(
    `  ${q} -> ${inBucket.length}/${ids.length} in bucket (total~${totalResults})`,
  )
}

const yieldPer = matched / probes
console.log(
  `\n  yield: ${matched} videos / ${probes} buckets = ${yieldPer.toFixed(2)} per bucket`,
)
console.log(
  `  pages hitting the 50-result cap: ${pagesAtCap}/${probes} (these need pagination)`,
)
console.log(`  prefix space: ${PREFIX_SPACE.toLocaleString()}`)

if (failures > 0) {
  console.error(
    `\nFAIL: ${failures} known-ID lookups failed. The Data API does NOT reproduce`,
  )
  console.error(
    'the dash-token behaviour measured against web search. Do not harvest.',
  )
  process.exit(1)
}
if (matched === 0) {
  console.error(
    '\nFAIL: zero random-prefix matches. Mechanism does not work through this API.',
  )
  process.exit(1)
}
console.log('\nPASS — mechanism confirmed through the Data API.')
