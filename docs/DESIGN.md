# RandomYoutubeLinkGenerator — Design

**Status:** revision 2 — incorporates three adversarial reviews (statistical, operational,
product/safety), all of which returned BLOCK on revision 1.
**Date:** 2026-08-19

## 1. Goal

One button. Click it, get a random YouTube video.

The sample should be as close to uniform over YouTube's public corpus as is actually
achievable — and every place it falls short must be **measured and published**, not
hand-waved. Revision 1 claimed "truly random"; that claim is retired. See §8.

Non-goals: recommendations, curation, personalization, "good" videos.

## 2. Why the obvious approaches fail

### 2.1 Brute-force random IDs

Video IDs are 11 chars of base64url (`A-Za-z0-9_-`). The 11th char encodes only 4 bits,
so the space is `64^10 x 16 = 1.845e19`. Against ~1.5e10 public videos, a random ID hits
about **1 in 1.2 billion**.

At 500k validations/day (`videos.list`, 50 IDs per 1-unit call, 10k units/day) that is
`1.23e9 / 5e5 = 2,460 days ≈ **6.7 years** per hit`. Dead end.

> Revision 1 stated 6,700 years here — a 1000x arithmetic error, caught in review.

### 2.2 "Dialing" (case-insensitive full-ID match)

**Empirically verified 2026-08-19:** YouTube search matches a full 11-char ID
case-insensitively. Searching `jezlkg4agw0` returns the video whose real ID is
`jeZLKG4agw0`; `JEZLKG4AGW0` works too. This is the mechanism behind McGrady et al.,
_Dialing for Videos_ (Journal of Quantitative Description, 2023).

But case-folding only shrinks the space by its own factor: 38 classes per position gives
`38^10 x 16 = 1.0e17`, or ~6.7 million queries per video found. Not viable alone.

### 2.3 Camera-filename search (`IMG_`, `DSC`, `MOV0`)

What Astronaut.io and Petit Tube do. **Rejected outright**, on two grounds. It is not
random — it samples the narrow slice of uploads that kept their default filename. And per
the safety review it is the single riskiest thing we could build: it is a targeted filter
for unedited home video, which maximizes the density of footage of children who never
expected an audience. Not shipped, not offered as a "flavor mode".

## 3. The method: dash-token prefix sampling

### 3.1 The mechanism

**Empirically verified 2026-08-19.** YouTube's search tokenizer **splits video IDs on `-`**
and indexes the segments as case-insensitively matched tokens.

| Query        | Target        | Result                                        |
| ------------ | ------------- | --------------------------------------------- |
| `my8exz`     | `my8EXZ-mqpQ` | found                                         |
| `7cbrv9h`    | `7Cbrv9h-0cY` | found                                         |
| `xvp3n9h`    | `xVp3N9h-DQY` | found                                         |
| `aw8ltyxg`   | `Aw8lTYXg_V8` | **not** found — `_` does not split            |
| `jezlkg4agw` | `jeZLKG4agw0` | **not** found — bare prefix, no dash boundary |

So the query must be a complete dash-delimited token. Only `-` splits.

> **Open verification gate.** All of the above was measured against YouTube's _web_
> search. This project queries the **Data API** (§3.6), which may tokenize differently.
> `scripts/verify-mechanism.mjs` must pass before any harvesting is trusted. If the API
> does not reproduce this behaviour, the approach is reassessed rather than fudged.

### 3.2 The sampler

1. Draw a prefix of length **k = 5** over the case-folded non-dash alphabet
   (`a-z`, `0-9`, `_` = 37 classes), **with the final character restricted to the 21
   classes that cannot appear as an ID's 11th character** (see §3.3.2).
2. `search.list(q=<prefix>, type=video, maxResults=50)`.
3. **Paginate to exhaustion** — take every member of the bucket (§3.3.3).
4. Keep only IDs whose lowercased form starts with `<prefix>-`. Everything else on the
   page is fuzzy filler or a middle/last-token match; keeping any of it would import
   YouTube's relevance ranking and destroy uniformity.
5. Enrich in bulk via `videos.list` (1 unit per 50 IDs).

k was chosen by measurement against the real API, not by arithmetic. See §3.7 — the
first choice (k=4) was disqualified by evidence.

### 3.3 Why this is close to uniform — and the three ways it isn't

