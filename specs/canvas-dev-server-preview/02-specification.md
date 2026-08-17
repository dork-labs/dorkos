---
slug: canvas-dev-server-preview
created: 2026-08-16
status: specified
tracker: DOR-1258
---

# Canvas dev-server preview — specification

Ideation: [`01-ideation.md`](./01-ideation.md). Umbrella: DOR-1258. Two phases, one worktree + one builder + one adversarial reviewer + one PR each. Phase 2 builds on Phase 1's merged `main`.

## 0) Summary

Today a loopback URL in the canvas browser is fetched through a **path-prefixed** proxy (`/api/workbench/proxy/<token>/`) into an **opaque-origin** iframe. Both halves break any app whose assets are root-absolute or module scripts — every Vite/Next/CRA dev server — and the user sees a blank white frame with no message.

- **Phase 1 (P1)** — on a loopback cockpit, frame `http://localhost:<port>/…` **directly** with the external sandbox; the frame is honest about the failures it can detect; an e2e that fails on the old code guards it; docs stop over-claiming.
- **Phase 2 (P2)** — every loopback target gets its **own origin**: DorkOS opens an ephemeral preview listener per target port on the same host it already binds, authorized by the signed token via cookie, proxying every method and WebSocket upgrades, injecting the DevTools shim. The frame gets `allow-same-origin`. The path-prefixed route is retired. New ADR; ADR 260708-185519 amended.

