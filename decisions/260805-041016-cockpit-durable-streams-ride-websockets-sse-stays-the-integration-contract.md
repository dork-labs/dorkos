---
id: 260805-041016
title: The cockpit's durable streams ride WebSockets; SSE stays as the integration contract
status: accepted
created: 2026-08-05
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

- **The origin allowlist**, in the router, for _every_ upgrade. WebSocket handshakes are not CORS-protected: any page can open a socket to any host its user can reach, and the browser attaches that host's cookies. `Origin` is the only thing separating a cockpit tab from a page that DNS-rebound onto the port. This also _widens_ the guard — it used to live inside the terminal's own decision and now covers the terminal and the streams alike, from one place.
- **The credential gate**, in `stream-upgrade-auth.ts`, through the same `verifyRequestAuth` the HTTP gate and the MCP middleware use, plus the same additive `X-DorkOS-Agent` resolution. One credential path, not two, because a second implementation is how the socket gate and the request gate drift apart unnoticed. Both are pinned by tests that were confirmed to go red when the guard is removed.

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
- **Dev needed a proxy change.** Vite proxies requests but not upgrades unless told to, so `ws: true` on the `/api` proxy is now load-bearing: without it every durable stream and the embedded terminal are dead in dev while working perfectly in a production build, where there is no proxy in between. This was found only by driving a real browser — the cockpit rendered, the turn ran server-side, and the reply never arrived on screen.

## Alternatives considered

- **SharedWorker / BroadcastChannel leader election.** The socket pool is per browser profile and workers share it, so cross-tab de-duplication dedupes without exempting. And windows are opened precisely to watch _different_ sessions, so the worst case stays ~N+1 — the same bound as the cheap option, for five times the code.
- **Folding the list stream into the session stream.** Global broadcasts would ride a connection that is destroyed and rebuilt on every session switch, and that stream has no replay, so approvals and lifecycle events would be dropped during switches. It moves the wall from three windows to six, and back to three as soon as a room is open.
- **HTTP/2.** Needs TLS with a trusted certificate; no browser implements cleartext h2 upgrade. Shipping a local CA with a CLI-installed product is unacceptable.
- **Deleting the SSE endpoints.** Considered and rejected: `docs/integrations/sse-protocol.mdx` is a published contract that opens "Read this before building any client that talks to a DorkOS session over HTTP", and the desktop shell consumes `/api/events` outside the client bundle. Keeping both is only affordable because the sequencing is shared.
