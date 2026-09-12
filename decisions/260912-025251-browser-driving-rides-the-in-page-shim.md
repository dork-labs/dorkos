---
id: 260912-025251
title: The agent drives the browser through the in-page shim, never a server-side browser
status: proposed
created: 2026-09-12
spec: canvas-agent-seat
superseded-by: null
amends: null
---

# 260912-025251. The agent drives the browser through the in-page shim, never a server-side browser

## Status

Proposed (extracted from spec `canvas-agent-seat`).

## Context

DorkOS can show an agent a page and let it read what happened — console, network, a screenshot
(`devtools-tools.ts:637-645`) — but nothing can click. So "check the signup flow" is a request the
product can render and cannot answer. The obvious alternative is to run Playwright or the Chrome
DevTools Protocol on the server, which every comparable tool does. But the preview renders in the
person's browser, inside a sandboxed frame with an opaque origin, and the shim that instruments that
frame already round-trips one command by `requestId` (`devtools-shim.ts:487-489`, `:432-437`). A
server-side browser would be a second, unshared rendering of the same page, with its own cookies,
viewport and state, and nothing the person could see.

## Decision

We will extend the existing in-page shim with an `act-request` / `act-result` message pair carrying
six verbs — click, type, press, scroll, wait-for and read-page — resolved against the page by role and
accessible name, by visible text, or by CSS selector. The server mints a `requestId`, the client
forwards it into exactly one frame, the shim performs the action and posts one result, and a timeout
resolves to a plain failure rather than a hang. Requests carry a `documentId`, so a command reaches
the named preview or, with none, the active one — which also closes the "first ingest wins" race
`use-devtools-bridge.ts:341-347` documents for screenshots. Only instrumented previews are driven;
a frame that never handshook answers in a sentence instead of timing out. `browser_read_page` returns
an accessibility outline computed by the shim without a library, described as the approximation it is.

## Consequences

### Positive

- The agent acts on the page the person is looking at, in their browser, with their session state.
- No headless browser, no CDP, no second rendering, and no new process to supervise or sandbox.
- The security posture is unchanged: the shim still talks only to `window.parent`, the frame still has
  no `allow-same-origin` and no credential, and nothing gained a path to `/api/*`.
- Per-document targeting fixes a documented nondeterminism in the existing screenshot path.

### Negative

- Driving only works where the shim is injected — served files and preview-listener origins — so a
  page loaded straight from the internet cannot be driven, and the product has to say so.
- Element resolution is our own, not Playwright's: no auto-waiting, no shadow-DOM piercing, and an
  accessible-name computation that approximates accname rather than implementing it.
- The shim is source injected into arbitrary pages, so every addition to it must be executed in a real
  document to be believed, and a page that overrides a DOM API can defeat it.
- Nothing here can drive a page across a top-level navigation to an uninstrumented origin.
