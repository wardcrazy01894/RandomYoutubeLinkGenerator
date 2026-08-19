# Operations runbook

The defining failure mode of this project is not a crash. It is a harvester that keeps
succeeding while producing nothing, for months, while the site serves a frozen pool.
Everything here exists to make that loud.

## Daily rhythm

| When                   | What                                         | Where                           |
| ---------------------- | -------------------------------------------- | ------------------------------- |
| 08:17 UTC daily        | Harvest ~89 buckets, sweep 25k records, push | `.github/workflows/harvest.yml` |
| On push to `main`      | Build + deploy the site                      | `.github/workflows/deploy.yml`  |
| Nightly (with harvest) | Re-validation sweep                          | `harvest.yml` step              |

## Promoting the pool into `main`

`main` is the source of truth — the deploy builds from its committed `public/data/pool`,
so a night's harvest is invisible to viewers until it is promoted. To publish accumulated
data:

```bash
gh workflow run promote-pool.yml --repo wardcrazy01894/RandomYoutubeLinkGenerator
```

It pushes a `promote/pool` branch and stops there. **You open the PR** — the run summary
prints a one-click compare link, or:

```bash
gh pr create --repo wardcrazy01894/RandomYoutubeLinkGenerator \
  --head promote/pool --base main --title "Promote pool" --fill
```

The workflow cannot open it for you: a PR created with `GITHUB_TOKEN` fires no
`pull_request` event, so the required checks never report and it could never be merged.
That rule keys on the token, so dispatching the workflow by hand does not help.

The run summary carries the numbers that matter (videos before/after, how many added, how
many tombstoned) — read those rather than the shard diff, which is machine-generated.
`pool integrity` gates the structural invariants, and the workflow additionally refuses to
promote a pool that has _shrunk_, since the pool is append-only. `blocklist.json` is taken
from `main`, never the branch, so a promotion cannot resurrect an id removed here.

Re-dispatching force-pushes `promote/pool`, which updates an already-open PR rather than
leaving a second one behind. The flip side: anything committed to that branch by hand
(say a fix to one bad record while the PR is in review) is discarded by the next
dispatch. Make such fixes on `main` after the promotion merges, not on the branch.

Merging it triggers `deploy.yml`, and the site serves the new pool.

Afterwards the branch resets its DATA: the next harvest notices main has caught up
(`main total >= pool total`) and restarts the delta from main, committing that reset onto
the same branch. So `pool` only ever holds what has accumulated since the last promotion.
Its git history is never discarded — the push is always a fast-forward.

## Branches

- **`main`** — protected. All changes via PR, required checks, no force-push.
- **`pool`** — deliberately unprotected **staging**, not what the site serves. The
  harvester commits on top of it each
  night and fast-forwards; it is not force-pushed, so every run is a reviewable
  commit you can diff or revert.

### Rolling back what viewers see

**Resetting the `pool` branch does not roll back the live site.** It used to, when the
deploy overlaid the branch at build time. It no longer does: the site is built from the
pool committed on `main`, so a force-push to `pool` changes nothing a viewer sees, and the
deploy will appear to succeed while serving exactly what it served before. During an
incident that is the worst possible failure — it looks like it worked.

To pull something from the live site, change `main`:

```bash
# Fastest for one bad video — the client filters blocklisted ids on load.
gh pr create ...   # add the id to public/data/pool/blocklist.json on main
```

To roll back a whole promotion, revert its merge commit on `main` via a PR. Merging
either one triggers `deploy.yml`, and that is what actually changes the site.

Resetting `pool` is still the right move for a bad _harvest_ — it stops the bad data ever
reaching a promotion. It just is not a rollback of anything already merged:

```bash
git push --force origin <good-sha>:pool
```

The branch keeps a real commit per harvest (`harvest: pool at N videos`), so you can diff
any two nights and `git revert` a bad run.

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

### "not one of the N planned fresh buckets completed"

Status `no-fresh-progress`. The sampling frontier is not advancing: every fresh bucket the
run attempted failed, so `state.counter` did not move and nothing was published. This is
the alarm for the case that has no yield to measure — it exists because gating only on
yield left exactly this scenario reporting `ok` night after night.

Usually one prefix at the frontier is failing persistently. `lib/youtube.mjs` already
retries 429/5xx five times with backoff and throws immediately on other 4xx, so a failure that
reaches here is not a blip. Check the run log for the `bucket <prefix> failed:` line and
the status code behind it. A quota-capped run reports `ok-quota-capped` instead and is
never this.

### "yield … below half the baseline"

Videos per bucket collapsed. Either search coverage changed, or the API started filtering.
Compare against `npm run pool-stats` history. A single bad night can be noise — two in a
row is a real signal.

A failed or truncated run **does not move** `manifest.health.baselineYield`. That matters:
folding a collapsed yield into the baseline let the alarm lower its own threshold, so
repeated failures would decay it (4.5 → 3.7 → … → 1.2) until a run reported `ok` while
harvesting a fraction of its buckets. The threshold you are compared against is always the
last healthy, untruncated one.

