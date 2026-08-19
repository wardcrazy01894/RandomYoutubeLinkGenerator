# Operations runbook

The defining failure mode of this project is not a crash. It is a harvester that keeps
succeeding while producing nothing, for months, while the site serves a frozen pool.
Everything here exists to make that loud.

## Daily rhythm

| When                  | What                                          | Where                           |
| --------------------- | --------------------------------------------- | ------------------------------- |
| 08:17 UTC daily       | Harvest ~94 buckets, push to `pool`, redeploy | `.github/workflows/harvest.yml` |
| On push to `main`     | Build + deploy the site                       | `.github/workflows/deploy.yml`  |
| Weekly (manual today) | Re-validation sweep                           | `npm run revalidate`            |

## Branches

- **`main`** — protected. All changes via PR, required checks, no force-push.
- **`pool`** — deliberately unprotected, force-pushed nightly by the harvester.

`pool` exists because a `GITHUB_TOKEN`-created pull request does **not** fire
`pull_request` events. A nightly PR would therefore never get its required checks
reported and would be permanently unmergeable — 365 dead PRs a year and a pool that never
grows. Pushing generated data straight to an unprotected branch avoids the deadlock while
keeping `main` clean and the data auditable.

## When the harvester fails

Failures open (or comment on) a GitHub issue labelled `harvester-health`, which emails you.
Start with the run log and match the symptom:

### "canary no longer returns …" — the mechanism broke

The most serious failure. YouTube changed how it tokenizes video IDs, and every downstream
number is now meaningless. **Do not** work around it. Re-run `node scripts/verify-mechanism.mjs`
by hand to confirm, then reassess the method in `docs/DESIGN.md` before harvesting again.
The pool already collected stays valid.

### "API key problem: keyInvalid / accessNotConfigured"

The key was deleted, rotated, restricted too tightly, or the YouTube Data API was disabled
on the Cloud project. Check the key restrictions allow **YouTube Data API v3**, then update
the `YOUTUBE_API_KEY` repository secret.

### "yield … below half the baseline"

Videos per bucket collapsed. Either search coverage changed, or the API started filtering.
Compare against `npm run pool-stats` history. A single bad night can be noise — two in a
row is a real signal.

### `quotaExceeded`

Not a failure. The 10,000 unit/day cap is a hard stop with no charge attached; the run
exits 0 having banked whatever it collected. Quota resets at midnight Pacific.

### `429 rateLimitExceeded` in the log

The per-minute limit, distinct from the daily quota. The client already backs off
exponentially and paces requests at 350 ms. Occasional lines are fine; if most buckets fail
this way, raise `PACING_MS` in `scripts/harvest.mjs`.

## The site says "pool hasn't been updated in N days"

The site self-monitors — it reads `manifest.generatedAt` and warns past 3 days. If you see
that banner, the harvester has been failing silently. Check the Actions tab; the alarm
issue should also exist.

## Kill switch

If the site must go dark immediately:

```bash
gh api -X POST repos/wardcrazy01894/RandomYoutubeLinkGenerator/pages/builds  # or:
gh api -X DELETE repos/wardcrazy01894/RandomYoutubeLinkGenerator/pages       # disables Pages entirely
```

Disabling Pages takes effect in under a minute. To remove a single video instead, add its
ID to `public/data/pool/blocklist.json` and merge — it is filtered at draw time.

## Manual operations

```bash
npm run harvest                      # spend the default 9500 units
HARVEST_UNITS=1000 npm run harvest   # a small run
npm run revalidate                   # sweep for dead/removed videos
npm run pool-stats                   # regenerate the numbers in RANDOMNESS.md
node scripts/check-pool.mjs          # structural invariants
node scripts/verify-mechanism.mjs    # is the dash-token trick still alive?
bash scripts/protect-main.sh         # re-apply branch protection (idempotent)
```

## Quota budget

10,000 units/day, free, hard-capped. `search.list` costs 100 units per call;
`videos.list` costs 1 per 50 IDs. The harvester reserves ~500 units of headroom and
stops cleanly rather than thrashing against a 403.