The frame is _videos whose ID has its first dash at position 6_ (for k=5).

#### 3.3.1 The independence assumption (ASSUMED, NOT PROVEN)

Video IDs are believed to be assigned as essentially random 64-bit values, making
dash position statistically independent of content, language, uploader, views, and date.
That would make the stratum an unbiased `(63/64)^5 / 64 = 1.444%` subsample.

**This is folklore, not a published fact.** Nobody outside YouTube has confirmed the
generator was constant from 2005 to now. If it changed, dash position correlates with
upload era, and era correlates with everything.

_Test T1:_ our pool constrains positions 1–5 only; positions 6–11 are unconditioned.
Chi-square positions 6–10 against uniform-64 and position 11 against uniform-16,
**split by `publishedAt` year**. Published in RANDOMNESS.md, regenerated every harvest.
Until T1 has power, the docs say "assumed independent", not "is independent".

#### 3.3.2 Last-token collision (FIXED)

The 11th ID character is restricted to 16 values (`A E I M Q U Y c g k o s w 0 4 8`). A
query whose final character case-folds into that set **also matches as the trailing token**
of IDs shaped `XXXXXX-qqqq`. Those competitors outnumber the wanted bucket ~4:1 and
compete for the same page slots — and truncation is relevance-ranked, so the survivors
skew popular. That is precisely the bias this whole method exists to avoid.

**Fix:** restrict the prefix's final character to the 21 classes that cannot be an 11th
character. This eliminates last-token collision entirely. Cost: ~5% yield per query. The
sub-stratum remains content-independent under the same §3.3.1 assumption.

#### 3.3.3 Bucket truncation (FIXED BY EXHAUSTIVE PAGINATION)

Uniformity requires taking **every** member of a drawn bucket. Truncating a dense bucket
under-samples it, and does so in _relevance_ order — so the survivors skew popular, which
is the precise bias this whole method exists to avoid.

**Fix:** a bucket we cannot prove exhausted is dropped **whole** and counted, never taken
partially. At k=5 roughly 83% of buckets are exhaustible in a single page (§3.7).

**Dropping them is unbiased**, which is the load-bearing point. A bucket fails to exhaust
because its 5-character prefix happens to resemble ordinary text (`ilfat`, `gl1u_`), so it
collides with thousands of title and description matches. That is a property of _the query
string_, not of the videos whose IDs begin with it — those are random with respect to it.
So the drop costs ~17% of yield without skewing what survives.

#### 3.3.4 Recall — measured, and it is high

Revision 2 flagged this as the largest threat to the whole project. Web search returned
1.1 videos/query at k=5 where a 1.5e10 corpus predicts 5.50, implying ~65% of eligible
videos never surfaced for their own token. If that shortfall correlated with view count,
uniformity would fail at the mechanism level and nothing downstream could repair it.

**Measuring against the API instead resolves it.** The web result page shows ~20 slots
shared with fuzzy filler, so it was hiding most of each bucket — the instrument was the
problem, not the mechanism.

|                               | videos/bucket |
| ----------------------------- | ------------- |
| Predicted, corpus 9.0e9       | 3.30          |
| **Predicted, corpus 1.5e10**  | **5.50**      |
| Predicted, corpus 2.0e10      | 7.34          |
| **Measured (12 API buckets)** | **5.25**      |

Implied recall ≈ **0.95**, and the implied corpus is consistent with published ~1.4e10
estimates. n=12 is small and the interval is wide, so the harvester keeps measuring this
every run and publishes it; but the "recall is catastrophically low" hypothesis is dead.

#### 3.3.5 Recency bias (MITIGATED)

`P(v in pool) = 1 - (1 - 1/M)^N(t_v)`, where `N(t_v)` counts draws made _after_ v was
uploaded. A video uploaded halfway through a year of harvesting has half the inclusion
probability of one that existed at the start; one uploaded today has ~0. This is O(1), not
O(1/N) — revision 1 missed it entirely.

**Fix:** a fixed fraction of each night's budget re-harvests the oldest previously-drawn
buckets on a rolling window, bounding the bias by the window rather than by project
lifetime. The window length is published.

#### 3.3.6 Remaining honest biases

1. **Search-index coverage.** Unlisted, private, and deleted videos are absent — correct,
   they are not public. Videos demoted or excluded by search are under-represented by an
   unknown amount. Partly this is safety filtering we _want_.
