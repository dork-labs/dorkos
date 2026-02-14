# ngrok Tunnel Integration

**Slug:** ngrok-tunnel
**Author:** Claude Code
**Date:** 2026-02-12
**Branch:** feature/ngrok-tunnel
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Integrate ngrok tunnel support directly into the DorkOS server so users can access the gateway externally without manual network configuration. The tunnel should optionally auto-start when the server boots, be controlled via environment variables, support HTTP basic auth, and work in both production and dev mode.

**Assumptions:**
- Users have (or will create) a free ngrok account for an auth token
- The tunnel is a server-side concern only — no client UI changes needed initially
- In production mode, Express serves the built React client, so tunneling Express port is sufficient
- In dev mode, users can tunnel the Vite dev server port (3000) to get the full UI+API experience since Vite proxies `/api` to Express
- The Vite dev server already has `allowedHosts: ['.ngrok-free.app']` configured
- CORS is currently set to allow all origins via `cors()` middleware in `app.ts`

**Out of scope:**
- Client-side UI for tunnel management (start/stop/display URL in the web app)
- Obsidian plugin tunnel support (DirectTransport bypasses HTTP entirely)
- Paid ngrok features (custom domains documented but not required)
- Alternative tunnel providers (cloudflare, localtunnel) — evaluated but deferred
- Vite HMR configuration changes (users can manually set `clientPort: 443` if needed)

---

## 2) Pre-reading Log

- `apps/server/src/index.ts`: Server entry point. Loads dotenv, creates Express app, listens on `localhost:PORT`. No existing SIGINT/SIGTERM handlers. No async startup logic.
- `apps/server/src/app.ts`: Express app factory. Uses `cors()` (permissive), JSON middleware, static file serving for production, mounts routes. All middleware is synchronous.
- `apps/server/src/routes/health.ts`: Minimal health endpoint returning `{ status, version, uptime }`. No imports of services — purely stateless.
- `apps/server/src/services/agent-manager.ts`: Singleton pattern (`export const agentManager = new AgentManager()`). Class-based service with constructor, exported at module level. This is the pattern to follow for TunnelManager.
- `apps/server/src/services/transcript-reader.ts`: Same singleton pattern (`export const transcriptReader = new TranscriptReader()`).
- `apps/server/src/routes/__tests__/sessions.test.ts`: Shows the testing pattern: `vi.mock()` services before importing app, use `request(app)` from supertest, `vi.clearAllMocks()` in beforeEach.
- `apps/server/src/routes/__tests__/health.test.ts`: Existing health test — will need to be updated to mock tunnel-manager and test the tunnel status field.
- `packages/shared/src/schemas.ts`: All Zod schemas with `.openapi()` metadata. `HealthResponseSchema` has `{ status, version, uptime }`. Will add optional `tunnel` field.
- `packages/shared/src/types.ts`: Re-exports all types from `schemas.ts`. Will add `TunnelStatus` and `HealthResponse`.
- `packages/shared/src/transport.ts`: `Transport` interface. `health()` returns `{ status, version, uptime }`. Will extend return type.
- `turbo.json`: Env vars for build: `["NODE_ENV", "VITE_*", "GATEWAY_PORT"]`. Dev tasks have `cache: false`.
- `.env`: Only contains `GATEWAY_PORT=6942`.
- `apps/server/package.json`: Dependencies include Express, Claude SDK, cors, dotenv, gray-matter. Scripts include `dev` (tsx watch), `build` (tsc).
- `apps/client/vite.config.ts`: Already has `server.allowedHosts: ['.ngrok-free.app']` — ngrok domains are pre-allowed.
- `apps/server/src/services/openapi-registry.ts`: Registers OpenAPI schemas. Health endpoint is registered — will need to update the response schema.
- `guides/architecture.md`: Documents the hexagonal architecture, Transport interface, and service patterns.

---

## 3) Codebase Map

**Primary Components/Modules:**
- `apps/server/src/index.ts` — Server entry point, startup flow, will wire tunnel startup here
- `apps/server/src/app.ts` — Express app factory with CORS and middleware (already permissive CORS)
- `apps/server/src/routes/health.ts` — Health endpoint, will expose tunnel status
- `apps/server/src/services/agent-manager.ts` — Reference for singleton service pattern
- `packages/shared/src/schemas.ts` — Zod schemas (HealthResponseSchema to extend)
- `packages/shared/src/types.ts` — Type re-exports
- `packages/shared/src/transport.ts` — Transport interface (health() method signature)

