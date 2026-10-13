# Netlify Functions

## Hub auth (`hub-auth`)

Proxies `/api/hub-auth/*` → `{HUB_API_BASE}/v1/auth/*` (passwordless: Google OAuth, email approve-link/login, `/me`, logout).

Forwards `Authorization` when present. Hub backend must implement these routes (no password endpoints).

## Dig day snapshots (`dig-day`)

Proxies to **SFL Digging Hub** (`HUB_API_BASE` + `HUB_WRITE_SECRET` in Netlify env).

- **GET** `/api/dig-day?landId=12345&utcDate=2026-05-18`
- **POST** `/api/dig-day` with JSON body (`v`, `landId`, `utcDate`, `patterns`, `digs`, `markEvents`, `stats`)

Forwards `Authorization` when present (signed-in attribution). Guests still POST via `X-Hub-Write-Secret`.

Data is public by `landId`. Mark events merge append-only by `seq` (handled on hub).

GET responses use `Cache-Control: public, max-age=120`. The proxy forwards `If-None-Match` and exposes Hub `ETag` when present. See [`docs/HUB_CONSUMPTION_SPEC.md`](../../docs/HUB_CONSUMPTION_SPEC.md) for Hub-side idempotency and conditional GET work.

### Legacy blobs (migration only)

Old data may still be in Netlify Blobs `dig-day-snapshots`. Import with `sfl-digging-hub/scripts/import-blobs-to-hub.mjs`.

## Practice patterns (`practice-patterns`)

Daily pattern cache in store `practice-daily-patterns`. See `_practiceDailyStore.cjs`.

## Sunflower Land proxy (`sfl-api`)

The proxy deliberately exposes **one read-only route only**:

`/.netlify/functions/sfl-api/community/farms/:numericLandId`

The legacy `/visit/:numericLandId` URL is accepted for compatibility but is normalized server-side to the same community-farm endpoint. Arbitrary Sunflower Land API paths are rejected, so the server-side API key cannot be used as a general-purpose proxy credential.

Browser CORS is limited to the production/beta site origins, localhost for development, Netlify's current deploy origins, and optional comma-separated `SFL_PROXY_ALLOWED_ORIGINS`. This is defense in depth; endpoint allowlisting and server-side throttling remain the real security boundary.

Structured logs go to **Netlify function logs** (Site → Functions → sfl-api → Logs). The key and outbound authentication headers are never logged.

Successful responses are cached in-memory for 60s. User refresh may request bypass with the `x-sfl-bypass-cache: 1` header, but:
- query-string bypass is rejected/ignored;
- bypass requests are client-rate-limited;
- a warm function instance will not hit SFL more than once per 15 seconds for the same farm/environment;
- normal requests are also client-rate-limited.

These in-memory limits are abuse reduction, not a globally distributed WAF. For higher traffic, add platform-level Netlify rate limiting in front of the function as well.

## Admin UI (`/admin`)

Password-protected blob browser. Set `ADMIN_PASSWORD` in Netlify env (or `.env` for `netlify dev`), then open `/admin` on the site.

API: `GET/DELETE/POST /api/admin-blobs` with `Authorization: Bearer <ADMIN_PASSWORD>` (see `admin-blobs.cjs`).