(In CI this decay was not actually reachable: a `yield-collapsed` run exits non-zero, so
the publish step is skipped and the mutated manifest is discarded. It was reachable from a
local `npm run harvest`, whose output a human then commits — and the guard is worth having
regardless.)

**The trade-off, and the escape hatch.** A collapsed run exits before `writeState`, so the
sampling counter does not advance and no videos are published — in CI the whole run fails,
so nothing reaches the `pool` branch at all. (Locally it does rewrite `manifest.json` with
the failed status, which will show up in `git status`.) If the yield has genuinely and
permanently changed, every subsequent night therefore fails identically and the pool stops
growing. That is deliberate: an alarm
that quietly re-baselines itself is the failure this project is built to avoid. When you
have looked at the numbers and accepted a new normal, relearn the baseline explicitly:

```bash
HARVEST_BASELINE_RESET=1 npm run harvest      # locally, or
gh workflow run harvest.yml -f baseline_reset=true   # relearn via the guarded path
```

`HARVEST_BASELINE_RESET=1` makes the run treat the stored baseline as absent, so it learns
from this run instead of being measured against the old one. It must be exactly `1`: any
other value, including `0`, leaves the gate armed — writing `HARVEST_BASELINE_RESET=0`
must not be a way to silently disable the alarm. If the run is too small to relearn
(under 20 buckets) **or truncated** — meaning it abandoned its fresh plan after a bucket
failed — it keeps the stored baseline and says so, rather than erasing it. Check
`manifest.health.truncated` if a reset appears not to have taken.

Use it deliberately, never on a schedule — on a schedule it reintroduces exactly the bug
it replaced.

### The run says `ok` but the pool barely grew

Check `manifest.health.truncated`. A run that hits a bucket failure abandons the rest of
its fresh plan — deliberately, because committing records against a frozen counter
poisons the next run's yield — so it can succeed with far fewer buckets than planned.
`freshPlanned` vs `freshAttempted` shows how much was skipped. One such night is normal
after a transient API error; several in a row means something is reliably failing.

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

## First-time setup (one-off, needs admin)

GitHub Pages must be enabled by a human before the first deploy — `GITHUB_TOKEN` is not
allowed to create a Pages site, so `deploy-pages.yml` deliberately does not try:

```bash
gh api -X POST repos/wardcrazy01894/RandomYoutubeLinkGenerator/pages -f build_type=workflow
gh secret set YOUTUBE_API_KEY --repo wardcrazy01894/RandomYoutubeLinkGenerator
# The report address is a repo VARIABLE, not a secret: it is inlined into the public
# bundle (a mailto cannot work otherwise), so Variables is the correct home. Without it
# the report control degrades to hide-only.
gh variable set VITE_REPORT_EMAIL --repo wardcrazy01894/RandomYoutubeLinkGenerator --body '<address>'
bash scripts/protect-main.sh
```

## Kill switch

If the site must go dark immediately:

```bash
gh api -X POST repos/wardcrazy01894/RandomYoutubeLinkGenerator/pages/builds  # or:
gh api -X DELETE repos/wardcrazy01894/RandomYoutubeLinkGenerator/pages       # disables Pages entirely
```

Disabling Pages takes effect in under a minute.

To remove a single video instead, add its ID to `public/data/pool/blocklist.json` on
**`main`** and merge. `main` is authoritative for the blocklist: both the deploy and the
harvest workflows overwrite the branch's copy with main's after restoring the pool, so an
entry added here propagates on the next deploy and is then carried onto the `pool` branch.
The site filters blocklisted IDs at draw time.

## Running the re-validation sweep (read this first)

The sweep runs nightly inside the harvest job, so you rarely need to run it by hand.

If you do: `npm run revalidate` writes `tombstones.json`. Run it against a checkout of the
`pool` branch, not a plain checkout of `main` — the harvest repopulates `public/data/pool`
from the branch each night, so tombstones written anywhere else are not where the
harvester will look. They are no longer _lost_ if you get this wrong: the harvest's reset
path merges tombstones in both directions. But they will not take effect until they reach
the branch.

Run it against the live pool instead, using the `POOL_DIR` override so nothing has to be
copied back and forth:

The sweep refuses to write if a single run would remove more than 20% of what it checked
— provided at least 3 removals are involved, so two
genuine deletions on a young pool are not blocked — or if nothing at all survived — a `videos.list` response of HTTP 200 with an empty
`items` array is neither a quota error nor a key error, and would otherwise tombstone the
whole pool permanently. If a large cleanup really is legitimate, re-run with
`ALLOW_MASS_REMOVAL=1`.

```bash
git clone --branch pool --single-branch \
  git@github-wardcrazy:wardcrazy01894/RandomYoutubeLinkGenerator.git pool-data
POOL_DIR=pool-data npm run revalidate
cd pool-data && git add -A \
  && git commit -m "revalidate: prune dead videos" && git push
```

The split is deliberate: `blocklist.json` is human-curated and lives on `main` so removals
go through review, while `tombstones.json` is machine-generated sweep output and belongs
with the pool data. Automating the sweep as a workflow would remove this footgun and is
the right follow-up.

## Manual operations

```bash
npm run harvest                      # spend the default 9000 units
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
