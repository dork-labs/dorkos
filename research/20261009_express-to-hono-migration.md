---
title: 'Moving the local server (apps/server) from Express 5 to Hono: inventory, risks and strategy'
date: 2026-10-09
type: internal-architecture
status: active
tags: [server, express, hono, migration, strangler, sse, mcp, a2a, extensions, testing]
feature_slug: express-to-hono
linear: DOR-2742
---

# Moving the local server from Express 5 to Hono

## Summary

`apps/server` is an Express 5 app: **100 route files, 489 route registrations, 151 non-test source files and 176 test files importing `express`, 224 test files using supertest** (counts from `grep` on `origin/main` `b05cc6065d`, 2026-10-09). The operator decided on 2026-10-06 to move it to Hono now, as step 1 of merging it with the space server (`apps/community`, already Hono on `@hono/node-server`). Decision record: `plans/2026-10-vision-reset-decisions.md` item 3; ADR `261006-235238` already retired the "do not migrate the local Express server" clause of `260916-210001`.

**Recommendation: confirm the strangler hypothesis, with one change to how middleware runs.** Hono becomes the front door in the first PR (`@hono/node-server`), and the whole existing Express app sits behind one catch-all fallthrough route. Each later PR moves one route group into Hono. Every request runs **exactly one** middleware chain: the Express chain for routes still in Express, a ported Hono chain for routes already moved. Express is deleted at the end. The app works at every step.

Parity is proven three ways, none of which the moving PR may edit: a **route census** (every method + path pair is served by exactly one of the two frameworks, and the union equals a committed baseline), **per-group contract tests** that drive the composed server over real HTTP and so pass unchanged before and after a move, and the existing **`openapi-fresh`** check (the OpenAPI spec is generated from a registry that does not depend on the framework, so it must stay byte-identical).

Nothing found blocks the move. The four places that need real design work are: **extension server routes** (the public extension API hands authors a live `express.Router`), **A2A** (its SDK adapter is Express-only, but the SDK's transport handler is framework-free), **the durable SSE streams** (keep the existing sink by writing to the raw Node response through Hono's escape hatch), and **request-scoped state** (`res.locals` in 36 files, `req.app.locals` as a DI container in about 20 call sites).

Plan: **27 PRs, about 4 to 5 weeks with one implementation chat**, with session and message routes last, after DOR-2790 lands. The ordered breakdown is `plans/2026-10-express-to-hono.md` (tickets DOR-2792 to DOR-2818 under DOR-2742); the decision is ADR `261009-192542` (proposed).

## Method

- Read `apps/server/src/app.ts`, `index.ts`, every file in `middleware/`, every router, `packages/a2a-gateway`, `packages/extension-api`, `packages/test-utils`, `packages/cli/scripts/build.ts`, `apps/desktop/src/main/server-spawn.ts` and `apps/community/src`.
- Read installed sources for `@hono/node-server@1.19.17`, `hono@4.13.12`, `@modelcontextprotocol/sdk@1.30.1` and `@a2a-js/sdk@1.2.0` in `node_modules/.pnpm`.
- Listed open PRs (`gh pr list`, 2026-10-09) and the server files each one touches.
- Prior research: `research/20260309_mcp_server_express_embedding.md` (why `/mcp` was embedded in Express) and `research/20260309_upload_files_react_express.md` (why multer). Nothing earlier covers a framework move.

## Risk scale

- **Low**: mechanical; a missed detail fails a test loudly.
- **Medium**: behavior is subtle (ordering, streaming, body semantics); needs a dedicated parity test.
- **High**: security posture or a public contract; a mistake fails open or breaks someone else's code.

## Inventory

### 1. Bootstrap and middleware order

**Where:** `apps/server/src/app.ts` (`createApp()` and `finalizeApp()`), `apps/server/src/index.ts` (6,380 lines; mounts about 40 more routers between the two calls, then `finalizeApp(app)` at about line 6034 and `app.listen` through `startMainListener` at about line 6071).

**Order today** (`app.ts`):

