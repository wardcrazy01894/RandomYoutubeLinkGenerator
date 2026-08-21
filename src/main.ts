import './style.css'
import {
  loadManifest,
  loadBlocklist,
  loadTombstones,
  drawRandom,
  poolAgeDays,
  EmptyPoolError,
  type Manifest,
  type PoolRecord,
} from './pool'

// Auto-advancing past unplayable videos must terminate. Without a cap, a viewer in a
// region where several consecutive draws are blocked sees an unbounded chain of blank
// frames (docs/DESIGN.md §4.3).
const MAX_AUTO_ADVANCE = 5
const DEAD_LIST_CAP = 2000
const DEAD_KEY = 'ryl.dead.v1'
const STALE_AFTER_DAYS = 3
// Validated once rather than encoded. encodeURIComponent would turn '@' into '%40',
// which RFC 6068 does not permit in the addr-spec (the '@' must be literal; a
// pct-encoded local-part like '%2B' for '+' is fine, so plus-aliases survive either
// way). Validating instead means a malformed repo variable degrades to the honest
// hide-only path rather than shipping a mailto no client can use.
// '#' is excluded too: an address containing one turns the rest of the mailto into a URL
// fragment, so subject and body vanish silently.
const REPORT_ADDRESS_RE = /^[^\s@,?&#]+@[^\s@,?&#]+\.[^\s@,?&#]+$/
const RAW_REPORT_TO = import.meta.env.VITE_REPORT_EMAIL ?? ''
const REPORT_TO = REPORT_ADDRESS_RE.test(RAW_REPORT_TO) ? RAW_REPORT_TO : ''

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const els = {
  draw: $<HTMLButtonElement>('draw'),
  result: $<HTMLElement>('result'),
  thumb: $<HTMLElement>('thumb'),
  thumbImg: $<HTMLImageElement>('thumb-img'),
  player: $<HTMLElement>('player'),
  play: $<HTMLButtonElement>('play'),
  title: $<HTMLElement>('title'),
  meta: $<HTMLElement>('meta'),
  watch: $<HTMLAnchorElement>('watch'),
  report: $<HTMLButtonElement>('report'),
  safe: $<HTMLInputElement>('safe'),
  subhead: $<HTMLElement>('subhead'),
  banner: $<HTMLElement>('banner'),
  poolinfo: $<HTMLElement>('poolinfo'),
}

let manifest: Manifest | null = null
let blocked: string[] = []
let current: PoolRecord | null = null
let autoAdvances = 0

/** Locally-known-dead IDs, capped so localStorage cannot grow without bound. */
function readDead(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DEAD_KEY) ?? '[]')
  } catch {
    return []
  }
}
function markDead(id: string): void {
  // Storage can be unavailable (private browsing, partitioned or disabled storage). The
  // read side already tolerated that; without the same guard here the click threw before
  // the banner and before the redraw, so the control appeared to do nothing at all.
  // Hiding is best-effort and capped, so it is not permanent — the docs say so.
  try {
    const list = readDead().filter((x) => x !== id)
    list.push(id)
    localStorage.setItem(DEAD_KEY, JSON.stringify(list.slice(-DEAD_LIST_CAP)))
  } catch {
    /* not persisted — the draw still advances */
  }
}
const excluded = (): Set<string> => new Set([...blocked, ...readDead()])

const nf = new Intl.NumberFormat()

/** ISO-8601 duration (PT4M13S) -> 4:13 */
function formatDuration(iso: string | null): string {
  if (!iso) return ''
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return ''
  const [h, min, s] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`
}

function showBanner(message: string): void {
  els.banner.textContent = message
  els.banner.hidden = false
}

function render(record: PoolRecord): void {
  current = record
  els.result.hidden = false
  els.player.hidden = true
  els.player.replaceChildren()
  els.thumb.hidden = false

  els.thumbImg.src = `https://i.ytimg.com/vi/${record.id}/hqdefault.jpg`
  els.title.textContent = record.t || '(no title)'
  els.watch.href = `https://www.youtube.com/watch?v=${record.id}`

  const duration = formatDuration(record.dur)
  const facts: Array<{ text: string; flag?: boolean }> = [
    record.pub ? { text: new Date(record.pub).getFullYear().toString() } : null,
    { text: `${nf.format(record.v)} view${record.v === 1 ? '' : 's'}` },
    duration ? { text: duration } : null,
    record.age ? { text: 'age-restricted', flag: true } : null,
  ].filter((f): f is { text: string; flag?: boolean } => f !== null)

  // Built as elements rather than one joined string so each fact can carry its own
  // styling. Text goes in via textContent — titles and metadata are untrusted.
  els.meta.replaceChildren(
    ...facts.map((f) => {
      const chip = document.createElement('span')
      chip.className = f.flag ? 'chip chip-flag' : 'chip'
      chip.textContent = f.text
      return chip
    }),
  )
}

