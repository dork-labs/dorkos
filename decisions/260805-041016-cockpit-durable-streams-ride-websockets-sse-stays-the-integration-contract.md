---
id: 260805-041016
title: The cockpit's durable streams ride WebSockets; SSE stays as the integration contract
status: accepted
created: 2026-08-05
amends: [0264, 0265, 0189, 0190, 0204, 0207]
spec: null
superseded-by: null
---

# 260805-041016. The cockpit's durable streams ride WebSockets; SSE stays as the integration contract

## Status

Accepted. Extends the durable-stream family (ADR-0264, ADR-0266) — the snapshot → gap-free replay → live contract is unchanged; only the cockpit's transport for it changes. Consolidates the WebSocket upgrade path introduced for the terminal (ADR 260708-185521).

## Context

Three DorkOS windows made the whole app stop responding, and the symptoms each read like a separate bug: sidebar activity dots froze, turns looked stuck, reloads never committed, and a fourth window would not open at all.

They were one bug. Every window parks long-lived streams — `GET /api/events` plus `GET /api/sessions/:id/events`, and a room stream and/or a picture-in-picture stream on top. Over HTTP/1.1 a browser allows about **six sockets per origin, per browser profile**, and a Server-Sent Events stream holds one for as long as it is open. Two streams a window means the third window takes the last socket, and every request after it queues behind streams that never end — including the next window's own HTML.

Measured with Playwright against a live instance, one persistent browser context (what real windows share):

| Windows | Parked streams | `GET /api/health` from window 1          |
| ------- | -------------- | ---------------------------------------- |
| 1       | 2              | 3 ms                                     |
| 2       | 4              | 5 ms                                     |
| 3       | 6              | never returns (cut at 8 s)               |
| 4       | 6              | window 4's own HTML document never loads |

An A-B-A control, changing only the window count: 2 windows 5 ms → 3 windows starved → close the third 4 ms → reopen starved → close 5 ms.

A gate measurement on a throwaway origin serving both a plain GET and a WebSocket endpoint isolates the mechanism from anything DorkOS-specific:

```
 5 SSE streams parked  -> GET /health 1ms
 6 SSE streams parked  -> GET /health STARVED (>6005ms)
12 WebSockets parked   -> GET /health 1ms
```

WebSockets do not draw on the per-origin HTTP socket pool at all (Chromium allows ~255 per host), so moving the streams onto them removes the ceiling rather than raising it.

## Decision

**The cockpit's three durable streams ride WebSockets. The same three paths keep serving Server-Sent Events, which remains the public integration contract.**

Both protocols are first-class; neither is a fallback, and the client never chooses between them at runtime — the cockpit speaks WebSocket only.

- **Same paths, same contract.** `GET /api/events`, `GET /api/sessions/:id/events` and `GET /api/rooms/:id/events` each answer a WebSocket upgrade and an ordinary SSE request. Snapshot → gap-free replay → live is unchanged, and so is the `<resourceId>-<epoch>-<seq>` cursor.
- **One implementation of the sequencing.** The snapshot/replay/live logic sits behind a `DurableStreamSink` seam (`services/core/streams/`), with an SSE sink writing `event:`/`data:`/`id:` lines to an Express response and a socket sink writing JSON frames. A bug fixed in the sequencing is fixed for both by construction.
- **The cursor moves into the URL.** A browser `WebSocket` constructor takes a URL and nothing else, so the resume cursor rides `?resume=` instead of `Last-Event-ID`. It is still the whole frame id, so the epoch check that rejects a cursor minted by a previous server process survives intact — a bare seq would have silently lost it.
- **Liveness is a frame.** A protocol-level pong is invisible to page JavaScript, so it cannot serve as proof of life. The server sends a reserved `__heartbeat` frame, which resets the client's silence watchdog and is dropped before dispatch.
- **Refusals arrive as close codes.** A browser cannot read the HTTP status of a _failed_ WebSocket handshake — `close` reports a generic `1006`. Durable streams therefore complete the handshake and immediately close with `4000 + status`. This is load-bearing rather than cosmetic: the room stream retries a transient failure forever but must stop on 401/403/404, and that distinction is only a status.
- **One upgrade router, and it re-applies the middleware that does not run.** `server.on('upgrade')` is a plain EventEmitter and the terminal's listener destroyed every upgrade it did not recognize, so a second listener beside it could never have worked. All upgrades now go through `services/core/streams/upgrade-router.ts`.

## Security

An upgrade never enters Express, so **no middleware runs for it** — not the CORS policy, not the host guard, and critically not `sessionGate`. Moving the streams onto sockets without saying so explicitly would have silently un-gated all three on an install with login enabled: same URL, same data, no credential. Two things are therefore re-applied by hand:

- **The origin policy**, in the router, for _every_ upgrade. WebSocket handshakes are not CORS-protected: any page can open a socket to any host its user can reach, and the browser attaches that host's cookies. `Origin` is the only thing separating a cockpit tab from a page that DNS-rebound onto the port. This also _widens_ the guard — it used to live inside the terminal's own decision and now covers the terminal and the streams alike, from one place.
- **The credential gate**, through the same `verifyRequestAuth` the HTTP gate and the MCP middleware use, plus the same additive `X-DorkOS-Agent` resolution. One credential path, not two, because a second implementation is how the socket gate and the request gate drift apart unnoticed. It runs in the **router**, keyed off `UpgradeRoute.credential`, rather than inside each route: when the three routes called it themselves, deleting all three calls left the entire server suite green — the gate was tested, its wiring was not, and the wiring is the part an exploit uses.

Both are pinned by tests confirmed to go red when the guard is removed.

### The origin policy is not an allowlist, and that took two tries

The first version was `resolveTrustedOrigins().includes(origin)` — loopback plus the live tunnel. It broke every non-loopback deployment, in the worst possible shape: HTTP kept working, the SPA rendered, the turn ran, the reply landed in the transcript on disk, and the browser never showed it.

The trap is that **a browser sends `Origin` on every WebSocket handshake, including a same-origin one**, whereas the same-origin `fetch` that carried the SSE streams sent none. So the check was inert for the durable streams before they became sockets, and decisive after. Nothing about the check changed; what changed was that it started being consulted.

It now mirrors what the HTTP surface already does, which is CORS **and** `hostGuard` **together**: a statically trusted origin, an origin the operator configured (`DORKOS_CORS_ORIGIN`, `DORKOS_PUBLIC_URL`), or **same-origin with this request's own `Host`** — the branch that covers reverse proxies, LAN addresses and `https://` without enumerating them.

That last branch is an **exact `<scheme>://<host>` string comparison**, matching `buildCors`'s `` `${req.protocol}://${host}` ``, with the scheme pinned by `X-Forwarded-Proto` when a proxy sets it. A first attempt compared only the hostname, and that was a hole rather than a shortcut: on a default zero-config install any other process serving a page on this machine (`localhost:9999` — a project's dev server, a docs preview, a notebook) has the same hostname and a different port, and would have been handed the global stream, which carries every session's id and `cwd`, and from there the transcripts. Login does not close it, because cookies ignore port. Tightening cost nothing — every intended deployment sends an `Origin` that matches its `Host` exactly — and four tests now pin it.

The branch is additionally paired with the host allowlist, because a DNS-rebound page is same-origin to the browser too and would match exactly; `isHostAllowed` is what rejects it, as `hostGuard` does for requests.

**That pairing does not stand down for `DORKOS_ALLOW_INSECURE_BIND`, and this is the sharpest edge in the whole change.** `hostGuard` does stand down for it, so mirroring HTTP looked right — but both `Dockerfile` targets set that flag, so honouring it left the origin unchecked precisely where the shipped image runs. On the terminal, which is `bearer-of-id` and never reaches the credential gate, that was a shell on the host for any page that rebound DNS to the published address: `hostGuard` inert under the same flag, `sessionGate` a pass-through with login off, and same-origin to the browser so CORS never fires. It was also **wider than the hard allowlist the terminal enforced before these streams existed** — a regression dressed as a consolidation.

So the pairing stands down for exactly one case: a credential-gated route with login on, where an origin-scoped cookie means a rebound origin cannot present a credential. Not for the container flag, and not for `bearer-of-id` routes under login either, since those skip the credential check the exemption reasons about.

**What the container flag buys instead is narrower and safe: an IP-literal `Host` satisfies the pairing.** Removing it outright was the obvious fix and it put a different hole back — a homelab or VPS running the shipped image at `http://192.168.1.50:4242` got a cockpit that rendered, ran turns, filled transcripts, and never showed a reply, because `hostGuard` stands down for the flag while the socket path did not. A DNS-rebinding attack works by pointing a NAME at this machine, so the `Host` it produces is always that name; it can never be an IP literal, because typing an IP involves no DNS at all. If `Origin` and `Host` are the same IP literal and the connection arrived here, the page was served by this server — the port is part of the comparison, so another service on the same address does not match. A NAME-based address still needs `DORKOS_TRUSTED_HOSTS`, which `docs/self-hosting/docker.mdx` now tells operators to set and names the quiet failure it prevents.

**`DORKOS_PUBLIC_URL` is not a trust branch.** It was, briefly, and it was the fourth hole this function had: documented as the address to advertise on agent cards, unvalidated, outranking the operator's own `DORKOS_CORS_ORIGIN` list, and never paired with `Host`. `DORKOS_PUBLIC_URL=dorkos:4242` — a plausible typo the reverse-proxy docs sit next to — parses with `dorkos:` as the _scheme_ and serializes to origin `"null"`, which is exactly what a browser sends from a sandboxed iframe or a `file://` page. Any such page that could reach the port was handed the terminal, with no rebinding needed. The branch is gone; `Origin: null` is refused explicitly wherever it could still reach a comparison; and `DORKOS_PUBLIC_URL` now gets the same scheme validation `DORKOS_DOCS_BASE_URL` has, so the typo fails at boot instead of shipping to a peer.