1. `terminalAdmission(admission)`: 503 once shutdown starts (`middleware/terminal-admission.ts`).
2. `app.set('trust proxy', 1)`: used only for `req.protocol`/`req.secure` (Better Auth's `Secure` cookie). Nothing security-relevant reads `req.ip` or `req.hostname`.
3. A one-shot "first API request" log on `/api`.
4. `cors` (`buildCors()`, delegate form, backed by `isTrustedBrowserOrigin` in `lib/trusted-origins.ts`).
5. Hand-rolled `X-Content-Type-Options: nosniff`.
6. `hostGuard` on `/api` (DNS-rebinding defense, before any body is parsed).
7. Optional signed connector webhook ingress (`/api/connectors/webhooks/:providerInstanceId`).
8. Auth rate limiter, then Better Auth via `app.all('/api/auth/*splat', toNodeHandler(auth))`, **before** `express.json` because Better Auth reads its own body.
9. Per-path body parsers that must run before the global one: `/api/feedback` (larger), `express.raw` on `/api/relay/webhooks/:adapterId`, `/api/canvas/docs` (smaller).
10. `express.json({ limit: '1mb' })`.
11. `requestLogger`, `sessionGate`, `resolveAgentIdentity` (to `res.locals.agentIdentity`), `auditActor` (AsyncLocalStorage scope), `auditRequestFallback` (`res.on('finish')`).
12. About 30 `/api/*` routers; `index.ts` adds about 40 more, plus `/mcp`, `/a2a` and the late capability routers.
13. `finalizeApp`: `/api` 404 JSON (`API_NOT_FOUND`), `errorHandler`, then static serving and the SPA fallback (production only).

**How it moves:** Hono middleware is `app.use(path, async (c, next) => …)` and runs in registration order like Express, so the order ports one to one. The chain becomes one exported `apiChain(app, deps)` function in a new `apps/server/src/http/` folder, mirroring `apps/community/src/app.ts`, which registers `onError` first, then a combined `/api/*` guard, then path-scoped limiters, then Better Auth, then routes.

**Risk: Medium.** Ordering is load-bearing in three places: Better Auth before body parsing, per-path body limits before the global one, and `hostGuard` before any parse. A chain-parity test (below) pins all three.

### 2. Error handling and 404s

**Where:** `middleware/error-handler.ts` (4-argument Express handler; checks `res.headersSent` first; maps `BoundaryError` 403, `SessionDiscoveryUnavailableError` 503, `AmbiguousSessionError` 409, `RuntimeNotRegisteredError` 503, body-parser `entity.too.large` 413, everything else 500 with the message hidden in production). The same `headersSent` guard is copied inline in `routes/uploads.ts` and `routes/mcp.ts`. The `/api` 404 is in `finalizeApp`.

**How it moves:** `app.onError((err, c) => …)` plus `app.notFound`, the same shape as `apps/community/src/http.ts` (`handleError`, `ApiError`, `RateLimited`). Keep the server's own error classes and status mapping; do not adopt community's blanket 503. The error-handler test (`middleware/__tests__/error-handler.test.ts`) duck-types `req`/`res`, so only its mocks change.

**Risk: Low.** One subtlety: Hono's `onError` cannot fire after a streamed response has started, which is what the `headersSent` guard handled by hand; streaming routes must catch their own errors (they already do).

### 3. Express 5 semantics

- **Empty POST body is `undefined`.** About 20 handlers use `req.body ?? {}` (e.g. `routes/workspaces.ts:137`, `routes/session-continue.ts:127,159`, `routes/agents.ts:454,481`, `routes/relay.ts:410`, `routes/permissions.ts:172`, `routes/extensions-approval.ts:197`, `routes/remote-communities.ts:675`). In Hono, `c.req.json()` **throws** on an empty body. **Move:** one helper, `readJsonBody(c, schema, { emptyAs: {} })`, shaped like community's `readJson`, that treats an empty body exactly as today and maps malformed JSON to the same 400. **Risk: Medium** (a missed route turns a valid empty POST into a 400; the contract tests include an empty-body case for every POST that has one today).
- **Wildcards.** Only `/api/auth/*splat`; the SPA fallback is deliberately pathless because `app.get('*')` throws under path-to-regexp v8. Mesh has one wildcard route (`routes/mesh.ts`), the extension proxy uses `ALL /proxy/*`, and the test-only mock OAuth server uses `/.well-known/*`. Hono's router uses `*` and `:name{regex}` natively. **Risk: Low.**
- **`res.sendFile`** with `{ root }` (static fallback, `routes/uploads.ts`, `routes/files.ts`, `routes/profile.ts`, `routes/rooms.ts`). Express 5's `send` reports a missing file through `err.status === 404`. **Move:** `serveStatic` for the client; a small `sendFileFromRoot(c, root, name)` helper (realpath plus prefix check, as today) for the rest. **Risk: Medium** (path-traversal guards must be carried over word for word; keep the existing traversal tests).
- **`trust proxy`.** Drop it; Hono reads forwarded headers only when asked. Better Auth's `Secure` cookie decision must read `X-Forwarded-Proto` through the same rule (`DORKOS_TRUST_PROXY`). **Risk: Low.**

### 4. Request-scoped state and dependency injection

- **`res.locals`** in 36 files: `res.locals.user` (session gate), `res.locals.agentIdentity`, and test fakes that set them. **Move:** typed Hono variables (`Hono<{ Variables: { user?: RequestUser; agentIdentity?: … } }>`, `c.set`/`c.get`). Community has no precedent (it uses closures only), so this is the one new pattern, and it is Hono's documented one.
- **`req.app.locals`** as a DI container in about 20 call sites (`activityService`, `meshCore`, `roomSessionPlace`, in `extensions.ts`, `extensions-approval.ts`, `extension-decisions.ts`, `agents.ts`, `mesh.ts`, `runtimes-account-eligibility.ts`, `session-continue.ts`, `extensions-trusted-sources.ts`, `sessions.ts`). **Move:** explicit dependencies passed to each `create<Group>Routes(deps)` factory, community's closure style.
- **Shared helpers that take an Express `Request`:** `verifyRequestAuth(req: Pick<Request,'headers'>)` (`services/core/auth/session-gate.ts:184`, already only reads headers), `resolveBrowserOriginFacts(req)` (`middleware/browser-origin.ts`), `rateLimitKey(req)` (`middleware/rate-limit-key.ts`, reads `req.socket.remoteAddress`), and `clearsTheAgentBar` / `refuseUnlessAccountOwner` / `isPersonAtTheApp` (`lib/caller-authority.ts:305,343,382`, read headers plus `res.locals`). **Move:** one small `RequestFacts` type (headers, method, path, remote address, user, agent identity) with an Express adapter and a Hono adapter, so the policy code stays single and both chains call it.

**Risk: Medium.** Mechanical but wide; `caller-authority.ts` is a security gate, so its existing tests run against both adapters.

### 5. Auth gates

**Where:** `services/core/auth/session-gate.ts` (`sessionGate`, exemptions: non-API paths, `/api/auth/*`, `/api/health` except `/api/health/deep`, `/api/workbench/serve/*`), `middleware/host-guard.ts`, `middleware/mcp-auth.ts`, `middleware/mcp-origin.ts`, `middleware/mcp-enabled.ts`, `middleware/spaces-enabled.ts`, `middleware/agent-execution-gate.ts`, `lib/caller-authority.ts`. No CSRF middleware: protection is the origin and host checks plus Better Auth's cookie defaults.

**Better Auth:** today `toNodeHandler(auth)` from `better-auth/node`. Hono calls the web handler directly: `app.on(['GET','POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))`, exactly as `apps/community/src/app.ts` does.

**Risk: High.** These gates fail open if a path slips past them. Mitigations: the chain-parity matrix (section "Proving parity") runs every combination of login on/off, trusted/untrusted origin, loopback/foreign host, cookie/API key/local MCP token/agent header/none, across one representative route per gate, and asserts the same status from both chains.

### 6. Rate limits, CORS, security headers

- **Rate limits:** four `express-rate-limit` instances, all keyed by the single `rateLimitKey` (`middleware/auth-rate-limit.ts`, `mcp-rate-limit.ts`, `a2a-rate-limit.ts` (two limiters), `extension-proxy-rate-limit.ts`), all with `standardHeaders: true, legacyHeaders: false`. No global limiter. Hono has no rate-limit middleware and none is installed. **Move:** one in-process sliding-window limiter like `apps/community/src/limits/attempt-limiter.ts` (bounded key map), emitting the same `RateLimit-*` and `Retry-After` headers and the same JSON-RPC error bodies for `/mcp` and `/a2a`. **Risk: Medium** (header names and window math are visible to clients).
- **CORS:** the `cors` package in delegate form. **Move:** `hono/cors` with an `origin` callback that calls `isTrustedBrowserOrigin` with the request's facts, `credentials: true`; the `DORKOS_CORS_ORIGIN` override and the refusal of a literal `*` carry over. **Risk: Medium** (credentialed CORS; covered by the parity matrix).
- **Security headers:** no helmet. `nosniff` everywhere, `SHELL_CSP` (`app.ts:438-452`) and cache headers on the shell document only. **Move:** a three-line middleware plus headers on the static handler. `hono/secure-headers` is not needed. **Risk: Low.**
- **Compression:** none today; none added.

### 7. Durable SSE streams

**Where:** `routes/session-events-handler.ts` (`GET /api/sessions/:id/events`, resume by `Last-Event-ID` or `?after=`, through `deliverSessionStream()` in `services/core/streams/session-stream-delivery.ts`), `routes/events.ts` (`GET /api/events`, capacity check, register-before-preamble ordering, heartbeat), `routes/room-events-handler.ts` (room stream). The seam is `DurableStreamSink` (`services/core/streams/durable-stream-sink.ts`): `SseStreamSink` writes `id:/event:/data:` and `: keepalive`, waits on `drain` for backpressure, and aborts on `res.on('close')`. The WebSocket twin (`stream-socket.ts`) shares the sequencer. Simpler one-off SSE routes: `routes/extensions.ts`, `routes/tunnel.ts`, `routes/remote-communities.ts`, `routes/runtimes.ts`, `routes/discovery.ts`. `stream-adapter.ts` `initSSEStream` sets `Content-Type`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. The runtime lock port takes `SseResponse` (`packages/shared/src/agent-runtime.ts:209`), which needs only `on('close', cb)`.

**How it moves (two options):**

- **A. Keep the sink, write to the raw Node response.** Hono on `@hono/node-server` exposes `c.env.outgoing` (`HttpBindings`); a handler that writes there itself returns the `RESPONSE_ALREADY_SENT` marker (`x-hono-already-sent`, handled in `@hono/node-server/dist/listener.js`). `SseStreamSink`, its backpressure, heartbeat, close handling and the runtime lock's `SseResponse` all keep working unchanged. Zero change on the wire.
- **B. A web-stream sink.** A new `DurableStreamSink` over a `ReadableStream` (community's `routes/community/events.ts` style, with `pull`-driven backpressure and `c.req.raw.signal` for abort). Needed only when the server must run somewhere that is not Node.

**Recommendation: A now, B only when needed.** The merged server still runs on Node (ADR `260916-210001` chose persistent Node for exactly this reason). DOR-2346 (runtime lock without a Node response) stays a separate, non-blocking item: `SseResponse` is already a one-method interface that `outgoing` satisfies.

**Risk: Medium.** The wire format is pinned by `apps/e2e/tests/streams/sse-contract.spec.ts` (raw bytes against `docs/integrations/sse-protocol.mdx`), and `collectDurableEvents` already uses a real listener and raw `http.request`.

### 8. MCP Streamable HTTP endpoint (`/mcp`)

**Where:** `routes/mcp.ts` (stateless: a fresh `McpServer` plus `StreamableHTTPServerTransport` per POST; `transport.handleRequest(req, res, req.body)`; GET and DELETE are 405; cleanup on `res.on('close')`), mounted in `index.ts` at about line 4241 as `validateMcpOrigin, requireMcpEnabled, createMcpAuth({ surface: 'mcp' }), mcpRateLimiter, createMcpRouter(...)`. `middleware/mcp-auth.ts` is fail-closed: four acceptors in order (`MCP_API_KEY`, per-user key or cookie, legacy `config.mcp.apiKey`, the local MCP token only while login is off); with login off, only discovery methods and read-only `tools/call` pass without a token, judged from the **parsed JSON-RPC body**; a batch passes only if every element passes.

**How it moves:** `@modelcontextprotocol/sdk@1.30.1` already ships `WebStandardStreamableHTTPServerTransport` (`dist/esm/server/webStandardStreamableHttp.js`), which takes a web `Request` and returns a `Response`. The auth middleware reads the body once (`await c.req.json()`), stores the parsed value in a context variable, and the route passes it to the transport as the pre-parsed body, so the stream is never read twice.

**Risk: High** (fail-closed auth on the agent-facing surface). The existing `mcp-auth` tests become a table run against the Hono chain, plus contract cases for every acceptor and every refusal. Ship it as its own PR.

### 9. A2A

**Where:** `packages/a2a-gateway/src/express-handlers.ts` imports `express` and `jsonRpcHandler, UserBuilder` from `@a2a-js/sdk/server/express`; `apps/server/src/routes/a2a.ts` mounts `GET /agents/:id/card`, `POST /agents/:id`, `POST /`; `index.ts` mounts `/a2a` and the well-known cards (`/.well-known/agent-card.json`, `/.well-known/agent.json`) with `createMcpAuth({ surface: 'a2a' })` and the two A2A limiters.

**How it moves:** `@a2a-js/sdk/server` exports `JsonRpcTransportHandler` and `DefaultRequestHandler` without Express (the Express adapter is a thin wrapper around them). Write `fetch-handlers.ts` in `a2a-gateway`: parse JSON, call `JsonRpcTransportHandler.handle`, and return JSON or an SSE stream for streaming methods. Then drop `express` from the package. This also helps the space merge, since community has no Express.

**Risk: Medium.** Covered by the existing a2a-gateway tests plus contract cases for both cards, both endpoints, streaming and the "untargeted message" refusal.

### 10. OpenAPI docs (`/api/docs`, `/api/openapi.json`)

**Where:** registry `services/core/openapi-registry.ts` (`@asteasolutions/zod-to-openapi`, plus per-domain `*-openapi.ts` files and capability projection), mounted at `app.ts:374-376` with `@scalar/express-api-reference`. `scripts/export-openapi.ts` (`pnpm docs:export-api`) writes `docs/api/openapi.json`; `.github/workflows/docs-openapi-check.yml` (`openapi-fresh`, required) fails on drift.

**How it moves:** `@scalar/hono-api-reference` for the UI; `c.json(spec)` for the JSON. The registry does not depend on the framework, so **`docs/api/openapi.json` must not change in any move PR**; that makes `openapi-fresh` a free parity check for the declared surface.

**Risk: Low.**

### 11. Uploads

**Where:** `multer` in `routes/uploads.ts` (built per request from `configManager.get('uploads')`, disk storage to `{cwd}/.dork/.temp/uploads/` through `services/core/upload-handler.ts`, filename sanitizing, `upload.array('files', maxFiles)`), `routes/profile.ts` (avatar, `services/identity/avatar-store.ts`), `routes/rooms.ts` (attachments, `services/rooms/repo/room-file-ops.ts`) and `routes/session-recording.ts`. The client sends `FormData` (`apps/client/src/layers/shared/lib/transport/upload-methods.ts`, `profile-methods.ts`, `session-methods.ts`, `room-methods.ts`).

**How it moves:** keep the multipart wire format (the client does not change). `c.req.parseBody({ all: true })` buffers the whole body in memory, so it must sit behind `bodyLimit` set to `maxFileSize × maxFiles`; for large files, stream with `c.req.raw.formData()` or a streaming multipart parser. Community avoids multipart entirely (raw body plus `x-file-name` headers, `apps/community/src/routes/community/attachments.ts`); that is the better long-term shape, but changing the wire format is a separate, client-visible change and does not belong in a framework move. One shared `parseUploads(c, limits)` helper replaces all four multer call sites and keeps the sanitizer.

**Risk: Medium** (limits, type allowlist, filename sanitizing and the boundary check must carry over; keep the existing upload tests as contract cases).

### 12. Static client serving and the Vite dev server

**Where:** `finalizeApp` (`app.ts:510-575`), production only: `express.static(distPath, { setHeaders })` (`index.html` gets `no-store` plus the CSP; `assets/` gets `immutable, max-age=31536000`), an `/assets` trap that 404s missing hashed bundles instead of serving the shell (DOR-1474), and a pathless GET/HEAD SPA fallback using `res.sendFile('index.html', { root })`. `distPath` comes from `CLIENT_DIST_PATH` (the desktop and CLI set it) or `../../client/dist`.

**Vite dev middleware: there is none.** The client runs its own Vite dev server (`apps/client/vite.config.ts`) and proxies `/api` (and WebSockets) to the server. Nothing to move.

**How it moves:** `serveStatic` from `@hono/node-server/serve-static` with `onFound` setting the headers, an `/assets/*` 404, and **one generic GET/HEAD fallback** to `index.html` (not community's one-route-per-page list, because the local client has many routes, including `/x/<extensionId>/...` pages that are client-side only). Extension pages `/x/*` need nothing on the server beyond this fallback; their backends live under `/api/ext/:id`.

**Risk: Medium** (the production e2e leg and the desktop app both depend on it; the DOR-1474 trap has a test).

### 13. Proxies

- **Workbench preview** (`services/workbench-serve/preview-listener.ts`, `proxy-headers.ts`): one raw `node:http` server per previewed port, with its own `upgrade` handler. **Not Express at all.** Only `routes/workbench-serve.ts` (4 routes: token signing and the `/api/workbench/serve/*` entry) moves. **Risk: Low.**
- **Extension data proxy** (`services/extensions/extension-proxy.ts`): an Express router with `ALL /proxy/*` that forwards with `fetch()`, injects the stored secret, strips caller credentials and checks `staysWithinBase()`. Already fetch-based; ports cleanly. **Risk: Medium** (credential injection; keep its tests).
- **Isolated extension router** (`services/extensions/isolation/isolated-router.ts`): forwards raw HTTP to the extension's child process over a virtual socket, with header allow lists, a 120-second idle cutoff and a 4 MB backpressure cutoff. Express-typed but framework-neutral in logic. **Risk: Medium.**
- No `http-proxy` dependency anywhere.

### 14. Extension server routes (the public contract)

**Where:** `packages/extension-api/src/server-extension-api.ts:620` types the author hook as `(router: import('express').Router, ctx) => …`; `middleware/extension-routes.ts` delegates `/api/ext/:id/*` to `extensionManager.getServerRouter(id)` by calling it as `(req, res, next)`; `services/extensions/extension-server-lifecycle.ts` builds the router; the isolated child (`services/extensions/isolation/child/bootstrap.ts:37,195,249`) bundles its own `express` and injects it for `require('express')`; the CLI build inlines `express` into `dist/server/extension-child.cjs`. The bundled marketplace core extension (`packages/cli/core-extensions/marketplace/server.ts`) and user extensions (for example `~/.dork/extensions/linear-issues/server.ts` on the operator's machine) call `router.get(...)`. `docs/integrations/extensions.mdx` documents it. DOR-2687 already asks for a `{ fetch }` shape.

**How it moves:** a contained compatibility layer. The host keeps creating one small Express router **per extension** and reaches it from a Hono route through the Node escape hatch (`c.env.incoming`/`c.env.outgoing`), the same mechanism as the strangler fallthrough. Add `register({ fetch })` (DOR-2687) as the recommended shape, update the template and docs, and schedule the `router` shape's removal separately. Express then survives only inside the extension host and the child bundle, not in the server's own routing.

**Risk: High** (public API; breaking it silently breaks people's extensions). Decision for the operator: keep the `router` shape working for now (recommended) or break it in this move.

### 15. WebSocket upgrades (terminal and stream sockets)

**Where:** `services/core/streams/upgrade-router.ts` (`attachUpgradeRouter(server, routes, admission)`, one `server.on('upgrade')` for the whole process, ADR `260805-041016`), wired in `index.ts` `onListening` with the three durable stream routes (`routes/stream-sockets.ts`) and `terminalUpgradeRoute` (`services/terminal/terminal-websocket.ts`, `node-pty`). No Express middleware runs on an upgrade today; each route declares its credential posture and the router enforces it with `authorizeStreamUpgrade`.

**How it moves:** unchanged. `serve()` / `createAdaptorServer()` return the Node `http.Server`; attach the same router to it. `@hono/node-ws` is not needed and should not be added (it would add a second `upgrade` listener, the exact thing the ADR forbids).

**Risk: Low.**

### 16. HTTP server lifecycle

**Where:** `services/core/lifecycle/main-listener.ts` (`startMainListener({ admission, listen: () => app.listen(PORT, host) })`); shutdown in `index.ts` (`shutdownServices()`, starting with `mainRequestAdmission.close()`); no `server.close()` and no timeout tuning.

**How it moves:** `listen` becomes `createAdaptorServer({ fetch, hostname })` then `server.listen(PORT, host)`. The admission gate keeps working (it is middleware in both chains and a check in the upgrade router). Adopting community's `shutdown.ts` (graceful `close()` then `closeAllConnections()`) is a good follow-up but not part of the move. **Risk: Low.**

### 17. Desktop app

**Where:** `apps/desktop/src/server-entry.ts` imports `@dorkos/server` for its side effect and polls `/api/health`; `apps/desktop/src/main/server-spawn.ts` forks it (`utilityProcess` packaged, `tsx` in dev) and sets `DORKOS_PORT`, `CLIENT_DIST_PATH`, `DORKOS_CORS_ORIGIN` (dev renderer origin), `DORKOS_MANAGED_BY=desktop` and native binary paths.

**How it moves:** nothing changes. The desktop app never touches Express; it needs the port, `/api/health`, static serving from `CLIENT_DIST_PATH` and CORS for the dev renderer origin, all covered above. **Risk: Low**, but the static-serving PR must be checked in the packaged app (`.claude/rules/desktop.md`).

### 18. The CLI bundle

**Where:** `packages/cli/scripts/build.ts`: the server bundle (`apps/server/src/index.ts` to `dist/server/index.js`) lists `express`, `cors`, `@scalar/express-api-reference` and `@asteasolutions/zod-to-openapi` as externals (about lines 413-448), so `packages/cli/package.json` carries `express` and `cors` as dependencies; the extension child bundle inlines `express` (about lines 469-479).

**How it moves:** `hono` and `@hono/node-server` are pure JavaScript, so they can be bundled rather than made external. The first PR adds them (bundled). The last PR removes `express` and `cors` from the externals and from `packages/cli/package.json`, swaps `@scalar/express-api-reference` for `@scalar/hono-api-reference`, and keeps `express` inlined only in the extension child bundle for as long as the extension compatibility layer exists. **Risk: Low**, verified by `pnpm smoke:docker`.

### 19. Tests and helpers

**Counts:** 1,645 server test files; 224 use supertest; 176 import `express`; 108 build the full app with `createApp()`; 154 hand-build `express()` and mount one or two routers (for example `routes/__tests__/session-locations.test.ts` sets a fake `res.locals.user` in middleware).

**Helpers** (`packages/test-utils/src`):

- `supertest.ts` already **refuses** a bare app and accepts only a listening `http.Server` or a URL. Supertest is therefore just an HTTP client here and **does not need replacing**.
- `listening-server.ts` (`listeningServer(handler: RequestListener)`, `swappableServer().mount(app)`) takes a Node request listener. A Hono app becomes one with `getRequestListener(app.fetch)`. Add `honoListener(app)` to test-utils.
- `sse-test-helpers.ts`: `collectDurableEvents(app: Express, …)` calls `app.listen(0)` itself. Change it to take a `RequestListener` (or a listening server); `collectDurableEventsAt(baseUrl, …)` already works with anything. `openSseStream` and `parseFrames` are raw HTTP and stay.
- `FakeAgentRuntime` and `test-scenarios.ts` do not touch HTTP and stay.
- `apps/e2e` boots the real server (`tsx src/index.ts`) through Playwright `webServer`, so every browser spec covers the composed server at every step.

**How it moves:** each group PR rewrites its own tests' app construction (usually a three-line change from `express()` plus `app.use(prefix, router)` to `new Hono()` plus `app.route(prefix, routes)` wrapped in `honoListener`) and replaces fake `res.locals` middleware with a `c.set` one. Assertions stay. For in-process tests that do not need sockets, `app.request()` is available (community uses both).

**Risk: Low per file, but this is most of the work by line count.**

### 20. Smaller Express couplings

- `packages/test-utils/src/sse-test-helpers.ts` imports Express types (section 19).
- `apps/e2e/tests/workbench/served-document-isolation.spec.ts` uses Express for a throwaway fixture server; it can stay or use `node:http`.
- Raw-body webhooks: `express.raw` on `/api/relay/webhooks/:adapterId` and the signed connector ingress. In Hono, `await c.req.arrayBuffer()` gives the exact bytes. **Risk: Medium** (signature checks must see the bytes exactly as sent).
- Other `Router()` users outside `routes/`: `services/runtimes/connector-mcp/router.ts`, `services/runtimes/connect/doe-setup-router.ts`, `services/relay/adapter-manager.ts`, `services/relay/binding-subsystem.ts`.

## Route groups

Counts are route registrations. "In flight" means an open PR changes these files today (`gh pr list`, 2026-10-09).

| Group                      | Main files                                                                                                                            | Routes | In flight                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -----: | -------------------------------------------------- |
| Small read-only and system | `health`, `models`, `commands`, `subagents`, `system`, `capabilities*`, `errors`, `keep-awake`, `team`, `activity`, `audit`, `search` |    ~25 | none                                               |
| Workspace and project      | `directory`, `git`, `projects`, `workspaces`, `read-cursors`, `session-locations`, `templates`, `shapes`, `harness`                   |    ~30 | none                                               |
| People and approvals       | `notifications`, `push`, `approvals`, `extension-decisions`, `permissions`                                                            |    ~21 | none                                               |
| Files and uploads          | `files`, `diff`, `uploads`, `profile`, `workbench-serve`                                                                              |    ~27 | none                                               |
| Mesh and agents            | `mesh`, `agents`, `discovery`                                                                                                         |    ~24 | none                                               |
| Tasks and runtimes         | `tasks`, `runtimes`, `runtimes-account-eligibility`, `doe-setup-router`                                                               |    ~36 | none                                               |
| Marketplace                | `marketplace.ts`, `marketplace/*`                                                                                                     |     26 | none                                               |
| Connectors                 | six `connector-*` files, signed webhook ingress, `connector-mcp/router.ts`                                                            |    ~59 | none                                               |
| Cloud                      | `cloud`, `cloud-communities`, `tunnel`                                                                                                |    ~40 | #2660 (tests only)                                 |
| Auth                       | Better Auth mount, sign-in limiter                                                                                                    |      — | none                                               |
| MCP                        | `mcp`, `mcp-config`, `mcp-oauth`                                                                                                      |     ~5 | #2626/#2627/#2688 (SDK bump)                       |
| A2A                        | `a2a`, `packages/a2a-gateway`                                                                                                         |      5 | none                                               |
| Extensions                 | `extensions*`, `/api/ext/:id`, data proxy, isolated router                                                                            |    ~30 | none                                               |
| Relay                      | `relay`, `relay-adapters`, `unclaimed-chats`, relay webhooks                                                                          |    ~42 | DOR-2790 retires relay agent tools                 |
| Operations                 | `feedback`, `debug`, `admin`, `test-control`, `mock-mcp-oauth-server`, `canvas-doc-events`, `config`                                  |    ~30 | #2677 (`config.ts`)                                |
| Rooms                      | `rooms` and its helpers, room SSE                                                                                                     |    ~34 | #2666 (rooms services)                             |
| Spaces                     | `remote-communities`, `community-connections`                                                                                         |    ~32 | #2666 (`community-connections.ts`), DOR-2764 batch |
| Streams                    | `events`, session and room SSE handlers                                                                                               |      3 | #2694                                              |
| Sessions and messages      | `sessions.ts` and 11 `session-*` handlers                                                                                             |    ~40 | **#2694 (DOR-2790)**, #2677                        |

## Strategy

### The hypothesis, checked

| Claim                                             | Verdict                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hono can be the front door with Express behind it | **Confirmed**                    | `@hono/node-server` gives a handler the raw `incoming`/`outgoing` (`HttpBindings`) and honors `RESPONSE_ALREADY_SENT`, so one catch-all route can call `expressApp(incoming, outgoing)`.                                                                                                                                                                                                                                                                                                                                           |
| The Express app keeps working unchanged behind it | **Confirmed, with two settings** | The Request wrapper reads the body lazily, so Express still sees an unread stream. Two defaults must change: `overrideGlobalObjects: false` (otherwise the adapter replaces the global `Request` and `Response`, which other code such as Better Auth, the MCP SDK and `fetch` callers use), and the fallthrough must not return until `outgoing` closes (otherwise `autoCleanupIncoming` drains a body Express is still reading). Both are proven in PR 1 with a large POST, an SSE stream and an upload through the fallthrough. |
| Upgrades keep working                             | **Confirmed**                    | The upgrade router attaches to the Node server, not the framework.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Move one route group per PR                       | **Confirmed**                    | Routers are already one factory per file group, mounted by prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Run Hono middleware in front of everything        | **Rejected**                     | Running the Hono chain and then the Express chain on fallthrough requests doubles the audit fallback rows, rate-limit counts and body reads, and splits `res.locals` from `c.var`. Instead the front door does routing only: moved groups get the Hono chain, the fallthrough gets the untouched Express chain, and the two chains share one set of policy functions (`RequestFacts`).                                                                                                                                             |
| Express in front, Hono behind                     | **Rejected**                     | `express.json` consumes the body before a Hono sub-app sees it, and the last step becomes a big front-door flip instead of a deletion.                                                                                                                                                                                                                                                                                                                                                                                             |

### Proving parity

1. **Route census** (PR 2). A committed baseline (`apps/server/src/http/__tests__/route-census.baseline.json`) of every method and path, generated once from the Express router stack. A test asserts that the Hono routes and the remaining Express routes do not overlap, and that together they equal the baseline. A move PR may only move entries between the two sides; adding or removing a route needs a baseline edit that a reviewer will see.
2. **Contract tests per group** (PR 2 adds the harness; each group gets its contract file in the PR **before** its move, or the move PR's first commit, and the move PR must not edit it). The harness (`apps/server/src/http/__tests__/contract/harness.ts`) boots the composed server on a real port and runs a table of cases (method, path, headers, body, expected status, chosen headers, body normalized or checked against the registered Zod response schema). Because it talks to the composed server, the same unchanged file passes before the move (Express answers) and after it (Hono answers). Every case set includes the refusals: no credential, wrong origin, foreign host, empty body, malformed JSON, oversize body.
3. **Chain parity matrix** (PR 4). The full auth/origin/host/credential matrix runs against a probe route mounted once behind each chain; the two must agree on every cell.
4. **`openapi-fresh`.** `docs/api/openapi.json` must not change.
5. **Existing suites.** The e2e browser specs (real server), `sse-contract.spec.ts`, the desktop and CLI smoke tests, and the route tests themselves, whose assertions do not change.

### The first PR

**"Hono front door with the whole Express app behind it."** Add `hono` and `@hono/node-server` to `apps/server` (versions matching `apps/community`); add `apps/server/src/http/front-door.ts` with a Hono app whose only route is the Express fallthrough; switch `startMainListener` to `createAdaptorServer`; attach the upgrade router to that server; add `honoListener` to test-utils; bundle Hono in the CLI build. No route moves. Proof: the whole unit suite, all e2e legs, `pnpm smoke:docker`, a packaged desktop check, and new tests for a 2 MB POST, a multipart upload, an SSE stream with reconnect and a WebSocket through the front door.

## Risks, ranked

1. **Auth gates and `/mcp` fail open** (High). Mitigation: the chain-parity matrix, `/mcp` and auth in their own PRs, existing auth tests run against both chains.
2. **Extension authors break** (High). Mitigation: keep the `router` shape through a contained bridge; add `{ fetch }` (DOR-2687); operator decides when to drop `router`.
3. **The fallthrough mishandles bodies or streams** (Medium). Mitigation: the two settings above, proven in PR 1.
4. **Collisions with in-flight work** (Medium). Mitigation: sessions, streams, rooms, spaces, relay and config move last, each after the PRs that touch them merge; every move PR re-reads `gh pr list` for its files first.
5. **Empty-body and error-shape drift** (Medium). Mitigation: `readJsonBody` and contract cases for empty and malformed bodies.
6. **Effort creep from test churn** (Medium). Mitigation: supertest and the listening-server helpers stay; only app construction changes.

## What the space merge gets from this

After the move, both servers share Hono, `@hono/node-server`, the `onError` and error-class shape, Better Auth's web handler mount, a framework-free A2A gateway and the same test style (`app.request()` plus real listeners). The remaining merge work is storage (SQLite versus Postgres), identity (ADR `261006-235239`) and route namespaces, not the web framework.

## Sources

- `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/src/middleware/*`, `apps/server/src/routes/*` (origin/main `b05cc6065d`).
- `apps/community/src/app.ts`, `http.ts`, `main.ts`, `shutdown.ts`, `limits/attempt-limiter.ts`, `routes/community/events.ts`, `routes/community/attachments.ts`.
- `node_modules/.pnpm/@hono+node-server@1.19.17_hono@4.13.12/node_modules/@hono/node-server/dist/listener.js` (`getRequestListener`, `overrideGlobalObjects`, `autoCleanupIncoming`, `x-hono-already-sent`).
- `node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.1*/…/dist/esm/server/webStandardStreamableHttp.d.ts`.
- `node_modules/.pnpm/@a2a-js+sdk@1.2.0_express@5.2.1/…/package.json` exports and `dist/server/index.d.ts` (`JsonRpcTransportHandler`).
- ADRs `260916-210001`, `261006-235238`, `260805-041016`; tickets DOR-2742, DOR-2687, DOR-2346, DOR-2639.
- `research/20260309_mcp_server_express_embedding.md`, `research/20260309_upload_files_react_express.md`.