**Shared Dependencies:**
- `packages/shared/` — Types, schemas, Transport interface (cross-app contract)
- `apps/server/src/services/openapi-registry.ts` — OpenAPI spec generation
- `turbo.json` — Build environment variable declarations
- `.env` — Environment variable configuration

**Data Flow:**
Server boots → `index.ts` creates app → `app.listen()` on PORT → (if TUNNEL_ENABLED) → TunnelManager.start() → ngrok.forward() → Public URL generated → Logged to console → Health endpoint includes tunnel status

**Feature Flags/Config:**
- `TUNNEL_ENABLED` — Master switch (env var, default: undefined/disabled)
- `NGROK_AUTHTOKEN` — Auth token (env var, read by SDK from env by default)
- `TUNNEL_PORT` — Port to tunnel (env var, default: GATEWAY_PORT)
- `TUNNEL_AUTH` — HTTP basic auth (env var, format: "user:pass")
- `TUNNEL_DOMAIN` — Custom/reserved domain (env var, optional)

**Potential Blast Radius:**
- **Direct (new):** 1 file — `apps/server/src/services/tunnel-manager.ts`
- **Direct (modify):** 5 files — `index.ts`, `health.ts`, `schemas.ts`, `types.ts`, `transport.ts`
- **Config:** 3 files — `apps/server/package.json`, `turbo.json`, `.env`
- **Tests (new):** 1 file — `apps/server/src/services/__tests__/tunnel-manager.test.ts`
- **Tests (modify):** 1 file — `apps/server/src/routes/__tests__/health.test.ts`
- **Indirect:** Existing route tests that mock agent-manager may need a tunnel-manager mock added to prevent import errors (sessions.test.ts, commands.test.ts, etc.)

---

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

---

## 5) Research

### Approach Comparison

**1. @ngrok/ngrok (Official SDK)** — RECOMMENDED

- **Description:** Official Node.js SDK. TypeScript-native, no binary downloads, programmatic API via `ngrok.forward()`.
- **Pros:**
  - TypeScript-native with full type definitions
  - Lightweight (~10-20MB, no binary download at install time)
  - Official ngrok support, actively maintained
  - Graceful shutdown via `listener.close()`
  - Built-in basic auth: `basic_auth: ["user:pass"]`
  - `onStatusChange` callback for connection monitoring ('connected' | 'closed')
  - `authtoken_from_env` reads `NGROK_AUTHTOKEN` automatically
  - Domain option: `domain: "my-app.ngrok-free.app"` (free tier gets 1 static domain)
- **Cons:**
  - Free tier: 1GB/month bandwidth, session disconnects after inactivity
  - Interstitial warning page on free tier (7-day cookie bypass or `ngrok-skip-browser-warning` header)
  - Requires ngrok account + authtoken
  - Platform-specific optional dependencies (native bindings)
- **Complexity:** Low — one function call to start tunnel
- **Maintenance:** Active — official ngrok project

**2. cloudflared (Cloudflare Tunnel)**

- **Description:** Cloudflare's tunneling solution. Free unlimited bandwidth.
- **Pros:**
  - Free with **no bandwidth limits** and **no session duration limits**
  - No interstitial warning
  - Exceptional performance (Cloudflare CDN)
  - Custom domains on free tier (with Cloudflare DNS)
- **Cons:**
  - No official Node.js SDK — must shell out to `cloudflared` CLI binary
  - Requires Cloudflare account + DNS configuration
  - More complex initial setup
  - Binary download required (~50MB)
- **Complexity:** Medium — requires DNS config and binary management
- **Maintenance:** Active (Cloudflare official)

**3. localtunnel**

- **Description:** Open-source tunneling, no account required.
- **Pros:** No account needed, open source, TypeScript types included
- **Cons:** Frequent disconnections, slow performance, limited security
- **Complexity:** Low
- **Maintenance:** Community-driven, reliability issues

**4. ngrok (npm CLI wrapper) — DEPRECATED**

- **Description:** Older wrapper that downloads ngrok binary at install time.
- **Pros:** Simple API, widely known
- **Cons:** Deprecated in favor of `@ngrok/ngrok`, larger install (~30-50MB), less TypeScript-friendly
- **Not recommended for new projects.**

### Security Considerations

