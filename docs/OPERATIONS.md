# Operations runbook

The defining failure mode of this project is not a crash. It is a harvester that keeps
succeeding while producing nothing, for months, while the site serves a frozen pool.
Everything here exists to make that loud.

## Daily rhythm

| When                   | What                                         | Where                                    |
| ---------------------- | -------------------------------------------- | ---------------------------------------- |
| 08:17 UTC daily        | Harvest ~89 buckets, sweep 25k records, push | `.github/workflows/harvest.yml`          |
| On push to `main`      | Build + deploy the site                      | `.github/workflows/deploy.yml`           |
| Nightly (with harvest) | Re-validation sweep                          | `harvest.yml` step                       |
| 22:43 UTC daily        | Alarm if no harvest run ran its job in 36h   | `.github/workflows/harvest-watchdog.yml` |

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

### `quotaExceeded` / "quota ran out before N found ids could be enriched"

The 10,000 unit/day cap is a hard stop with no charge attached; quota resets at midnight
Pacific. A healthy run never reaches it — it stops on its own 9,000-unit `HARVEST_UNITS`
budget, leaving room for the sweep. So reaching it means something else spent quota that
day: usually a same-day manual re-dispatch, or another project sharing the key.

If it is hit during the search loop with no ids found yet, the run exits 0
(`ok-quota-capped`). If ids were already found, they cannot be enriched — quota covers
`videos.list` too — so the run commits nothing, leaves the counter where it was, and fails
with `quota-before-enrich`. Nothing is lost: the next run redraws the same buckets. Find
what else spent the quota before re-running.

### "enrichment kept N of M found ids"

Status `enrich-collapsed`. Normally about 96% of found ids are kept; only the too-fresh
and the occasional non-public are lost. Below half means `videos.list` is returning
something the harvester does not understand — empty `items`, or a changed shape for
`privacyStatus` or `publishedAt`. Nothing was committed and the counter did not move.
Look at a raw `videos.list` response for one of the logged buckets before changing code.

### "N found ids were missing from videos.list …"

A warning, not a failure. Search returned those ids but `videos.list` omitted them, so a
second call was made. The line then says one of two things:

- **"Treating the N still missing as gone from YouTube"** — nothing came back, the three
  control ids sent along all came back (so the second response was whole), and at most
  max(3, 2% of found) remain. Those videos are deleted, private, or stale in the search
  index; only
  those ids are dropped. Routine.
- **"Responses look truncated: dropping K buckets whole"** — some came back on the second
  call, a control id went missing, or too many are still missing. That is the 2026-10-01 truncation shape, so the
  affected buckets are dropped whole rather than kept partial; they return on re-harvest,
  months later. One night is tolerable. Several nights running, check
  `manifest.health.bucketsDroppedUnconfirmed` and what `videos.list` is returning.

### "Harvester health: re-validation sweep crashed"

The sweep step exited with an error. It runs under `continue-on-error`, so the harvest was
still published; nothing was re-checked that night. The step's log has the error. A
single crash after a GitHub or YouTube blip is routine. Repeated crashes mean deleted
videos stop being tombstoned and keep being served.

### `429 rateLimitExceeded` in the log

The per-minute limit, distinct from the daily quota. The client already backs off
exponentially and paces requests at 350 ms. Occasional lines are fine; if most buckets fail
this way, raise the `HARVEST_PACING_MS` env var (default 350). The error line now includes the
endpoint and the first 300 bytes of the response body, and network errors carry their
cause (`ECONNRESET`, `ENOTFOUND`, …).

### `! [remote rejected] HEAD -> pool (Internal Server Error)` in the Publish step

GitHub, not YouTube. The harvest itself completed — look for `pool now N videos` and
`Pool OK` earlier in the log — and only the final push was refused by a GitHub 5xx. The
`pool` branch is untouched and nothing is corrupted, but the night's records never left
the runner, so that day's quota bought nothing. Publish retries the push five times with
backoff (about five minutes in all), so a single blip no longer fails the run. If all five
fail with `Internal Server Error`, check <https://www.githubstatus.com>. Any other message
after five attempts — a non-fast-forward, an auth error — is not a GitHub outage: something
else touched the `pool` branch or the token. Look at the branch itself before re-running.

Do not re-dispatch the same day: the quota is already spent, and the next scheduled run
redoes exactly the same work anyway. `state.json` was never pushed, so the Feistel counter
and the sweep cursor are where they were, and the same prefixes are drawn again.

## "Harvester health: no harvest run has started"

`harvest-watchdog.yml` filed this because no `harvest.yml` run on `main` in the last 36
hours actually ran its job (still running, or finished as success or failure). A run that
never starts, ends as `startup_failure`, or is cancelled (including by the 60-minute
timeout) files no failure issue of its own. On 2026-10-08 and 10-09 GitHub's scheduler
simply created no run, after 51 consecutive nights, with the workflow active and nothing
in the repo changed.

1. `gh run list --workflow harvest.yml -L 5` — if recent runs exist but show
   `startup_failure` or `cancelled`, open one: the cause is in the run, not the scheduler.
2. `gh workflow list --all` — is `harvest` still `active`? Re-enable it if not.
3. Is the `schedule:` trigger still in `harvest.yml` on `main`? Schedules only fire from
   the default branch.
4. If all of that is fine, the scheduler dropped the runs. Dispatch one by hand
   (`gh workflow run harvest.yml`); one successful manual run proves the workflow itself
   is healthy. Close the issue once the scheduled runs resume.

The watchdog runs on the same scheduler, so a platform-wide outage silences it too. It
reliably catches two missed nights, not always one (see the header of the workflow).

