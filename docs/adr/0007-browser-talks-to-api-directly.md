# ADR-0007: The browser talks to the API directly

Status: accepted (Phase 3)

## Context

The web app (Next.js, port 3000) and the API (NestJS, port 4000) are separate services. Files can be many gigabytes.

## Decision

The browser calls the API directly; Next.js only serves the UI. Cookies and CORS make this work:

- The API sets the session cookie (`httpOnly`, `SameSite=Lax`). `localhost:3000` and `localhost:4000` are the **same site**, so the cookie accompanies every request. In production use two hostnames under one registrable domain (for example `app.example.com` and `api.example.com`); different sites would need `SameSite=None` and are not supported.
- CORS allows only `WEB_ORIGIN`, with credentials, the methods the API uses, and the headers `Content-Type`, `X-CSRF-Token`, `Idempotency-Key` and `Range`.
- Uploads use `XMLHttpRequest` (real byte-level progress) straight to `/files/upload`. Downloads and previews are plain navigations or `<img>`/`<iframe>` sources pointing at `/files/:id/content`.
- Served files carry `Cross-Origin-Resource-Policy: same-site` and `frame-ancestors <WEB_ORIGIN>` so only the web app can embed them. Everything except PDFs is also sandboxed (ADR-0005 / threat model).
- The API address is baked into the web image at build time (`PUBLIC_API_URL` / `NEXT_PUBLIC_API_URL`).

## Consequences

- No extra proxy hop for large transfers, so memory and throughput stay what the API tests measured.
- The CSRF token travels in a header read from `/auth/me`; the page keeps it in memory only.
- Changing the public API URL means rebuilding the web image.

## Alternatives considered

- Proxying `/api` through Next.js rewrites: simplest cookies, but adds buffering risk and a copy of every byte for multi-GB files.
