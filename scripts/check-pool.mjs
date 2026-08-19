#!/usr/bin/env node
// Structural invariants for the pool.
//
// A malformed pool does not crash the site — it silently truncates or skews the draw
// range, which is a randomness bug wearing a data-integrity costume. CI runs this on
// every PR and the harvester runs it before publishing.

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  readManifest,
  readShard,
  readTombstones,
  POOL_DIR,
  SHARD_SIZE,
} from './lib/pool.mjs'

const problems = []
const fail = (msg) => problems.push(msg)

if (!existsSync(POOL_DIR)) {
  console.error(`pool directory missing: ${POOL_DIR}`)
  process.exit(1)
}

// readManifest() falls back to a zero-record manifest when the file is missing, which
// made every invariant below hold VACUOUSLY: an empty pool directory reported
// "Pool OK: 0 records" and exited 0. That is precisely the state this gate exists to
// stop — a failed restore could then publish an empty pool over a good one.
if (!existsSync(join(POOL_DIR, 'manifest.json'))) {
  console.error(
    `manifest.json missing from ${POOL_DIR} — refusing to treat this as a valid pool`,
  )
  process.exit(1)
}

const manifest = readManifest()

if (!Number.isInteger(manifest.total) || manifest.total <= 0) {
  console.error(
    `manifest.total is ${manifest.total} — an empty pool is never a valid publish`,
  )
  process.exit(1)
}

// servable is what the client actually draws from: src/pool.ts throws EmptyPoolError at
// servable <= 0, so a pool with records but servable 0 is a dead site that the total
// check alone waves through. Integrality matters too — a fractional value reaches
// randomBelow(), which requires an integer.
if (!Number.isInteger(manifest.servable) || manifest.servable <= 0) {
  console.error(
    `manifest.servable is ${manifest.servable} — nothing would be drawable`,
  )
  process.exit(1)
}
const shardFiles = readdirSync(POOL_DIR)
  .filter((f) => /^shard-\d+\.json$/.test(f))
  .sort()

if (manifest.shardSize !== SHARD_SIZE) {
  fail(
    `manifest.shardSize is ${manifest.shardSize}, code expects ${SHARD_SIZE}`,
  )
}

const expectedShards = Math.ceil(manifest.total / SHARD_SIZE)
if (shardFiles.length !== expectedShards) {
  fail(
    `manifest.total=${manifest.total} implies ${expectedShards} shards, found ${shardFiles.length}`,
  )
}

let counted = 0
const ids = new Set()
for (let i = 0; i < shardFiles.length; i++) {
  const records = readShard(i)
  // A shard that parses but is not an array would throw an uncaught TypeError below:
  // non-zero exit, but a stack trace instead of a diagnosis.
  if (!Array.isArray(records)) {
    fail(`shard ${i} is not a JSON array`)
    continue
  }
  const isLast = i === shardFiles.length - 1
  // Every shard but the last must be exactly full, or index arithmetic
  // (shard = floor(i/K), idx = i%K) silently addresses the wrong record.
  if (!isLast && records.length !== SHARD_SIZE) {
    fail(
      `shard ${i} holds ${records.length} records; only the final shard may be partial`,
    )
  }
  if (records.length > SHARD_SIZE)
    fail(`shard ${i} overflows: ${records.length} > ${SHARD_SIZE}`)
  for (const r of records) {
    if (typeof r?.id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(r.id)) {
      fail(`shard ${i}: invalid video id ${JSON.stringify(r?.id)}`)
    }
    if (ids.has(r.id)) fail(`duplicate id in pool: ${r.id}`)
    ids.add(r.id)
    counted++
  }
}

if (counted !== manifest.total)
  fail(`counted ${counted} records but manifest.total is ${manifest.total}`)
if (manifest.servable > manifest.total)
  fail(`servable ${manifest.servable} exceeds total ${manifest.total}`)
if (manifest.servable < 0) fail(`servable is negative: ${manifest.servable}`)

if (problems.length > 0) {
  console.error('Pool integrity FAILED:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
// Tombstones are fetched by every visitor, so an unbounded list reintroduces exactly the
// linearly-growing per-page-load download the fixed-size shard scheme exists to avoid
// (docs/DESIGN.md §4.1). ~5,000 ids is roughly 93 KB raw / 47 KB gzipped — about 15x the
// whole app bundle — which is where repacking dead ids out of the shards starts to pay.
const REPACK_THRESHOLD = 5000
const tombstoned = readTombstones().ids?.length ?? 0
if (tombstoned > REPACK_THRESHOLD) {
  console.warn(
    `WARNING: ${tombstoned} tombstones (> ${REPACK_THRESHOLD}). Every visitor downloads ` +
      `this list; consider repacking dead ids out of the shards. See docs/DESIGN.md §4.1.`,
  )
}

console.log(
  `Pool OK: ${counted} records across ${shardFiles.length} shard(s), ` +
    `${manifest.servable} servable, ${tombstoned} tombstoned.`,
)
