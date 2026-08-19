# RandomYoutubeLinkGenerator

One button. Click it, get a random YouTube video.

Not a curated list, not a recommendation, not "trending". A **uniform random draw** from
the public YouTube corpus — which means what you get is usually somebody's home video with
59 views, in a language you may not read. That is what YouTube actually is.

**[→ Open the site](https://wardcrazy01894.github.io/RandomYoutubeLinkGenerator/)**

## How it works

You cannot enumerate YouTube. Video IDs are 11 base64url characters, so the space is
`1.845 x 10^19` against roughly 1.5 x 10^10 real videos — a random guess is a real video
about **one time in 1.2 billion**.

The trick this project uses: **YouTube's search tokenizes video IDs on the `-` character**,
and matches those tokens case-insensitively. Searching `my8exz` returns the video whose ID
is `my8EXZ-mqpQ`. So a random 5-character prefix retrieves the complete bucket of videos
whose IDs begin with it, and taking every member of a randomly chosen bucket gives a
uniform sample.

A nightly job harvests those buckets into a pool committed to this repo; the site is
static and draws from the pool. Uniform draw from a uniform sample is still uniform, and
it means clicking the button never touches YouTube's API.

**How random is it really?** [`docs/RANDOMNESS.md`](docs/RANDOMNESS.md) states the exact
frame and every known bias. The short version: uniform over a stated frame, not "truly
random" — and the pool's median view count (~59) and never-watched rate (~4%) independently
match published research (~41 and ~4%), which a popularity-biased sampler could not do.

## Safety

A uniform sample of YouTube is mostly home video, including of people who never expected an
audience. So the site:

- **never autoplays** — a draw shows a title and a blurred thumbnail behind an explicit Play
- **defaults to excluding** age-restricted and non-embeddable videos (toggle in the
  footer)
- **holds back** videos uploaded in the last 30 days, while moderation catches up
- **re-validates** the pool, dropping anything removed or made private (run manually
  today — automating it is an open follow-up)
- offers a control on every draw that hides the video for you in this browser (best
  effort — it needs local storage, and the list is capped), and additionally opens a
  prefilled report to send when a contact address is configured (`VITE_REPORT_EMAIL`)

This is considered, not safe. See [`docs/RANDOMNESS.md`](docs/RANDOMNESS.md) §6.

## Setup

```bash
npm ci
cp .env.example .env.local     # then add your YouTube Data API key
npm run dev
```

The **site** needs no key — it only reads the committed pool. The key is only for
harvesting. It is free: 10,000 quota units/day, a hard cap with no billing attached.
Create one at [console.cloud.google.com](https://console.cloud.google.com), enable
**YouTube Data API v3**, and restrict the key to that API.

## Commands

| Command                                       | What it does                               |
| --------------------------------------------- | ------------------------------------------ |
| `npm run dev`                                 | Local dev server                           |
| `npm run build`                               | Production build                           |
| `npm test`                                    | Unit tests                                 |
| `npm run typecheck` / `lint` / `format:check` | The CI gates                               |
| `npm run harvest`                             | Sample new buckets into the pool           |
| `npm run revalidate`                          | Sweep the pool for dead/removed videos     |
| `npm run pool-stats`                          | Regenerate the measured randomness numbers |
| `node scripts/verify-mechanism.mjs`           | Check the dash-token trick still works     |
| `node scripts/check-pool.mjs`                 | Pool structural invariants                 |

## Layout

```
src/            static site — random.ts is the CSPRNG draw, pool.ts the uniform pick
scripts/        harvester, revalidation, integrity checks
  lib/prefix.mjs   the prefix space + Feistel without-replacement enumeration
public/data/pool/  the sampled pool (generated; live copy lives on the `pool` branch)
docs/           DESIGN.md · RANDOMNESS.md · OPERATIONS.md
```

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — the method, what was rejected and why, the architecture
- [`docs/RANDOMNESS.md`](docs/RANDOMNESS.md) — the frame, the evidence, every known bias
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — runbook for when the harvester breaks

## Prior art

- Zhou et al., _Counting YouTube Videos via Random Prefix Sampling_ (IMC 2011)
- McGrady, Zheng, Curran, Baumgartner & Zuckerman, _Dialing for Videos: A Random Sample of
  YouTube_ (Journal of Quantitative Description, 2023)

## Licence

Code: MIT (`LICENSE`). Pool data: see `public/data/pool/LICENSE` — factual video IDs and
titles, provided as-is, subject to takedown.