Every user-facing string follows `writing-for-humans` (a smart 9th grader who doesn't code).

---

## 1) Phase 1 — direct framing on a loopback cockpit + honest failure states

### 1.1 Client: `features/canvas/lib/browser-url.ts`

Add a fourth resolution for loopback targets. `classifyBrowserTarget` keeps returning `{ mode: 'proxy', port, path }` (the logical classification is unchanged); the **renderer** decides how to load it:

```ts
/** How a `proxy` target is loaded: straight into the frame, or via the server. */
export type LoopbackStrategy = 'direct' | 'server';

/**
 * A loopback dev server can be framed directly only when the cockpit itself is
 * running on the same machine — i.e. the page's own host is a loopback host. A
 * cockpit viewed from another device (a phone on Tailscale, a tunnel) must go
 * through the server, because "localhost" there is the viewer's device.
 */
export function loopbackStrategy(pageHostname: string): LoopbackStrategy;
```

`isLoopbackHost` (already in the file) is the predicate; `pageHostname` is injected (`window.location.hostname` at the call site) so the function is pure and testable. `direct` builds the frame `src` as the logical URL itself (`http://localhost:5178/dorkos/flagship-promo/vo`); sandbox = `WORKBENCH_SANDBOX_EXTERNAL`.

**Why external sandbox is acceptable here (state it in the TSDoc):** the framed page's origin is `http://localhost:<port>` — cross-origin to the cockpit (`localhost:4242`), not in `resolveTrustedOrigins()`, so it cannot read `/api/*`; it is exactly as privileged as the same dev server open in a tab on the same machine. The `serve` path (local files on the DorkOS origin) keeps `WORKBENCH_SANDBOX_ISOLATED` — do not touch it.

### 1.2 Client: `CanvasBrowserContent.tsx` resolve/effect

- `proxy` + `direct` → **pre-flight** the port before framing so a dead port never becomes a blank frame: `await transport.probeLoopbackPort(port)` (new Transport method, below) → `{ listening: boolean }`. If not listening → `resolveError = 'no-upstream'` → message **"Nothing is listening on localhost:5178. Start the dev server, then reload."** with a Reload button (reuses `reloadNonce`). If listening → `resolvedSrc = logical url`, sandbox external.
- `proxy` + `server` → unchanged in P1 (still `createProxyUrl` — P2 replaces it). But the "Loading…" state gets a deadline: if the frame has not fired `load` within `WORKBENCH_FRAME_LOAD_TIMEOUT_MS` (10 s), show **"This preview is taking a long time to load."** with Reload + Open in system browser (frame stays mounted underneath — do not unmount a slow-but-alive page).
- Both: **load-error banner** driven by the DevTools bridge (below): when the bridge reports ≥1 `resource-error` for the frame's current document, render a slim banner above the frame: **"This page hit N error(s) while loading."** → "Open in system browser". Not for direct frames (no shim there — say so in a comment, not to the user).
- `BrowserBody`'s message set becomes: `blocked` · `no-session` · `unsupported` · `failed` · `no-upstream` · `slow` (+ the shim banner). Every message is a full sentence with a next step; none is a bare "couldn't be loaded".

### 1.3 Transport: `probeLoopbackPort(port)`

`packages/shared/src/transport.ts` gains `probeLoopbackPort(port: number): Promise<{ listening: boolean } | null>` (`null` = unsupported, DirectTransport). HTTP: `POST /api/workbench/probe` `{ port }` (schema `WorkbenchProbeRequest/Response` in `packages/shared/src/schemas.ts`, `.openapi(...)`; regenerate `docs/api/openapi.json` — recipe in §4). Server: `routes/workbench-serve.ts` — auth-gated like `/sign`; opens a TCP connect to `127.0.0.1:<port>` with a 1 s timeout; `{ listening: true|false }`; never proxies a body. Loopback-pinned like the proxy (no host param). Mock in `packages/test-utils/src/mock-factories.ts`.

### 1.4 DevTools shim: resource errors

`services/workbench-serve/devtools-shim.ts` — add a capture-phase `error` listener on `window` that reports failed `<script>`/`<link>`/`<img>` loads (`event.target.src|href`) as a new capture kind `resource-error` (alongside the existing console/network kinds — follow the existing message shape and the existing DOR-213 tests). `use-devtools-bridge.ts` relays it like the others AND exposes a per-document count to the canvas via the existing bridge return value (add `resourceErrorCount` reset on navigation/reload). Keep the shim's "talks only to `window.parent`" invariant.

### 1.5 e2e (`apps/e2e`, `browser-testing` skill)

New spec `apps/e2e/tests/workbench/dev-server-preview.spec.ts`:

1. **Vite-style app renders.** The test boots a tiny static server on an ephemeral port serving `index.html` with `<script type="module" src="/main.js">` (root-absolute) and `/main.js` that writes `data-testid="app-ready"` into `#root`, plus a deep path `/some/route` that serves the same HTML (SPA fallback). Open the canvas browser at `http://localhost:<port>/some/route`; assert the frame contains `app-ready`. Run once against pre-P1 code to prove it fails (record the failure in the PR body).
2. **Dead port is honest.** Open `http://localhost:<unused port>/`; assert the "Nothing is listening on localhost:<port>" message and that no iframe is mounted.
3. (Unit, not e2e) `loopbackStrategy` table test; `BrowserBody` message states in `CanvasBrowserContent.test.tsx`; server probe route tests (listening / not / bad port).

The e2e cockpit runs on `localhost`, so P1's direct strategy is what test 1 exercises. In P2 the same test exercises the listener (see §2.6) — keep the assertions strategy-agnostic.

### 1.6 Docs + changelog

`docs/guides/workbench.mdx` §"Embedded Browser": replace "localhost dev servers render right in the canvas" with the P1 truth — dev servers render when you're using DorkOS on the machine that runs them; from another device or through a tunnel you get an "Open in system browser" button for now. Add a fragment in `changelog/unreleased/` (`writing-changelogs`): "Dev servers you run on your machine now show up in the canvas — and when one isn't running, the canvas says so instead of going blank."

### 1.7 Out of P1

No server proxy changes beyond the probe route, and no **new** ADR — but ADR 260708-185519 does need amending, because it covers the `proxy` classification explicitly ("Both render … WITHOUT `allow-same-origin`") and P1 gives a directly framed loopback dev server `allow-same-origin`. P1 records that as a dated note in that ADR's **Status** section: the posture changes only for a frame on its OWN origin, while everything DorkOS serves (the `serve` path and the server-side proxy path) keeps the opaque origin, which is where the ADR's threat model lives. The new ADR — one dedicated origin per proxied target — belongs to P2 (§2.5).

---

## 2) Phase 2 — a real origin per preview target

### 2.1 Server: `services/workbench-serve/preview-listener.ts` (new)

```ts
export interface PreviewOrigin {
  targetPort: number;
  listenPort: number;
}
export class PreviewListenerManager {
  constructor(opts: { host: string; signer: WorkbenchTokenSigner; idleTtlMs: number; logger });
  /** Reuse a live listener for `targetPort`, or open one on an ephemeral port bound to `host`. */
  acquire(targetPort: number): Promise<PreviewOrigin>;
  /** For tests + shutdown. */
  close(targetPort?: number): Promise<void>;
}
```

- **Bind host** = the same `env.DORKOS_HOST` the main server binds (so a LAN/Tailscale cockpit reaches it). Port `0` → OS picks; remember it per target.
- **Auth** = the signed proxy token, delivered once in the bootstrap URL and then held in a cookie:
  - Bootstrap: `GET|HEAD /<path>?__dorkos_preview=<token>` → verify token, require `scope.kind === 'proxy' && scope.port === targetPort` → `Set-Cookie: dorkos_preview_<listenPort>=<token>; Path=/; HttpOnly; SameSite=Lax` (+`Secure` when the request is https) → `302` to the same URL with the param removed. The cookie name carries the **listen** port because cookies on one host are shared across ports (two simultaneous previews must not clobber each other).
  - Every other request: read `dorkos_preview_<listenPort>` from `Cookie`; verify (expiry included) or `401` with a small HTML page: "This preview link has expired. Reload the canvas to open a fresh one." A missing/invalid cookie never proxies.
  - Never forward DorkOS's own cookies upstream: strip `dorkos_preview_*` and the Better Auth session cookie from the outgoing `Cookie` header; forward the rest (dev apps use their own cookies).
- **Proxy** all methods, streaming request and response bodies (`http.request` to `127.0.0.1:<targetPort>`, `Host: localhost:<targetPort>` so Vite's `server.allowedHosts` accepts it), `redirect` passthrough (do not follow), strip `x-frame-options` and CSP `frame-ancestors` (reuse `stripFrameAncestors`), hop-by-hop headers, and inject the DevTools shim into `text/html` UTF-8 responses (reuse `injectDevtoolsScript`, same charset rule as today). Add `Referrer-Policy: no-referrer` only on the bootstrap redirect (the token is in that URL).
- **WebSocket**: handle `server.on('upgrade')` — same cookie check — then pipe the socket to `127.0.0.1:<targetPort>` (raw `net` piping of the upgrade request + bidirectional stream; no `ws` needed). Vite HMR must connect (test).
- **Errors**: `ECONNREFUSED` → 502 HTML "Nothing is listening on localhost:<targetPort>."; timeout → 504. Small HTML, no stack, no token echo.
- **Lifetime**: idle reaper closes a listener after `WORKBENCH.PREVIEW_IDLE_TTL_MS` (30 min, `config/constants.ts`) with no requests; `acquire` reopens transparently. `close()` on server shutdown (wire in `index.ts` next to other teardown).
- Logging via `logger` with the `[workbench-preview]` prefix; never log the token.

### 2.2 Server: sign route

`POST /api/workbench/sign` `{ kind: 'proxy', port }` →

- If the request's `Host` is the tunnel host (`getTunnelHostname()`) → `200 { url: null, unavailable: 'tunnel' }` — the listener port isn't reachable through a tunnel; say so.
- Else `acquire(port)` → `{ url: 'http://<request hostname>:<listenPort>/?__dorkos_preview=<token>' }`. Hostname = the incoming request's host **name** (so `machine.tail.ts.net` stays `machine.tail.ts.net`); scheme = `req.protocol`.

`WorkbenchSignResponseSchema` becomes `{ url: string | null, unavailable?: 'tunnel' }` (openapi regen). Client `createProxyUrl(port)` returns `{ url, unavailable? } | null`… keep the Transport method name, change its return type in `packages/shared/src/transport.ts` (+ DirectTransport `null`, + mock factory).

### 2.3 Server: retire the path-prefixed proxy

Delete `services/workbench-serve/proxy.ts`'s `proxyToLocalhost` and the `ALL /api/workbench/proxy/:token/*splat` route; move `stripFrameAncestors`/`isUtf8OrUnspecified` into the listener module (or a small `proxy-headers.ts`) and keep their tests. Remove the `/api/workbench/proxy/` exemption in `services/core/auth/session-gate.ts` (leave `serve`). Update TSDoc in `routes/workbench-serve.ts`, `token.ts` (the proxy token now authorizes the listener), `WorkbenchSignRequestSchema` docs, `contributing/` if any guide names the route (grep `workbench/proxy`).

### 2.4 Client

- `CanvasBrowserContent.tsx`: `proxy` targets → `createProxyUrl(port)`; on `{ url }` → frame src = `url` with the logical path spliced in **before** the query (`http://host:P/dorkos/flagship-promo/vo?__dorkos_preview=…`); sandbox `WORKBENCH_SANDBOX_EXTERNAL` (own origin — TSDoc explains why, cf. ADR). On `{ url: null, unavailable: 'tunnel' }` → message **"Dev-server previews aren't available through a tunnel. Open DorkOS on the machine that runs it, or open the app in your browser."** + Open in system browser. Keep P1's `probeLoopbackPort` pre-flight (it's cheaper than a listener + 502).
- **P1's direct strategy becomes the fallback**, used only when `createProxyUrl` returns `null` (unsupported transport) — the listener is primary even on a loopback cockpit so the agent's console relay works everywhere. `loopbackStrategy` shrinks accordingly (or is removed if nothing else needs it — remove dead code).
- `use-devtools-bridge.ts`: identity is `ev.source === frame.contentWindow` — unchanged and correct for a real origin too; update the TSDoc that says the origin is always `"null"`.
- Reload / navigation re-mints (tokens expire; the cookie is refreshed by the new bootstrap).

### 2.5 ADR

New ADR (id from `.claude/scripts/id.ts`): **"Dev-server previews get their own origin (per-target preview listener); local-file serve keeps the opaque origin."** Context: §3 of ideation. Decision: 2.1–2.4. Consequences: works from any device that reaches the DorkOS host; not through a tunnel (honest message); the listener is a second bound port per active preview (idle-reaped); a preview origin is same-_site_ with the cockpit on the same host, so its cookies interleave with the cockpit's — mitigated by per-listen-port cookie names, HttpOnly, and never forwarding DorkOS cookies upstream; framed dev servers can no longer be read as opaque-origin (they never worked as such). Amend `decisions/260708-185519-…md`: add a Status note "Amended by <new id>: the proxy half now serves from a dedicated origin with `allow-same-origin`; the serve half is unchanged." Update `decisions/manifest.json` via `/adr:create` conventions.

### 2.6 Tests

- Unit: `preview-listener.test.ts` — bootstrap sets cookie + 302 strips param; missing/expired cookie 401 (no proxying); wrong-target token rejected; all methods forwarded with bodies; XFO/frame-ancestors stripped; HTML shim injected, non-HTML untouched; WS upgrade round-trips a frame; ECONNREFUSED → 502 HTML; idle reaper closes; `acquire` reuses. Sign route: tunnel host → `unavailable`; hostname preserved.
- Client: `CanvasBrowserContent.test.tsx` — path splice, tunnel message, fallback to direct on `null`.
- e2e (§1.5 file): same two tests now go through the listener (assert the frame's URL host:port ≠ cockpit port and the app renders); add "deep path survives bootstrap redirect" (open `/some/route`, assert frame `location.pathname === '/some/route'`).

### 2.7 Docs + changelog

`docs/guides/workbench.mdx`: dev servers render in the canvas from any device you use DorkOS on (phone, tablet, laptop) — the exception is a tunnel, where you'll be offered Open in system browser. Keep the DevTools paragraph true (instrumented previews = local files + dev servers). Changelog fragment: "See your dev server in the canvas from your phone or another laptop, not just the machine it runs on. Live reload works too."

---

## 3) Non-goals / what is deliberately not done

- No URL rewriting inside the proxy (01 §5 A).
- No tunnel support for previews (honest message instead). If a tunnel story is wanted later, it needs a per-preview public hostname — a separate spec.
- No change to the `serve` (local file) path's sandbox.
- No Docker/remote dev servers.

## 4) Conventions for both phases

- Worktree per phase from `origin/main` (`working-in-worktrees`); builder + separate adversarial reviewer per `REVIEW.md` **before** the PR opens; PR body `Closes DOR-<n>`; changelog fragment; `pnpm verify`; OpenAPI regen when `packages/shared/src/schemas.ts` changes: `pnpm turbo build --filter="./packages/*"` → `pnpm docs:export-api` → `pnpm --filter=@dorkos/site generate:api-docs` → `git add -A docs/api` → re-run to confirm zero diff.
- Real-browser proof at the end of each phase: the video app (`http://localhost:5178/`) or the e2e fixture renders in the canvas of a running cockpit; screenshot in the PR.