async function draw(): Promise<void> {
  if (!manifest) return
  els.draw.disabled = true
  els.draw.textContent = 'Drawing…'
  try {
    render(
      await drawRandom(manifest, {
        safeMode: els.safe.checked,
        excluded: excluded(),
      }),
    )
  } catch (err) {
    if (err instanceof EmptyPoolError) {
      showBanner(err.message)
    } else {
      showBanner(`Something went wrong: ${(err as Error).message}`)
    }
  } finally {
    els.draw.disabled = false
    els.draw.textContent = 'Show me another'
  }
}

// --- playback ---------------------------------------------------------------
// The IFrame Player API is loaded lazily, only once the viewer actually chooses to
// play something, so nothing is requested from YouTube on first paint. The embed uses
// youtube-nocookie.com (docs/DESIGN.md §5.5).

let apiReady: Promise<void> | null = null
function loadPlayerApi(): Promise<void> {
  if (apiReady) return apiReady
  apiReady = new Promise<void>((resolve) => {
    const w = window as unknown as {
      onYouTubeIframeAPIReady?: () => void
      YT?: unknown
    }
    if (w.YT) return resolve()
    w.onYouTubeIframeAPIReady = () => resolve()
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(s)
  })
  return apiReady
}

async function play(): Promise<void> {
  if (!current) return
  const record = current
  await loadPlayerApi()
  els.thumb.hidden = true
  els.player.hidden = false
  const mount = document.createElement('div')
  els.player.replaceChildren(mount)

  const YT = (window as unknown as { YT: any }).YT
  new YT.Player(mount, {
    videoId: record.id,
    host: 'https://www.youtube-nocookie.com',
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
    events: {
      onStateChange: (e: { data: number }) => {
        if (e.data === YT.PlayerState.PLAYING) autoAdvances = 0
      },
      // 100 = removed, 101/150 = embedding disallowed by the owner.
      onError: async () => {
        markDead(record.id)
        if (autoAdvances >= MAX_AUTO_ADVANCE) {
          showBanner(
            "Couldn't find a playable video after several tries — press the button to keep going.",
          )
          autoAdvances = 0
          return
        }
        autoAdvances++
        showBanner(
          `That video wasn't playable — trying another (${autoAdvances}/${MAX_AUTO_ADVANCE})…`,
        )
        await draw()
        await play()
      },
    },
  })
}

function report(): void {
  if (!current) return
  markDead(current.id)
  if (REPORT_TO) {
    const subject = encodeURIComponent(`Report: ${current.id}`)
    const body = encodeURIComponent(
      `Video: https://www.youtube.com/watch?v=${current.id}\nTitle: ${current.t}\n\nWhy this should be removed from the pool:\n`,
    )
    window.location.href = `mailto:${REPORT_TO}?subject=${subject}&body=${body}`
    showBanner(
      'Thanks — that video is hidden for you, and your report is ready to send.',
    )
  } else {
    // Never claim a report was filed when nothing was sent.
    showBanner('That video is now hidden for you.')
  }
  void draw()
}

// --- boot -------------------------------------------------------------------
async function boot(): Promise<void> {
  try {
    ;[manifest, blocked] = await Promise.all([
      loadManifest(),
      // Blocklist (maintainer removals) and tombstones (sweep findings: gone or made
      // private) are both PERMANENT exclusions, so they merge into one set. Toggle-governed
      // filters — age-restriction, embeddability — are deliberately not in here.
      Promise.all([loadBlocklist(), loadTombstones()]).then((lists) =>
        lists.flat(),
      ),
    ])
  } catch {
    els.subhead.textContent = 'The pool could not be loaded.'
    showBanner(
      'The video pool is unavailable right now. Please try again later.',
    )
    return
  }

  const n = manifest.servable
  els.subhead.textContent =
    n > 0
      ? `A uniform random draw from ${nf.format(n)} public YouTube videos.`
      : 'The pool is still being built — no videos are ready to serve yet.'
  els.draw.disabled = n === 0

  const age = poolAgeDays(manifest)
  if (age !== null && age > STALE_AFTER_DAYS) {
    showBanner(
      `Heads up: the pool hasn't been updated in ${age} days — the harvester may be broken.`,
    )
  }
  els.poolinfo.textContent = manifest.generatedAt
    ? `Pool last updated ${new Date(manifest.generatedAt).toLocaleDateString()} · ${nf.format(manifest.total)} harvested`
    : ''

  els.draw.addEventListener('click', () => void draw())
  els.play.addEventListener('click', () => void play())
  // The control always works: it hides the video locally and redraws. Only the mailto
  // half depends on configuration, so the label and the banner say what actually
  // happened rather than claiming a report was filed when none was sent.
  // Reports deliberately do NOT fall back to public GitHub issues — that would build a
  // searchable public index of the worst content the site can surface.
  els.report.textContent = REPORT_TO ? 'Report this video' : 'Hide this video'
  els.report.addEventListener('click', report)
  els.safe.addEventListener('change', () => {
    els.banner.hidden = els.safe.checked
    if (!els.safe.checked) {
      showBanner(
        'Age-restriction and embeddability filtering are off. Removed, blocklisted and locally-hidden videos are still excluded.',
      )
    }
  })
}

void boot()