## The site says "this video pool was last refreshed N days ago"

The banner reads `manifest.generatedAt` on `main` and appears past 14 days.
`generatedAt` is the start time of the newest harvest run that main's pool contains, and
main only changes when a promotion merges. So it measures how old the newest harvest in
the last promotion is — not when the promotion happened, and not whether the harvester
is alive now. Harvests landing on `pool` do not move it until promoted. Promote (above).
If there is nothing on `pool` to promote, the harvester has stopped: see the two sections
above.

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
**`main`** and merge. `main` is authoritative for the blocklist: the site is built from
main, so the entry takes effect on the next deploy, and the harvest copies main's
blocklist over the `pool` branch's each night. The site filters blocklisted IDs at draw
time.

The id must already be in main's pool — `check-pool` fails otherwise, because the site's
headline count subtracts the blocklist. To pull a video you spotted in a pending
promotion PR, add it to `blocklist.json` in that PR, or on main once it has merged.

## Running the re-validation sweep (read this first)

The sweep runs nightly inside the harvest job, so you rarely need to run it by hand.

If you do: `npm run revalidate` writes `tombstones.json`. Run it against a checkout of the
`pool` branch, not a plain checkout of `main` — the harvest repopulates `public/data/pool`
from the branch each night, so tombstones written anywhere else are not where the
harvester will look. They are no longer _lost_ if you get this wrong: the harvest's reset
path merges tombstones in both directions. But the harvester will not see them until they
reach the branch.

(Committing them straight to `main` instead is a different thing, not a broken version of
this one: `main` is what the site is built from, so those tombstones take effect on the
live site at the next deploy without ever touching the branch. That is a legitimate way to
pull a dead video, and the next promotion merges rather than overwrites, so the branch
catches up on its own.)

Run it against the live pool instead, using the `POOL_DIR` override so nothing has to be
copied back and forth. The clone goes OUTSIDE the repo, so Prettier and ESLint never see
the shard JSON, and over the `github-wardcrazy` SSH alias, so the push authenticates as
the repo owner even from a terminal whose `gh` is logged in as someone else:

```bash
git clone --branch pool --single-branch \
  git@github-wardcrazy:wardcrazy01894/RandomYoutubeLinkGenerator.git ../pool-data
POOL_DIR=../pool-data npm run revalidate
cd ../pool-data && git add -A \
  && git commit -m "revalidate: prune dead videos" && git push
```

The sweep refuses to write if a single run would remove more than 20% of what it checked
— provided at least 3 removals are involved, so two
genuine deletions on a young pool are not blocked — or if nothing at all survived — a `videos.list` response of HTTP 200 with an empty
`items` array is neither a quota error nor a key error, and would otherwise tombstone the
whole pool permanently. If a large cleanup really is legitimate, re-run with
`ALLOW_MASS_REMOVAL=1`.

That whole-run guard was not enough on its own. On 2026-10-01 twenty-two of the night's
219 `videos.list` batches came back HTTP 200 with one to four of their 50 items and no
error, and the sweep tombstoned 1,062 live videos: 9.7% of the pool, under the 20% line.
So each 50-id batch is now guarded by itself, and an id is written as `gone` only when two
responses agree and nothing in its batch looked truncated:

- A first response already missing more than 20% of the batch (same floor of 3) is
  **refused** without a second call. The rest of the window is written normally and the
  cursor still advances.
- A smaller miss is re-queried in a second call for exactly those ids (one extra unit per
  batch that had any, so a handful a night). If that call returns anything the first
  omitted, the batch is treated as flaky and its remaining misses are **deferred** to the
  next pass rather than tombstoned. A dead video can wait a night; a live one cannot come
  back.

Only `gone` is guarded this way: a private video is an item the API did return, so a
mass-private batch is left to the whole-run guard. `manifest.json` records
`stats.lastSweep.refusedBatches` and `truncatedBatches` (a second call revived something);
a refused batch sets `refused` and opens the same harvester-health issue as a refused
window. One of either is routine; a run of them means `videos.list` is flaking.

A genuinely dead cluster of more than 10 contiguous records would be refused every night,
because the batch alignment is stable while the pool is under 25k records and refusing
the batch is what keeps the alignment stable. The escape is a manual
`ALLOW_MASS_REMOVAL=1` run (it is not wired into `harvest.yml`), which lifts the batch
guard **and** the whole-run guard, and trusts whatever the second call leaves missing. Run
it only on a night `lastSweep.truncatedBatches` and `refusedBatches` are zero: under a
flaking API it tombstones live videos in exactly the way the guards exist to prevent.

The split is deliberate: `blocklist.json` is human-curated and lives on `main` so removals
go through review, while `tombstones.json` is machine-generated sweep output and belongs
with the pool data. The nightly sweep in `harvest.yml` is the normal path; this manual
one is for the rare case above.

## Manual operations

```bash
npm run harvest                      # spend the default 9000 units
HARVEST_UNITS=1000 npm run harvest   # a small run (500 is the minimum that works)
npm run revalidate                   # sweep for dead/removed videos
npm run pool-stats                   # print the figures quoted in RANDOMNESS.md
node scripts/check-pool.mjs          # structural invariants
node scripts/verify-mechanism.mjs    # is the dash-token trick still alive?
bash scripts/protect-main.sh         # re-apply branch protection (idempotent)
```

## Quota budget

10,000 units/day, free, hard-capped. `search.list` costs 100 units per call;
`videos.list` costs 1 per 50 IDs. The harvester reserves ~500 units of headroom and
stops cleanly rather than thrashing against a 403.
