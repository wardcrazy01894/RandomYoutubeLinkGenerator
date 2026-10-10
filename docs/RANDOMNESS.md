# How random is this, really?

Short answer: **uniform over a stated frame**, not "truly random". The frame is written
down below, along with every bias we know about and the size of the ones we can measure.

If you only read one line: _this is a uniform random draw from the public YouTube videos
whose ID contains a dash in position 6 and which are retrievable by ID-token search._

## Why not just "random"?

There is no way to enumerate YouTube. Video IDs are 11 base64url characters, and since the
last character carries only 4 bits the space is `64^10 x 16 = 1.845 x 10^19`. Against
roughly 1.5 x 10^10 public videos, a randomly guessed ID is a real video about **one time
in 1.2 billion**. Guessing is not a strategy.

So every honest "random YouTube" tool samples some _frame_ — a subset it can actually
reach — and the only question is whether the frame is chosen independently of the things
you care about (views, language, topic, recency). Ours is, with the caveats in §4.

## 1. The method

YouTube's search tokenizes video IDs on the `-` character, and matches those tokens
case-insensitively. So searching `my8exz` returns the video whose ID is `my8EXZ-mqpQ`.
Underscores do not split; only dashes do.

We draw a random 5-character prefix, ask the API for it, and keep **only** the results
whose ID actually begins `<prefix>-`. Everything else the search returns is discarded —
keeping any of it would import YouTube's relevance ranking, which is exactly the
popularity bias this method exists to avoid.

The technique is adapted from published research: Zhou et al., _Counting YouTube Videos
via Random Prefix Sampling_ (IMC 2011), and McGrady et al., _Dialing for Videos: A Random
Sample of YouTube_ (Journal of Quantitative Description, 2023).

## 2. Why the frame is unbiased

The frame is "videos whose ID has its first dash in position 6". Video IDs are assigned as
essentially random values, so whether a given video's ID happens to have a dash there is
**independent of its content, language, uploader, view count, and upload date**. That makes
the frame a ~1.44% random slice of the corpus rather than a curated corner of it.

Within the frame, 5-character prefixes partition the videos into ~39.4 million disjoint
buckets. We draw buckets in a keyed pseudorandom order _without replacement_, and take
**every** member of each bucket. Taking all of a randomly chosen bucket is what makes the
result uniform; taking part of one would not be.

## 3. Evidence that it works

Two independent checks, both from the live pool:

**Yield matches theory.** A 1.5 x 10^10 corpus predicts 5.50 videos per bucket. Over 600
exhausted buckets (11 nights, late September to early October 2026) we measure **5.33**.
Implied recall ≈ 0.97 — the search index returns nearly every video we ask for, so we are
not silently missing a large slice.

**The view distribution looks like research, not like popularity.** On 2026-10-10 the pool
(12,577 videos) has a median of **76 views**, and **2.9%** have never been watched. The
independent 2023 study found ~41 and ~4%. Ours is not identical — our view counts are
captured at harvest, and the pool skews recent (§4.6) — but a sampler skewed toward
popular content would show medians in the thousands. This is still the most reassuring
number here.

These figures come from `npm run pool-stats`, run by hand on the live pool and updated
here in a PR; they are dated so you can tell how fresh they are.

## 4. Every bias we know about

Ordered by how much they should worry you.

1. **Search-index coverage.** Unlisted, private, and deleted videos never appear — correct,
   they are not public. But videos _demoted_ by search (spam, some age-restricted content)
   are under-represented by an amount we cannot measure from outside. This is the largest
   unquantified bias. Note that part of it is safety filtering we actively want.
2. **The dash-position frame.** ~1.44% of the corpus. Unbiased with respect to content
   under §2's assumption, but it is formally a stratum, not the whole corpus.
3. **ID-generation is assumed stable.** §2 assumes YouTube has assigned IDs randomly and
   consistently since 2005. That is folklore, not a published fact. If the scheme changed,
   dash position could correlate with upload era — and era correlates with almost
   everything. The test that would detect it — character distribution by upload year — is
   designed (DESIGN.md §3.3.1) but not yet built, so this remains an assumption.