Every one of the four holes had the same shape: **an unpaired early `return true`.** That is the thing to look for in this function, and the reason the paired branch is the only one that grew.

**`DORKOS_CORS_ORIGIN='*'` is not honoured on a socket** — the one place this is deliberately stricter than CORS. The wildcard is tolerable on HTTP only because a wildcard `Access-Control-Allow-Origin` is invalid for credentialed requests, so browsers reject it whatever the server says. A handshake has no such backstop: cookies attach automatically. Honouring it would have meant that with login on plus `*`, the HTTP API stayed closed to a cross-origin page while every stream and the terminal were open to it. An explicit list is exhaustive, as it is in `buildCors`.

> **Correction, 2026-09-02.** The clause above about HTTP no longer describes the code. `buildCors` now ignores `DORKOS_CORS_ORIGIN='*'` too, and warns: the "browsers reject a credentialed wildcard" argument only ever covered the credentialed case, and login is off by default, so on a default install the wildcard let any page the operator visited read and write the whole API. The socket rule this ADR set is unchanged and was right; HTTP was brought up to it, and both surfaces now trim the value before the wildcard check so a padded `" * "` cannot mean different things on each.

**When no proxy sets `X-Forwarded-Proto`, both schemes are accepted for the same `Host`.** Exact when `Host` carries a port, since nothing else can hold it; a small widening when it does not — the reverse-proxy case — because `http://example.com` and `https://example.com` are different servers, so a script an attacker controls on the plaintext vhost of that name would match. The nginx and Caddy configs this repo ships both set the header, which closes it; the residual is a custom proxy forwarding neither the scheme nor a trusted host. Forging the header cannot widen anything, since supplying it replaces the two-scheme OR with a single equality.

And because a browser cannot read a failed handshake, a refused origin is delivered as a close frame carrying `403` and logged server-side, so the cockpit reports "the server refused this stream" instead of retrying five times into a silent `disconnected`.

The terminal keeps refusing at the handshake with an HTTP status, since nothing there needs to tell refusal reasons apart. Its bearer-of-unguessable-id model (ADR 260708-185521) is unchanged.

## Consequences

### Positive

- The ceiling is gone rather than moved. Six windows holding twelve live streams answer `GET /api/health` in 2 ms, verified in a browser with the sockets counted so the result cannot be vacuous.
- Several bugs that looked unrelated — frozen activity dots, stuck-looking turns, reloads that never commit — were this one, and go with it.
- Third-party integrations built against `docs/integrations/sse-protocol.mdx` keep working untouched, as does the Electron main process, which reads `/api/events` for its tray count.
- The origin guard now covers every upgrade instead of only the terminal's.
- A session-stream leak went with it: nothing called `detachSession`, so a tab that navigated from chat to another page held its stream open for the life of the tab.

### Negative

- Two wire formats to keep in step. The `DurableStreamSink` seam is what bounds the cost — the sequencing is written once — but the two sinks and the two framings are real surface, and a third stream family has to implement both.
- The refusal path is asymmetric: durable streams refuse over a close frame, the terminal at the handshake. That is a deliberate split (only the streams have a client that must tell the reasons apart), but it is one more thing to know.
- A rejected caller briefly completes a handshake before being closed, where SSE refused before writing a byte. Nothing is sent on it, and the alternative is a browser that cannot tell "signed out" from "server down".
- **Proxies now need to forward upgrades.** Vite's dev proxy needs `ws: true`; nginx needs `Upgrade`/`Connection` headers, and the config this repo documented actively set `Connection ''`, which is the standard SSE recipe and precisely what blocks an upgrade. Both were found only by driving a real browser — the cockpit rendered, the turn ran server-side, and the reply never arrived on screen. `docs/self-hosting/reverse-proxy.mdx` now carries the working config and names this failure shape.
- **A same-origin `Origin` check is now load-bearing where none was before.** That is a new way for a deployment to be misconfigured, and its symptom is silence unless the client reports the refusal — which is why it does.

## Alternatives considered

- **SharedWorker / BroadcastChannel leader election.** The socket pool is per browser profile and workers share it, so cross-tab de-duplication dedupes without exempting. And windows are opened precisely to watch _different_ sessions, so the worst case stays ~N+1 — the same bound as the cheap option, for five times the code.
- **Folding the list stream into the session stream.** Global broadcasts would ride a connection that is destroyed and rebuilt on every session switch, and that stream has no replay, so approvals and lifecycle events would be dropped during switches. It moves the wall from three windows to six, and back to three as soon as a room is open.
- **HTTP/2.** Needs TLS with a trusted certificate; no browser implements cleartext h2 upgrade. Shipping a local CA with a CLI-installed product is unacceptable.
- **Deleting the SSE endpoints.** Considered and rejected: `docs/integrations/sse-protocol.mdx` is a published contract that opens "Read this before building any client that talks to a DorkOS session over HTTP", and the desktop shell consumes `/api/events` outside the client bundle. Keeping both is only affordable because the sequencing is shared.
