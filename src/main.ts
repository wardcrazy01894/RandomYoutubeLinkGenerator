import './style.css'
import {
  loadManifest,
  loadBlocklist,
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
const REPORT_TO = import.meta.env.VITE_REPORT_EMAIL ?? ''

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
  const list = readDead().filter((x) => x !== id)
  list.push(id)
  localStorage.setItem(DEAD_KEY, JSON.stringify(list.slice(-DEAD_LIST_CAP)))
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

  const bits = [
    record.pub ? new Date(record.pub).getFullYear().toString() : null,
    `${nf.format(record.v)} view${record.v === 1 ? '' : 's'}`,
    formatDuration(record.dur),
    record.age ? 'age-restricted' : null,
  ].filter(Boolean)
  els.meta.textContent = bits.join(' · ')
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
  const subject = encodeURIComponent(`Report: ${current.id}`)
  const body = encodeURIComponent(
    `Video: https://www.youtube.com/watch?v=${current.id}\nTitle: ${current.t}\n\nWhy this should be removed from the pool:\n`,
  )
  if (REPORT_TO)
    window.location.href = `mailto:${REPORT_TO}?subject=${subject}&body=${body}`
  showBanner(
    'Thanks — that video is now hidden for you and flagged for removal from the pool.',
  )
  void draw()
}

// --- boot -------------------------------------------------------------------
async function boot(): Promise<void> {
  try {
    ;[manifest, blocked] = await Promise.all([loadManifest(), loadBlocklist()])
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
  // Without a contact address the Report control cannot send anything, and
  // `report()` would silently do nothing — a dead safety affordance is worse than a
  // visibly absent one. Reports deliberately do NOT fall back to public GitHub issues:
  // that would build a searchable public index of the worst content on the site.
  if (REPORT_TO) {
    els.report.addEventListener('click', report)
  } else {
    els.report.hidden = true
    console.warn('VITE_REPORT_EMAIL is unset — the Report control is hidden.')
  }
  els.safe.addEventListener('change', () => {
    els.banner.hidden = els.safe.checked
    if (!els.safe.checked) {
      showBanner(
        'Age-restriction filtering is off. This is the full uniform pool, unfiltered.',
      )
    }
  })
}

void boot()