4. **Embeddability.** By default we serve only embeddable videos, which excludes most
   major-label music and many news organisations. The footer toggle lifts this along with
   age-restriction, so it is a default rather than a hard frame boundary — and the
   sweep deliberately does not tombstone non-embeddable videos, which would turn that
   default into a permanent removal. Currently ~99% of harvested videos qualify, so the
   effect is small but real.
5. **Unexhaustible buckets (~13%).** When a prefix happens to look like ordinary text
   (`ilfat`), it collides with thousands of title matches and the bucket cannot be
   retrieved completely. We drop those buckets whole rather than take a truncated,
   relevance-ranked slice. **This does not bias the sample**: the drop depends only on
   whether the _query string_ resembles text, which is independent of the videos whose IDs
   happen to start with it.
   Enrichment applies the same rule. When `videos.list` omits ids that search just
   returned, a second call is made for them. If it brings any back, or if many are still
   missing, or if any of the three already-confirmed control ids placed at both ends of it
   fails to come back, the responses are truncating — and a truncated response is a relevance-ranked
   partial bucket — so every affected bucket is dropped whole. If it brings none back and
   only a handful remain (at most 3, or 2% of the night's finds), they are treated as
   videos that are gone from YouTube — deleted, made private, or a stale search-index entry — and only those ids are
   dropped: they are outside the frame, and dropping their bucket-mates would not be.
   A dropped bucket returns only when the re-harvest rotation reaches it again — in
   practice a long wait, since re-harvest currently gets far less than its planned share
   of each night (§4.6). `manifest.health.bucketsDroppedUnconfirmed` and `gone` record each night's
   counts, so the rate can be watched rather than assumed.
   The controls assume truncation keeps a contiguous run of the request in order, which
   is the shape observed. A response that drops items from the middle, reorders and
   drops, or omits particular ids on every call would read as deletions; that residual is
   capped at the deletion budget — at most max(3, 2%) ids a night — and is accepted rather
   than claimed away.
6. **Recency.** A pool built up over time under-represents videos uploaded recently, since
   they did not exist for earlier draws. 30% of each night's plan is meant to re-harvest
   older buckets to bound this. **In practice it runs far less:** fresh buckets go first,
   unexhausted ones cost up to three searches, and the budget is usually gone after ~60
   buckets — so re-harvest has been getting 0–4 of its 26 planned buckets a night. Until
   that is fixed, this bias is larger than designed.
7. **Safety filtering (on by default).** The default view hides age-restricted and
   non-embeddable videos; the footer toggle turns both off. Three exclusions are **not**
   covered by the toggle and
   always apply: the maintainer's `blocklist.json`, videos the re-validation sweep found deleted
   or made private (`tombstones.json`), and videos you have hidden yourself in this
   browser. So the toggle widens the frame, it does not make it unfiltered.
8. **Harvester locale.** Results are region- and language-conditioned; we pin `US`/`en`
   explicitly so the bias is fixed and stated rather than drifting.

## 5. What we deliberately do not claim

- We do **not** claim to sample all of YouTube. See §4.1 and §4.2.
- We do **not** publish a corpus-size estimate. The method can produce one, and the pool
  has now passed the 2,000 buckets we said it needed, but no confidence interval is
  computed yet and the estimator is partly circular with the assumption in §4.3.
- We do **not** claim the safety filter makes anything safe. It is a filter, not a
  guarantee. See §6.

## 6. On what a uniform sample of YouTube actually contains

Worth stating plainly, because it surprises people. The typical YouTube video has almost
no views. A uniform draw is therefore mostly _home video_: family footage, phone clips,
gameplay, school projects, in many languages, frequently with no title to speak of.

That is the honest texture of the platform, and it is the point of the site. It also means
a uniform draw will sometimes surface ordinary people — often children — who never
anticipated an audience. So the site never autoplays, defaults to excluding age-restricted
material, holds newly uploaded videos back for 30 days while moderation catches up,
re-validates a slice of the pool every night, and offers a control on every draw that
hides a video for you — and opens a prefilled report to send, when a contact address is
configured.

None of that makes the pool "safe". It makes it _considered_.
