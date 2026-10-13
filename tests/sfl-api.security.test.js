import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function loadHandler () {
  const path = require.resolve('../netlify/functions/sfl-api.cjs')
  delete require.cache[path]
  return require(path).handler
}

function event (path, {
  method = 'GET',
  origin = 'https://d1g.uk',
  headers = {},
  query = {},
} = {}) {
  return {
    httpMethod: method,
    path,
    headers: {
      origin,
      'x-nf-client-connection-ip': '203.0.113.10',
      ...headers,
    },
    queryStringParameters: query,
  }
}

describe('sfl-api proxy hardening', () => {
  beforeEach(() => {
    process.env.SFL_API_KEY = 'test-secret'
    process.env.SFL_API_KEY_DEV = 'test-secret-dev'
    process.env.SFL_PROXY_ALLOWED_ORIGINS = ''
    global.fetch = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ farm: { id: 1009 } }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.SFL_API_KEY
    delete process.env.SFL_API_KEY_DEV
    delete process.env.SFL_PROXY_ALLOWED_ORIGINS
  })

  it('only proxies the numeric community farm endpoint', async () => {
    const handler = loadHandler()
    const blocked = await handler(
      event('/.netlify/functions/sfl-api/admin/secrets'),
    )

    expect(blocked.statusCode).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('blocks unexpected browser origins before the upstream request', async () => {
    const handler = loadHandler()
    const blocked = await handler(
      event('/.netlify/functions/sfl-api/community/farms/1009', {
        origin: 'https://evil.example',
      }),
    )

    expect(blocked.statusCode).toBe(403)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('forwards an allowed farm read with the key only on the server side', async () => {
    const handler = loadHandler()
    const response = await handler(
      event('/.netlify/functions/sfl-api/community/farms/1009'),
    )

    expect(response.statusCode).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, options] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.sunflower-land.com/community/farms/1009')
    expect(options.headers['x-api-key']).toBe('test-secret')
    expect(response.body).not.toContain('test-secret')
  })

  it('does not allow query-string cache bypass anymore', async () => {
    const handler = loadHandler()
    const first = await handler(
      event('/.netlify/functions/sfl-api/community/farms/1009'),
    )
    const second = await handler(
      event('/.netlify/functions/sfl-api/community/farms/1009', {
        query: { bypassCache: '1' },
      }),
    )

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
