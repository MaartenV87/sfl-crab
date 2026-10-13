// Netlify serverless function to proxy the one Sunflower Land endpoint used by
// this app. The SFL API key stays server-side; callers never receive it.
//
// Security goals:
// - this is NOT a generic authenticated proxy to api.sunflower-land.com;
// - only numeric /community/farms/:landId reads are allowed;
// - cross-origin browser calls are blocked unless explicitly trusted;
// - per-client request/bypass limits reduce accidental or abusive key usage;
// - cache bypass is server-throttled, so a client cannot hammer one farm.

const API_ORIGINS = {
  production: 'https://api.sunflower-land.com',
  test: 'https://api-dev.sunflower-land.com',
}

const CACHE_TTL_MS = 60_000
const BYPASS_COOLDOWN_MS = 15_000
const RATE_WINDOW_MS = 60_000
const REQUESTS_PER_WINDOW = 60
const BYPASS_REQUESTS_PER_WINDOW = 6
const MAX_TRACKED_CLIENTS = 2_000

const responseCache = new Map()
const requestRate = new Map()
const bypassRate = new Map()

const DEFAULT_ALLOWED_ORIGINS = [
  'https://d1g.uk',
  'https://www.d1g.uk',
  'https://beta.d1g.uk',
]

function headerValue (event, name) {
  const headers = event.headers || {}
  const wanted = name.toLowerCase()
  const exact = headers[wanted] ?? headers[name]
  if (exact !== undefined) return String(exact)
  return String(
    Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1] || '',
  )
}

function originFromUrl (value) {
  if (!value) return ''
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function allowedOrigins () {
  const configured = String(process.env.SFL_PROXY_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(originFromUrl)
    .filter(Boolean)

  const netlifyOrigins = [
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.DEPLOY_URL,
  ].map(originFromUrl).filter(Boolean)

  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...configured,
    ...netlifyOrigins,
  ])
}

function isAllowedOrigin (origin) {
  if (!origin) return true

  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  // Keep local Netlify/Vite development working without adding localhost to
  // production environment variables.
  if (
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1'
  ) return true

  return allowedOrigins().has(parsed.origin)
}

function responseHeaders (event) {
  const origin = headerValue(event, 'origin')
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Content-Type, x-sfl-api-env, x-sfl-bypass-cache',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  }

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

function resolveApiTarget (event) {
  const header = headerValue(event, 'x-sfl-api-env')
  const query = event.queryStringParameters?.env || ''
  const useTest = header === 'test' || query === 'test'
  const env = useTest ? 'test' : 'production'
  const apiKey = useTest ? process.env.SFL_API_KEY_DEV : process.env.SFL_API_KEY
  return { env, apiKey, origin: API_ORIGINS[env] }
}

function normalizeAllowedApiPath (event) {
  const rawPath = String(event.path || '')
  const prefix = '/.netlify/functions/sfl-api'
  if (!rawPath.startsWith(prefix)) return null

  const requested = rawPath.slice(prefix.length) || '/'
  const community = requested.match(/^\/community\/farms\/(\d{1,18})\/?$/)
  const legacy = requested.match(/^\/visit\/(\d{1,18})\/?$/)
  const match = community || legacy

  if (!match) return null

  const landId = match[1]
  return {
    landId,
    apiPath: `/community/farms/${landId}`,
    legacyVisit: Boolean(legacy),
  }
}

function wantsBypassCache (event) {
  // Deliberately accept only the custom header used by the app. A public
  // ?bypassCache=1 URL is too easy to turn into an upstream request amplifier.
  return headerValue(event, 'x-sfl-bypass-cache') === '1'
}

function clientIp (event) {
  const direct =
    headerValue(event, 'x-nf-client-connection-ip') ||
    headerValue(event, 'client-ip')

  if (direct) return direct.trim()

  const forwarded = headerValue(event, 'x-forwarded-for')
  return forwarded ? forwarded.split(',')[0].trim() : ''
}

function pruneRateMap (map, now) {
  if (map.size <= MAX_TRACKED_CLIENTS) return
  for (const [key, entry] of map) {
    if (now - entry.startedAt >= RATE_WINDOW_MS) map.delete(key)
    if (map.size <= MAX_TRACKED_CLIENTS) break
  }
}

function consumeRateLimit (map, key, limit, now = Date.now()) {
  // Netlify normally supplies a client IP. If it ever does not, do not group
  // unrelated visitors under a single "unknown" bucket.
  if (!key) return { allowed: true, retryAfterSeconds: 0 }

  pruneRateMap(map, now)
  const current = map.get(key)

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    map.set(key, { startedAt: now, count: 1 })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (current.count >= limit) {
    const retryMs = Math.max(1, RATE_WINDOW_MS - (now - current.startedAt))
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
    }
  }

  current.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

function logSflApi (fields) {
  // Never log the API key or outbound request headers.
  console.log('sfl-api', fields)
}

function getCachedResponse (cacheKey, maxAge = CACHE_TTL_MS) {
  const entry = responseCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.storedAt > maxAge) return null
  return entry
}

