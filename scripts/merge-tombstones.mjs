#!/usr/bin/env node
// Union two tombstones.json files, never losing an id.
//
// A tombstone is a SAFETY record: "YouTube no longer serves this". Dropping one puts a
// deleted video back in front of viewers, so every path that copies a pool between
// `main` and the `pool` branch has to merge these rather than overwrite them.
//
// Two paths need it, in opposite directions:
//   - harvest.yml's post-promotion reset replaces the branch's pool with main's. A sweep
//     that ran after the promotion had already written tombstones the branch alone knew
//     about; a plain reset silently threw them away and the next promotion re-served
//     those videos.
//   - promote-pool.yml copies the branch over main.
//
// `--base` wins on the `note` text (main is authoritative for prose, the way it already
// is for blocklist.json); ids are the union of both.
//
// Usage: node scripts/merge-tombstones.mjs --base <file> --add <file> --out <file>

import { readFileSync, writeFileSync } from 'node:fs'

const ID_RE = /^[A-Za-z0-9_-]{11}$/

function parse(path, { required }) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    // A missing --add is normal: the branch may never have been swept. A missing --base
    // is not, because that is the file we are supposed to be preserving.
    if (!required && e.code === 'ENOENT')
      return { ids: [], note: null, missing: true }
    throw new Error(`cannot read ${path}: ${e.message}`, { cause: e })
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`, { cause: e })
  }
  if (!Array.isArray(doc.ids)) throw new Error(`${path} has no ids array`)
  for (const id of doc.ids) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw new Error(`${path} contains a malformed id: ${JSON.stringify(id)}`)
    }
  }
  return { ids: doc.ids, note: typeof doc.note === 'string' ? doc.note : null }
}

export function mergeTombstones(base, add) {
  const ids = [...new Set([...base.ids, ...add.ids])].sort()
  return { ids, note: base.note ?? add.note ?? '' }
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}

const basePath = arg('--base')
const addPath = arg('--add')
const outPath = arg('--out')
if (!basePath || !addPath || !outPath) {
  console.error('usage: merge-tombstones.mjs --base <f> --add <f> --out <f>')
  process.exit(2)
}

const base = parse(basePath, { required: true })
const add = parse(addPath, { required: false })
const merged = mergeTombstones(base, add)

const gained = merged.ids.length - base.ids.length
writeFileSync(outPath, JSON.stringify(merged) + '\n')
console.log(
  `tombstones: ${base.ids.length} in base + ${add.ids.length} in add ` +
    `-> ${merged.ids.length} (${gained} preserved that a plain copy would have dropped)`,
)