2. **Embeddability.** By default we serve only embeddable videos, excluding most major-label music
   and many news orgs. Measured from `status.embeddable` and published as a percentage.
3. **Age-restriction / safety subsetting.** Default view excludes age-restricted videos
   (§6). Opt-out is available and clearly labelled.
4. **Harvester locale.** Results are region- and language-conditioned; `regionCode` and
   `relevanceLanguage` are pinned explicitly and published.
5. **Staleness.** Videos deleted after harvest; mitigated by re-validation (§5.4).

### 3.4 Sampling without replacement

Revision 1 drew prefixes i.i.d. with replacement. Review confirmed this is _unbiased_
(inclusion probability is independent of bucket occupancy — standard equal-probability
cluster sampling), but it is strictly worse than the alternative.

We instead enumerate the prefix space in a **pseudorandom order without replacement**,
using a keyed Feistel permutation over `[0, 37^3 x 21)` with cycle-walking. State is a
single integer counter in git. Exactly uniform, lower variance, no repeats, and it makes
the §3.3.5 rolling re-harvest natural.

### 3.5 Corpus estimate — not published yet

`stratum ≈ λ̂ x 63^k`, `corpus ≈ stratum / 0.01467`.

The 12-bucket API pilot implies ~1.4e10, consistent with published estimates — but the
interval at n=12 is far too wide to publish a point estimate, and the estimator is
circular with respect to §3.3.1 (it divides by the very rate that assumption asserts).

So it stays a **lower bound on token-indexed searchable videos**, not a corpus estimate.
No point estimate is published until n >= 2,000 buckets, and then only with its interval.
The harvester accumulates toward that automatically.

### 3.6 Why the official API, and the quota budget

YouTube's `robots.txt` contains `Disallow: /results`. The ToS carve-out for automated
access applies only _in accordance with robots.txt_, so scraping search HTML is out. The
project uses the **YouTube Data API v3 exclusively**. `/oembed` is not disallowed but is
not needed — `videos.list` is strictly better and cheaper.

**Invariant: the harvester is never authenticated as a user.** API key only, no cookies,
no OAuth, no session. This keeps any personal Google account out of the blast radius.

**Bright line:** if this ever appears to require proxy rotation, user-agent spoofing, or
CAPTCHA handling, we stop. That converts "documented API use" into evasion.

Daily budget against 10,000 units, at the measured k=5 rate of ~5 videos/bucket:

| Call                               | Unit cost  | Per day   | Units |
| ---------------------------------- | ---------- | --------- | ----- |
| `search.list` (new buckets)        | 100        | ~66       | 6,600 |
| `search.list` (rolling re-harvest) | 100        | ~28       | 2,800 |
| `videos.list` enrichment           | 1 / 50 IDs | ~10 calls | 10    |
| Reserve                            |            |           | ~590  |

≈ 94 buckets/night, of which ~83% exhaust, x ~5 members = **~390 new videos/night**, each
fully enriched. That is ~140k/year, against a prefix space that takes over a millennium to
exhaust.

## 3.7 Choosing k: measured, not derived

Revision 2 specified k=4 on arithmetic alone. Probing the real API disqualified it:

| k   | members/bucket | buckets exhaustible | verdict                          |
| --- | -------------- | ------------------- | -------------------------------- |
| 4   | ~41            | **0 / 12**          | rejected                         |
| 5   | ~5             | 10 / 12 (~83%)      | **chosen**                       |
| 6   | ~0.25          | 4 / 4               | too sparse — 100 units per video |

At k=4 every single page hit the 50-result cap with `totalResults` from 190 to 311,860,
so no bucket could be shown complete. `maxResults` caps a page at 50, further pages cost
100 units each, and the API stops paginating near 500 results — so a k=4 bucket is
_unknowable_, and taking it anyway would mean taking a relevance-ranked slice.

Quoting the query (`q="3wu3"`) reduced fuzzy matches (4,151 -> 1,590 on one probe) but
never enough to exhaust, so it was not adopted.

A note on the earlier figure: web search suggested ~1.1 videos per k=5 query, but the API
returns ~5. The web result page shows ~20 slots shared with fuzzy filler, so it was hiding
most of each bucket. The API is the better instrument, and the pilot numbers in §3.5 are
superseded by it.

