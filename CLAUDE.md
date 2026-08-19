# Working agreement — RandomYoutubeLinkGenerator

## What this project is

A one-button site that serves a **uniform random draw** from YouTube's public corpus. The
randomness is the product. Anything that quietly biases the draw is a P0 bug, even when
nothing crashes and every test passes.

## Non-negotiables

1. **Never claim "truly random".** The claim is _uniform over a stated frame_, and the
   frame lives in `docs/RANDOMNESS.md`. It is a stronger claim precisely because it is
   checkable. If a change alters the frame, that file changes in the same PR.
2. **Never take a partial bucket.** A bucket that cannot be proven exhausted is dropped
   whole. A truncated bucket is truncated in _relevance_ order, so what survives skews
   popular — the exact bias this method exists to defeat.
3. **Never use `Math.random`.** `src/random.ts` (CSPRNG + rejection sampling) is the only
   source of randomness. ESLint enforces this.
4. **Never reject-and-advance.** When a draw lands on an excluded video, redraw. Advancing
   to `i+1` hands that video's probability mass to its neighbour.
5. **Never authenticate the harvester.** API key only — no OAuth, no cookies, no session.
   That invariant keeps a personal Google account out of the blast radius.
6. **Never scrape `/results`.** YouTube's robots.txt disallows it. The official Data API is
   the only sanctioned path. If something appears to need proxy rotation, UA spoofing, or
   CAPTCHA handling — stop and reconsider the design.
7. **Shards are immutable.** Fixed 1000 records each; only the tail shard is ever
   rewritten. Removals go to `tombstones.json`, never by editing a shard.

## The failure mode to design against

Not a crash — a harvester that succeeds while producing nothing, for months, while the site
serves a frozen pool. Every change to `scripts/harvest.mjs` must preserve the canary, the
yield gate, and the health record in the manifest.

## Docs map

Keep these current in the same PR as the change:

| Change                            | Update                                        |
| --------------------------------- | --------------------------------------------- |
| Sampling, prefix space, bias      | `docs/RANDOMNESS.md` **and** `docs/DESIGN.md` |
| Architecture, pool format, method | `docs/DESIGN.md`                              |
| Workflows, harvesting, triage     | `docs/OPERATIONS.md`                          |
| Commands, setup, features         | `README.md`                                   |

## Conventions

- TypeScript strict; Prettier (no semicolons, single quotes, trailing commas)
- Actions pinned by commit SHA with a version comment
- `main` is protected: PR-only, 0 approvals, required checks
  `build / typecheck / lint`, `test`, `secret scan`
- The `pool` branch is intentionally unprotected — see `docs/OPERATIONS.md`

## Before opening a PR

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
node scripts/check-pool.mjs
```
