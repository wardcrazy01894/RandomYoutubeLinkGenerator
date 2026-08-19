// Minimal YouTube Data API v3 client.
//
// API key only — never OAuth, never a cookie, never a user session. That invariant
// (docs/DESIGN.md §3.6) is what keeps a personal Google account out of the blast
// radius if anything here is ever considered abusive.

const API = 'https://www.googleapis.com/youtube/v3'

/** Unit costs, from the published quota table. */
export const COST = { search: 100, videos: 1 }

export class QuotaExceeded extends Error {}
export class ApiKeyError extends Error {}

/**
 * Errors are split into three classes because they need opposite handling:
 *   - quotaExceeded  -> expected daily; the run stops cleanly and exits 0
 *   - key/access     -> fatal misconfiguration; must page a human
 *   - everything else-> transient; retried with backoff
 */
async function call(endpoint, params, key, { retries = 5 } = {}) {
  const url = new URL(`${API}/${endpoint}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  url.searchParams.set('key', key)

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } })
    } catch (err) {
      lastErr = err
      await sleep(500 * 2 ** attempt)
      continue
    }

    if (res.ok) return res.json()

    const body = await res.text()
    const reason = extractReason(body)

    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new QuotaExceeded(`quota exhausted (${reason})`)
    }
    if (
      reason === 'keyInvalid' ||
      reason === 'accessNotConfigured' ||
      reason === 'forbidden'
    ) {
      throw new ApiKeyError(
        `API key problem: ${reason} — ${body.slice(0, 300)}`,
      )
    }
    if (res.status === 429 || res.status >= 500) {
      // 429 here is the per-minute rate limit, NOT the daily quota (that arrives as
      // quotaExceeded above). Backing off generously is correct and cheap.
      lastErr = new Error(`${res.status} ${reason ?? ''}`)
      await sleep(2000 * 2 ** attempt)
      continue
    }
    throw new Error(`${endpoint} failed: ${res.status} ${body.slice(0, 300)}`)
  }
  throw lastErr ?? new Error(`${endpoint} failed after ${retries} retries`)
}

function extractReason(body) {
  try {
    return JSON.parse(body)?.error?.errors?.[0]?.reason ?? null
  } catch {
    return null
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One page of search results. `regionCode`/`relevanceLanguage` are pinned explicitly
 * because results are locale-conditioned and an unpinned locale is an unmeasured,
 * silently-drifting bias (docs/DESIGN.md §3.3.6).
 */
export async function searchPage(key, q, pageToken) {
  const data = await call(
    'search',
    {
      part: 'id',
      q,
      type: 'video',
      maxResults: 50,
      regionCode: 'US',
      relevanceLanguage: 'en',
      safeSearch: 'none', // completeness at harvest; safety subsetting happens at serve time
      pageToken,
    },
    key,
  )
  return {
    ids: (data.items ?? []).map((i) => i.id?.videoId).filter(Boolean),
    nextPageToken: data.nextPageToken ?? null,
    totalResults: data.pageInfo?.totalResults ?? null,
  }
}

/**
 * Bulk metadata, 50 IDs per unit. This is what makes safety subsetting, embeddability
 * accounting, and the era-independence test affordable (docs/DESIGN.md §3.6).
 */
export async function videosMeta(key, ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const data = await call(
      'videos',
      { part: 'snippet,status,contentDetails,statistics', id: chunk.join(',') },
      key,
    )
    for (const v of data.items ?? []) {
      out.push({
        id: v.id,
        title: v.snippet?.title ?? '',
        publishedAt: v.snippet?.publishedAt ?? null,
        // NOTE: channel title is deliberately NOT stored — frequently a real person's
        // name, and a public repo full of them is a GDPR processing activity (§5.5).
        embeddable: v.status?.embeddable === true,
        privacyStatus: v.status?.privacyStatus ?? null,
        ageRestricted:
          v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
        duration: v.contentDetails?.duration ?? null,
        views: Number(v.statistics?.viewCount ?? 0),
        madeForKids: v.status?.madeForKids === true,
      })
    }
  }
  return out
}