1. **HTTP basic auth is secure over ngrok** — all traffic uses TLS 1.3
2. **Interstitial warning** on free tier — bypassed with header or 7-day cookie
3. **Exposing Claude Code sessions is risky** — warn users about sensitive data exposure. Always use HTTP basic auth at minimum.
4. **No known CVEs** in `@ngrok/ngrok` SDK
5. **ngrok is sometimes abused by attackers** — only use for trusted development scenarios

### Performance Considerations

- **Latency:** ngrok adds ~50-200ms (routes through edge servers)
- **Bandwidth:** Free tier is 1GB/month — streaming AI responses can consume this quickly
- **For heavy use:** Consider cloudflared (unlimited free bandwidth) as a future alternative

### Dev Mode Considerations (Vite HMR)

- **Vite HMR through ngrok works** but requires `server.hmr.clientPort: 443` in `vite.config.ts`
- **WebSocket proxying** is supported by ngrok by default — no special config needed
- **Interstitial warning** may block initial WebSocket connection — user must click "Visit" once to set cookie
- **A `vite-plugin-ngrok` exists** ([aphex/vite-plugin-ngrok](https://github.com/aphex/vite-plugin-ngrok)) — could be evaluated later for tighter integration
- **Current approach (tunneling from Express side)** avoids any Vite config changes — simpler for users

### Recommendation

**`@ngrok/ngrok` (Official SDK)** is the clear winner for this project:
1. TypeScript-native — aligns with the codebase
2. Programmatic API — no subprocess management or binary downloads
3. Dynamic import — zero cost when not enabled
4. Built-in basic auth — matches our security requirement
5. Singleton pattern — fits existing service architecture
6. Graceful shutdown — `listener.close()` integrates with process signals

**Future consideration:** If users hit free tier bandwidth limits from streaming AI responses, cloudflared could be offered as an alternative provider behind the same `TunnelManager` interface.

---

## 6) Decisions (Resolved)

1. **Vite HMR config:** Add `server.hmr.clientPort: 443` to `vite.config.ts` unconditionally. This is harmless when not using a tunnel (Vite falls back gracefully) and means HMR "just works" over ngrok without any manual steps. **Decision: Auto-configure.**

2. **Tunnel failure behavior:** Tunnel failure does NOT block server startup. Catch the error, log a warning, continue without tunnel. The server is always the primary concern. **Decision: Non-blocking.**

3. **Tunnel URL in client UI:** Console-only for v1. Print URL to server console + include in `/api/health` response. No client-side changes in this feature. Can revisit in a follow-up. **Decision: Console-only.**

4. **Free tier limits warning:** Include bandwidth and session limits in the console output box and in `.env` comments so users are informed. **Decision: Warn prominently.**

5. **`dev:tunnel` default port:** Default to port 3000 (Vite) for the full UI+API experience. Document port 6942 for API-only tunneling. **Decision: Port 3000.**

---

## Sources

### Official Documentation
- [@ngrok/ngrok - npm](https://www.npmjs.com/package/@ngrok/ngrok)
- [JavaScript SDK Quickstart](https://ngrok.com/docs/getting-started/javascript)
- [forward() API Docs](https://ngrok.github.io/ngrok-javascript/functions/forward.html)
- [Config Interface](https://ngrok.github.io/ngrok-javascript/interfaces/Config.html)
- [Free Plan Limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)
- [ngrok Pricing](https://ngrok.com/pricing)
- [Static dev domains for free users](https://ngrok.com/blog/free-static-domains-ngrok-users/)

### Security
- [Basic Auth Action](https://ngrok.com/docs/traffic-policy/actions/basic-auth)
- [Authentication with ngrok](https://ngrok.com/blog/authentication-with-ngrok)

### Vite HMR
- [Using reverse proxy like Ngrok with Vite HMR](https://github.com/vitejs/vite/discussions/5399)
- [HMR over ngrok with 1 tunnel](https://github.com/vitejs/vite/discussions/13552)
- [Vite Server Options](https://vite.dev/config/server-options)
- [vite-plugin-ngrok](https://github.com/aphex/vite-plugin-ngrok)

### Alternatives
- [Cloudflare Tunnel vs ngrok](https://instatunnel.my/blog/comparing-the-big-three-a-comprehensive-analysis-of-ngrok-cloudflare-tunnel-and-tailscale-for-modern-development-teams)
- [localtunnel - npm](https://www.npmjs.com/package/localtunnel)
- [Speed Test Comparison](https://www.localcan.com/blog/ngrok-vs-cloudflare-tunnel-vs-localcan-speed-test-2025)