function setCachedResponse (cacheKey, statusCode, body) {
  responseCache.set(cacheKey, {
    storedAt: Date.now(),
    statusCode,
    body,
  })
}

function jsonResponse (event, statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...responseHeaders(event),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  }
}

exports.handler = async (event) => {
  const origin = headerValue(event, 'origin')
  if (origin && !isAllowedOrigin(origin)) {
    logSflApi({ status: 403, reason: 'origin_not_allowed' })
    return jsonResponse(event, 403, { error: 'Origin not allowed' })
  }

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: responseHeaders(event),
      body: '',
    }
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(event, 405, { error: 'Method not allowed' })
  }

  const route = normalizeAllowedApiPath(event)
  if (!route) {
    logSflApi({ status: 404, reason: 'path_not_allowed' })
    return jsonResponse(event, 404, { error: 'API path not allowed' })
  }

  const ip = clientIp(event)
  const requestLimit = consumeRateLimit(
    requestRate,
    ip,
    REQUESTS_PER_WINDOW,
  )
  if (!requestLimit.allowed) {
    logSflApi({
      status: 429,
      reason: 'client_rate_limit',
      landId: route.landId,
    })
    return jsonResponse(
      event,
      429,
      { error: 'Too many requests. Please wait and try again.' },
      { 'Retry-After': String(requestLimit.retryAfterSeconds) },
    )
  }

  const { env, apiKey, origin: apiOrigin } = resolveApiTarget(event)
  const cacheKey = `${env}:${route.apiPath}`

  if (!apiKey) {
    const keyName = env === 'test' ? 'SFL_API_KEY_DEV' : 'SFL_API_KEY'
    logSflApi({
      env,
      path: route.apiPath,
      landId: route.landId,
      status: 500,
      reason: 'missing_api_key',
    })
    return jsonResponse(event, 500, { error: `${keyName} not configured` })
  }

  const bypassRequested = wantsBypassCache(event)
  if (bypassRequested) {
    const bypassLimit = consumeRateLimit(
      bypassRate,
      ip,
      BYPASS_REQUESTS_PER_WINDOW,
    )
    if (!bypassLimit.allowed) {
      logSflApi({
        env,
        path: route.apiPath,
        landId: route.landId,
        status: 429,
        reason: 'bypass_rate_limit',
      })
      return jsonResponse(
        event,
        429,
        { error: 'Refresh limit reached. Please wait before refreshing again.' },
        { 'Retry-After': String(bypassLimit.retryAfterSeconds) },
      )
    }
  }

  // A bypass may refresh data after 15 seconds, but cannot force repeated
  // upstream SFL calls faster than that for the same farm on this warm worker.
  const cached = getCachedResponse(
    cacheKey,
    bypassRequested ? BYPASS_COOLDOWN_MS : CACHE_TTL_MS,
  )
  if (cached) {
    const cacheState = bypassRequested ? 'bypass-throttled' : 'hit'
    logSflApi({
      env,
      path: route.apiPath,
      landId: route.landId,
      status: cached.statusCode,
      cache: cacheState,
    })
    return {
      statusCode: cached.statusCode,
      headers: responseHeaders(event),
      body: cached.body,
    }
  }

  const apiUrl = `${apiOrigin}${route.apiPath}`

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    })

    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch (parseError) {
        logSflApi({
          env,
          path: route.apiPath,
          landId: route.landId,
          status: 502,
          reason: 'invalid_json',
        })
        console.error(
          'API JSON parse error:',
          parseError.message,
          'status:',
          response.status,
        )
        return jsonResponse(event, 502, {
          error: 'Invalid JSON from Sunflower Land API',
        })
      }
    }

    const body = JSON.stringify(data)
    if (response.status === 200) {
      setCachedResponse(cacheKey, response.status, body)
    }

    logSflApi({
      env,
      path: route.apiPath,
      landId: route.landId,
      status: response.status,
      cache: bypassRequested ? 'bypass' : 'miss',
      ...(route.legacyVisit ? { legacyVisit: true } : {}),
    })

    return {
      statusCode: response.status,
      headers: responseHeaders(event),
      body,
    }
  } catch (error) {
    logSflApi({
      env,
      path: route.apiPath,
      landId: route.landId,
      status: 500,
      reason: 'fetch_error',
    })
    console.error('API Error:', error)
    return jsonResponse(event, 500, {
      error: 'Failed to fetch data from Sunflower Land API',
    })
  }
}