## 4. Architecture

Harvest into a committed pool; serve a fully static site.

```
  nightly GitHub Actions cron
        |
        v
  scripts/harvest.mjs  --(YouTube Data API v3, key from secrets)-->  search.list + videos.list
        |
        v
  data/pool/shard-NNNN.json (immutable, fixed 1000 records) + manifest.json + tombstones.json
        |  pushed DIRECTLY to the unprotected `pool` branch
        v
  reusable deploy workflow -> Vite build -> GitHub Pages
        |
        v
  browser: uniform pick -> title + blurred thumb -> explicit Play -> youtube-nocookie embed
```

### 4.1 Immutable fixed-size shards

Revision 1 rewrote shards nightly, which grows git history quadratically — ~43 GB written
over a year, ~4 GB packed, against GitHub's 1 GB warning and 2 GB push limit. It would
also have blown the 5-minute `fetch-depth: 0` gitleaks job.

Instead: every shard holds **exactly 1000 records** except the tail. A night appends new
shard files and rewrites only the partial tail. History growth is linear.

This also **deletes the subtlest bug in revision 1**. With fixed `K`, the cumulative-offset
array and binary search vanish: `shard = floor(i / K)`, `idx = i % K`. The manifest becomes
a constant ~100 bytes instead of a linearly-growing 73 KB fetched on every page load.

Pruning must not violate immutability: dead IDs go to `tombstones.json` and the client
**rejects and redraws** (never `i+1`, which would transfer the dead video's probability
mass to its neighbour). Repacking happens on a scale of years, not nightly.

### 4.2 Unbiased integer generation

`crypto.getRandomValues` plus **rejection sampling**; `% n` on a u32 is biased whenever
`n` does not divide `2^32`.

Revision 1 proposed a chi-square test for this. Both reviewers noted it **cannot work**:
the bias is ~`n/2^32 ≈ 2e-5`, needing ~1e10 samples to detect, and a chi-square on a
CSPRNG is ~5% flaky by construction — corrosive in unattended CI. Instead we inject a
deterministic mock RNG and assert behaviour exactly at the rejection boundary
(`limit-1`, `limit`, `2^32-1`, `0`), assert `n = 0` throws, and lint-ban `Math.random`.

### 4.3 Not committing to `main`

`GITHUB_TOKEN`-created PRs do not fire `pull_request` events, so required checks would
never report and every nightly PR would be **permanently unmergeable** — 365 open PRs and
a pool that never grew. GitHub would also disable the cron after 60 days of "inactivity".

The harvester therefore pushes straight to an unprotected `pool` branch. `main` stays
protected and churn-free. Deploy is extracted into a `workflow_call` reusable workflow
that both `deploy.yml` and `harvest.yml` invoke.

The nightly commit **extends** that branch's history rather than replacing it: the job
clones `pool` (with its `.git`), swaps in the run's output, and fast-forwards. An earlier
implementation ran `git init` in the data directory and force-pushed, which left the
branch permanently one commit deep — no diff between runs, and no way to roll back a bad
harvest. Since shards are immutable and append-only (§4.1), a real history costs very
little: each night's delta is the new shards plus the partial tail shard.

### 4.4 Failure detection

The likeliest failure is **a successful run that produces nothing**, and "zero videos this
bucket" cannot be the alarm — empty buckets occur naturally (2 of 12 in the pilot), since
occupancy is a Poisson-like draw around ~5 crossed with case-folding multiplicity.

Fatal, run-level assertions in `harvest.mjs`:

- **API error taxonomy** — `quotaExceeded` is expected and exits 0 cleanly; `keyInvalid`,
  `accessNotConfigured`, and 403s are fatal and distinct.
- **Yield gate** — run-level videos/bucket below half the rolling baseline exits non-zero.
- **Exhaustion gate** — buckets that cannot be proven exhausted are dropped and counted;
  above a threshold, fail.
- **Mechanism canary** — a known dash-token ID must be retrievable by its own token every
  run. This is the single check that catches YouTube changing the tokenizer.

Alerting: a red Actions run on an unwatched repo is invisible, so failures open/update a
pinned GitHub issue (which emails). `manifest.health` carries `{lastRunUtc, buckets,
yield, status}`, and the site shows a visible "pool last updated N days ago" banner past 3
days. The site self-monitors rather than trusting notifications.

