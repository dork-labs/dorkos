---
id: 260817-152705
title: Dev-server previews get their own origin; local-file serving keeps the opaque one
status: accepted
created: 2026-08-17
spec: canvas-dev-server-preview
superseded-by: null
---

# 260817-152705. Dev-server previews get their own origin; local-file serving keeps the opaque one

## Status

Accepted. Amends `260708-185519` for the proxy half only; the `serve` half is unchanged.

## Context

The embedded browser previewed a localhost dev server by fetching it through a
path-prefixed route on the cockpit's own origin
(`/api/workbench/proxy/<token>/`) into an opaque-origin iframe. Reproduced in a
real browser on 2026-08-16 (spec `canvas-dev-server-preview` §3), that fails
twice over for every real app:

- **The path prefix loses root-absolute URLs.** A page whose HTML asks for
  `/main.js` asks the COCKPIT for `/main.js`, and DorkOS's SPA fallback answers
  200 with its own shell. Every Vite, Next and CRA dev server is shaped that
  way, a client-side router reads the token path as its route, and a live-reload
  socket connects to the wrong place. URL rewriting inside the proxy cannot fix
  it: runtime-built URLs, HMR paths and workers all escape.
- **The opaque origin blocks ES-module loads on its own.** Module scripts are
  CORS-fetched, and from origin `null` a dev server sends no
  `Access-Control-Allow-Origin`.

The result the user saw was a blank white frame with nothing said about it.

Phase 1 (DOR-1259) framed a loopback dev server by its own address when the
cockpit is on the same machine. That works, but only there: on a phone over
Tailscale, `localhost` is the phone. And nothing injects the DevTools shim into
a frame DorkOS does not serve, so the agent loses console, network and
screenshots for those previews.

## Decision

**Every previewed dev server gets its own origin: an HTTP listener DorkOS opens
per target port, bound to the same interface the main server binds.** The
frame's origin root IS the app's root, so root-absolute assets, routers and HMR
need nothing special (`services/workbench-serve/preview-listener.ts`).

- **Authorization is a cookie, and it is the whole boundary.** The signed proxy
  token arrives once as `?__dorkos_preview=<token>`; the listener verifies it
  (signature, expiry, and that its scope names exactly this target port), sets
  `dorkos_preview_<listenPort>` — `HttpOnly`, `SameSite=Lax`, named for the
  LISTEN port because cookies are shared across ports of one host — and
  redirects to the same path without the parameter under `Referrer-Policy:
no-referrer`. No valid cookie, no proxying: not one byte reaches the dev
  server first.
- **One route answers without a cookie:** `GET /__dorkos_preview/health` → 204,
  no body, never proxied. The client needs it to ask _its own browser_ whether
  the preview origin is reachable before framing it.
- **The listener is an honest proxy:** every method, request and response bodies
  streamed, WebSocket upgrades piped raw so live reload works, `Host:
localhost:<target>` (Vite's `allowedHosts` reads it), `X-Frame-Options` and
  CSP `frame-ancestors` stripped, hop-by-hop headers dropped, the DevTools shim
  injected into UTF-8 HTML, and a redirect to the dev server's own address
  rewritten back into a path so the frame stays on the preview origin. DorkOS's
  own cookies (the preview cookies and the Better Auth session) are never
  forwarded upstream.
- **The listener is ephemeral:** reused per target, closed after 30 minutes
  idle, closed on shutdown. `DORKOS_PREVIEW_PORT_RANGE` pins the choice to a
  range so a Docker or `ssh -L` operator can forward it.
- **The client decides with a cascade, and the browser gets the last word:** ask
  the server whether anything is on the port, take a preview origin, then probe
  that origin from the page itself, and only frame what the browser proved it
  can reach. Failing that, fall back to the dev server's own address when this
  page is on the same machine; failing that, say which of the two things went
  wrong. The frame gets `allow-same-origin` in both cases.
- **The path-prefixed proxy route is retired**, along with `proxyToLocalhost`
  and its session-gate exemption.

The `serve` path — local HTML files on the DorkOS origin — is untouched and
keeps its opaque-origin sandbox. That is where `260708-185519`'s threat model
actually lives.

## Consequences

### Positive

- Dev-server previews work from any device that can reach the DorkOS host — a
  phone, a tablet, a second laptop — because the machine doing the reaching is
  the machine running the dev server.
- Root-absolute assets, client-side routers and HMR work because nothing is
  being rewritten; the addresses are simply correct.
- The DevTools shim is injected into every preview again, so the agent keeps its
  console, network and screenshot view of the page.
- A preview frame's `allow-same-origin` grants it nothing new: its origin is a
  different port from the cockpit, absent from `resolveTrustedOrigins()`, so it
  cannot read `/api/*`. It is as privileged as the same dev server open in a
  browser tab.

### Negative

- **The listener is as network-reachable as DorkOS is.** Bound to
  `DORKOS_HOST`, it sits in front of a `127.0.0.1` service that expects only
  local callers, and the cookie is the only thing between the two. Mitigated by
  refusing to proxy anything without a valid, target-scoped, expiring token; by
  `HttpOnly` per-listen-port cookie names; by a health endpoint that answers
  nothing but 204; and by never forwarding DorkOS's own cookies upstream. Under
  the single-operator trust model this is the same residual local-service reach
  the retired proxy already had, moved to a port of its own and made explicit.
- **A minted preview cookie outlives a DorkOS sign-out.** The token is a
  self-contained HMAC with its own 30-minute expiry and no link to a Better Auth
  session, so signing out (or revoking a session) does not invalidate a preview
  already open. Accepted: obtaining one requires an authenticated call to
  `/sign` in the first place, it expires on its own within half an hour, and what
  it reaches is a loopback dev server on the operator's own machine — not DorkOS
  data, and nothing the operator could not already reach from that machine.
  Linking the two would mean a session check on every asset request, which is a
  database round-trip per image. Revisit if multi-user exposure is ever
  supported, where "signed out" has to mean something stronger.
- A preview origin is same-_site_ with the cockpit on the same host, so their
  cookies interleave in the browser's jar. The per-listen-port name keeps two
  previews from clobbering each other, and the outbound filter keeps the dev
  server from ever seeing either.
- Each active preview holds a bound port. Idle-reaped after 30 minutes, and
  `DORKOS_PREVIEW_PORT_RANGE` bounds how many can exist at once.
- Not through a tunnel: a tunnel publishes one port and it is not this one. The
  sign route answers `{ url: null, unavailable: 'tunnel' }` and the canvas says
  so.
- The listener speaks plain HTTP. A cockpit behind someone's own TLS proxy would
  be asking a browser to frame HTTP inside HTTPS; the browser blocks it, the
  client's reachability probe sees that, and the user gets the
  "doesn't reach port" message rather than a blank frame. Only DorkOS's OWN ngrok
  tunnel is recognized by name (`getTunnelHost()`) and gets the tunnel message; a
  Tailscale `serve`, a Cloudflare tunnel or any other proxy in front of DorkOS
  lands in the unreachable-port message instead. Both are honest and both offer
  the way out, but they are two sentences for one situation — which is why the
  guide describes the behaviour rather than the mechanism.
- Preview responses are requested with `Accept-Encoding: identity`, so a large
  asset crosses the LAN uncompressed. Bought deliberately: it makes HTML
  instrumentation a decode rather than a decompress-recompress.
