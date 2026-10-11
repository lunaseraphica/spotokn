# Spotify Tokener

Fast Spotify access-token service for LavaSrc, built with Bun, Elysia, and Playwright. It can serve anonymous tokens, client-credentials tokens, or authenticated `sp_dc` tokens depending on the environment configuration.

## Overview

This project exposes a lightweight API that generates valid Spotify access tokens and refreshes them automatically when needed. It is designed to work with LavaSrc or similar downstream services that need an endpoint to fetch tokens.

## Environment configuration

The app loads variables from `.env` automatically via the Bun scripts in `package.json`.

```env
HOST=0.0.0.0
BROWSER_PATH=/home/voidstar/.cache/ms-playwright/chromium-1194/chrome-linux/chrome
HEADLESS=true
PORT=3012
USE_SP_DC_AUTH=false
SPOTIFY_COOKIE=your_sp_dc_cookie_here
USE_CLIENT_CREDENTIALS=false
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
USE_ANONYMOUS=true
```

### Variables

- `HOST` — bind address for the HTTP server (`0.0.0.0` by default)
- `PORT` — port used by the service (`3012` in the current config)
- `HEADLESS` — set to `true` for server mode; set to `false` for debugging with a visible browser
- `BROWSER_PATH` — path to a Chrome/Chromium executable used by Playwright
- `USE_ANONYMOUS` — enable anonymous token mode (`true` in the current config)
- `USE_CLIENT_CREDENTIALS` — enable Spotify client-credentials flow (`false` by default)
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — credentials for client-credentials flow
- `USE_SP_DC_AUTH` — enable authenticated `sp_dc` cookie flow (`false` by default)
- `SPOTIFY_COOKIE` — Spotify `sp_dc` cookie value for authenticated mode

## Auth strategy

The token service resolves the mode in this priority order:

1. `USE_ANONYMOUS=true`
2. `USE_CLIENT_CREDENTIALS=true`
3. `USE_SP_DC_AUTH=true`
4. implicit fallback to `sp_dc` cookie if present
5. then client-credentials if configured
6. then anonymous token generation

With the current `.env`, the default behavior is anonymous token generation because:

- `USE_ANONYMOUS=true`
- `USE_CLIENT_CREDENTIALS=false`
- `USE_SP_DC_AUTH=false`

## Quick start

```bash
git clone https://github.com/lunaseraphica/spotokn.git
cd spotokn
bun install
npx playwright install chromium
bun run start
```

The service will listen on:

```text
http://0.0.0.0:3012
```

## Development

```bash
bun run dev
```

## API endpoints

### `GET /api/token`

Returns a Spotify access token.

Optional query params:

- `?force=1` — force a fresh token fetch
- `?debug=true` — return debug status information

Example:

```bash
curl "http://localhost:3012/api/token"
curl "http://localhost:3012/api/token?debug=true"
```

### `GET /health`

Returns service health and uptime information.

Example:

```bash
curl http://localhost:3012/health
```

## Example response

```json
{
  "success": true,
  "accessToken": "BQC7...",
  "accessTokenExpirationTimestampMs": 1678886400000,
  "clientId": "3a0ed...",
  "isAnonymous": true,
  "cached": false,
  "timestamp": 1678886300000
}
```

## Docker

Build the image:

```bash
docker build -t spotify-tokener .
```

Run it with the local `.env` file:

```bash
docker run -p 3012:3012 --env-file .env spotify-tokener
```

This matches the current server configuration, where the app listens on port `3012`.

## Troubleshooting

- If Playwright fails, run:

```bash
npx playwright install chromium --force
```

- If the browser is not found, confirm `BROWSER_PATH` points to a valid Chrome/Chromium executable.
- If token generation fails, verify the active auth mode and related environment variables.
- If you are using `SPOTIFY_COOKIE`, ensure it is the actual `sp_dc` cookie value and `USE_SP_DC_AUTH=true`.

## LavaSrc config example

```yaml
spotify:
  preferAnonymousToken: true
  customTokenEndpoint: "http://localhost:3012/api/token"
```