## 5. Safety

Uniform sampling returns _home video_: the median YouTube video has ~41 views, and
moderation lags hardest exactly there. Unattended minors are common. Revision 1 had no
safety layer at all. This is not optional.

### 5.1 Never autoplay

First paint is the button. A draw renders title + channel + **blurred** thumbnail + an
explicit Play control. This converts "the site showed me something awful" into "I chose to
play it", and it is the cheapest, highest-leverage mitigation available.

### 5.2 Safe-by-default subset

The default view excludes age-restricted (`contentDetails.contentRating.ytRating`) and
non-embeddable videos. A clearly-labelled opt-out lifts both, with a persistent banner
stating the draw is no longer the default frame.

Three exclusions are **not** governed by that toggle and always apply: the maintainer's
`blocklist.json`, `tombstones.json` (videos the weekly sweep found deleted or made
private), and videos the viewer has hidden in their own browser. All three are permanent
states rather than preferences, which is why the toggle does not reach them — and it is
also why the sweep tombstones _only_ those states, never embeddability or age-restriction,
which the toggle does govern. So the opt-out
widens the frame; it does not make the draw unfiltered, and the banner says so. The
exclusion rates are reported by `npm run pool-stats` — they are interesting statistics in
their own right.

This is stated plainly as a filter, **not a safety guarantee**. No automated signal
identifies "home video of somebody's kids", and we do not pretend otherwise.

### 5.3 Quarantine window

Harvest, hold 7 days, re-validate, then serve. Videos YouTube removes in that window never
reach a viewer. Revision 1 framed this sweep as staleness hygiene; it is actually the
primary safety mechanism, and it runs weekly.

### 5.4 Report path, blocklist, kill switch

A control on every draw that hides the video for that viewer — best effort, since it needs
local storage and the list is capped — and additionally opens a prefilled report when a
contact address is configured (`VITE_REPORT_EMAIL`, a repo variable, since the value is
inlined into the public bundle). With no address the control is labelled "Hide this video"
and files nothing, rather than claiming to. `blocklist.json` is filtered at draw time, is authoritative on `main`, and is honoured
by the sweep. Plus a documented 60-second kill switch.

The contact address lives only in that control, not as a separate footer mailto — one
scrapeable address is enough, and a second would claim a channel nobody monitors.

Reports **must not** route to public GitHub issues — that would build a searchable public
index of the worst content on the site.

### 5.5 Embed and data hygiene

- `youtube-nocookie.com` embeds; no analytics, no ads, no cookies set on first paint.
- Store the **minimum**: ID, title, flags, coarse stats. **No channel/author names** — those
  are frequently real names, and a public repo full of them is a GDPR processing activity.
- Code and data licensed separately; data as-is, no warranty, subject to takedown.

## 6. Stack

TypeScript (strict) + Vite, vanilla DOM. Vitest, ESLint, Prettier. GitHub Pages via
Actions. Harvester is plain Node ESM with zero runtime dependencies.

## 7. Repo hygiene

Matching the house conventions, plus what review found missing:

- `ci.yml` — typecheck, lint, format, build, test, gitleaks, informational audit; SHA-pinned
- `deploy.yml` + reusable `deploy-pages.yml`; `harvest.yml` with explicit `permissions`,
  `concurrency`, and `timeout-minutes`
- **`.gitleaks.toml` allowlisting `data/pool/**`** — a pool of random base64url strings is
  exactly what entropy rules fire on; without this every PR goes red
- **`.gitattributes`** marking the pool `linguist-generated -diff`, or every diff is a wall
- `scripts/protect-main.sh` — idempotent, 0 required approvals (solo repo)
- `docs/OPERATIONS.md` — the runbook for a silently-broken harvester
- `docs/RANDOMNESS.md` — regenerated from real numbers each harvest so it cannot rot
- `.nvmrc`, dependabot, PR template

## 8. What the site actually claims

"Truly random" is not defensible and is retired. The real frame is: _public videos that are
in the search index, have a dash at position 5, are embeddable, survived re-validation, and
are not blocklisted._

Uniform-over-a-stated-frame is a **stronger** claim than "truly random", because it is
checkable. UI copy: headline "Random YouTube"; subhead "A uniform random draw from N
public YouTube videos"; and a link — "How random is this, really?" — to RANDOMNESS.md.
