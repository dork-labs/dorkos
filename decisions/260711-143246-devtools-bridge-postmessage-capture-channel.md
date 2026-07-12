---
id: 260711-143246
title: 'DevTools bridge capture architecture: in-page shim over postMessage, server-buffered, Claude-Code read tools'
status: accepted
created: 2026-07-11
spec: devtools-bridge
superseded-by: null
---

# 260711-143246. DevTools bridge capture architecture: in-page shim over postMessage, server-buffered, Claude-Code read tools

## Status

Accepted

## Context

DOR-213 gives the coding agent read access to its own preview's console output, network activity,
and screenshots via three MCP tools (`browser_read_console`, `browser_read_network`,
`browser_screenshot`). The preview renders in the v1 opaque-origin sandbox
(ADR `260708-185519`, `sandbox="allow-scripts"` without `allow-same-origin`) — a deliberate
security boundary this feature must not weaken. That single constraint dictates where each signal
can be captured: console output only exists inside the page; the loopback proxy sees only proxied
same-origin traffic, missing cross-origin fetches and client-side timing/initiator; and the parent
frame cannot canvas-read an opaque-origin document (a tainted canvas), ruling out parent-side
screenshot capture. A server-side headless browser (Playwright/Puppeteer/headless Chromium) was
considered for screenshots and rejected on install-footprint grounds — hundreds of MB fails the
npm-CLI-install quality bar.

## Decision

We will capture console, network, and screenshot signals **inside** the served/proxied page
itself, via a small, dependency-free script injected as the first `<head>` child of every
`text/html` response from `handleServe` and `proxyToLocalhost`. The shim wraps
`console.log/info/warn/error/debug`, `window.fetch`/`XMLHttpRequest`, and uncaught
error/rejection listeners, and — on an explicit request from the parent — rasterizes the page
client-side with a lazy-loaded `html-to-image` import. It delivers everything to its parent
**exclusively via `window.parent.postMessage`**, and the parent identifies it by
`event.source === iframe.contentWindow` (origin is `"null"`, so identity is the check); the
injected script **never calls `/api/*` directly** — it has no origin or credentials to do so
safely. Only the same-origin, authenticated DorkOS client relays batched messages to
`POST /api/sessions/:id/devtools/ingest`, which appends to a bounded, per-session ring-buffer
store (console 500 entries, network 200, screenshot latest-1). Three session-bound, in-process MCP
tools read that store synchronously; they ship **Claude-Code-only in v1**, mirroring the existing
`get_ui_state` session-binding constraint, because the Codex external MCP server is session-less
and cannot resolve which session's buffer a read call belongs to. Nothing captured is persisted
beyond the session's in-memory buffer; it is dropped on session close.

## Consequences

### Positive

- Adds no new capability to untrusted page content: the injected script can only script inside its
  own frame and message its parent — exactly what the sandbox already permits — so the
  opaque-origin, `allow-same-origin`-free posture of ADR `260708-185519` is preserved unchanged.
- Avoids the alternative that would have forced a real security regression: a direct `fetch`
  from the opaque-origin frame is cross-origin against the DorkOS API, which would require either
  opening a CORS-`*` ingestion endpoint any page on the internet could POST to, or being subject to
  the served page's own CSP `connect-src`. `postMessage` to `window.parent` sidesteps both.
- One in-page capture channel covers everything an agent needs to self-verify frontend work —
  cross-origin fetches, real client-side timing, and console — that a proxy-side-only approach
  would miss entirely.
- Client-side rasterization (`html-to-image`, ~11 KB gzipped, lazy-loaded inside the shim) keeps
  the CLI install free of a headless-browser dependency; screenshot cost is paid only when an agent
  actually asks for one.

### Negative

- A served page that ships its own strict CSP forbidding inline scripts silently goes
  uninstrumented — a real, disclosed limitation with no workaround short of weakening that page's
  CSP, which we explicitly refuse to do.
- Read tools are Claude-Code-only in v1; Codex parity is deferred until the Codex external MCP
  server gains a mechanism to resolve the active attached session for a session-less tool call.
- Captured console/network data can carry secrets (tokens in query strings, logged env values).
  Mitigated by never capturing request/response bodies and keeping everything in-memory,
  per-session, and gone on close — but the exposure is real under a future multi-user trust model,
  not just today's single-operator one where the agent already has a shell in the same worktree.
