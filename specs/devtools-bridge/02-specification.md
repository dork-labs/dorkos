---
slug: devtools-bridge
id: 260711-142034
created: 2026-07-11
status: specified
---

# DevTools Bridge — Specification (v2)

**Status:** Draft
**Author:** Dorian + Claude (spec-bridge agent; SPECIFY stage)
**Date:** 2026-07-11
**Tracker:** DOR-213 · v2 fast-follow to DOR-211 (Right-Panel Workbench) · builds on DOR-216 (embedded browser, PR #144)

## Overview

Give the agent eyes on the preview it already opens. When the agent edits
frontend code and opens the workbench browser (a local HTML file or a localhost
dev server), this bridge captures that page's **console output** (including
errors with stack traces), its **network requests**, and a **screenshot**, and
exposes them to the agent as read-only tools — `browser_read_console`,
`browser_read_network`, `browser_screenshot`. The agent can now edit → preview →
read its own errors → fix, without a human relaying "it's throwing a TypeError."

Modeled on Google's `chrome-devtools-mcp`, but deliberately **scoped to pages the
workbench serves or proxies** — arbitrary external sites cannot be instrumented
from an opaque-origin iframe, and we do not pretend otherwise.

## Background / Problem Statement

DorkOS v1 shipped the embedded browser (DOR-216): the agent calls
`browser_navigate`, the operator sees a live preview. But the preview is a
one-way mirror — the agent that built the page cannot see whether it works. A
`ReferenceError` in the console, a 404 on a missing asset, a blank white screen:
today the human has to notice, read it, and type it back to the agent. That
breaks the self-verification loop that makes an agent trustworthy at frontend
work, and it is exactly the loop Kai (running ten agents) does not have time to
babysit.

The v1 browser was **pre-architected for this** (parent spec D11, decision round
2 item 2): the serve route and the localhost proxy already sit in the path of
every preview byte, and `CanvasBrowserContent.tsx` carries the seam comment. This
spec attaches the capture-and-expose layer to that seam **without reworking v1
and without weakening the v1 origin-isolation model.**

### Relationship to `specs/browser-testing-system` (reconciled, per required reading)

**Scope-separate — no overlap, no supersede, no reuse.** That spec/research is a
**Playwright e2e harness for DorkOS's own test suite** (`apps/e2e`: fixtures,
page objects, `webServer` config, `@playwright/mcp` for test authoring). It is
about _DorkOS testing itself_. This spec is an **agent-facing runtime bridge**
that exposes a _user's live preview_ console/network/screenshot to the _coding
agent_ at work. Different consumer (test suite vs. agent), different surface
(Playwright driver vs. injected in-page shim + MCP read tools), different
lifecycle (CI vs. interactive session). They share the word "browser" and
nothing else. This spec neither depends on nor conflicts with it.

## Goals

- **Console capture:** the agent reads the preview's `console.log/info/warn/error/debug`
  plus uncaught errors and unhandled promise rejections, **with stack traces**.
- **Network capture:** the agent reads the preview's `fetch`/XHR requests —
  method, URL, status, timing, and a size — including failures.
- **Screenshot:** the agent gets a rendered image of the current preview.
- **Tool surface:** three read-only agent tools returning structured data,
  bound to the operator's attached session and its open browser document.
- **Zero v1 rework, zero v1 security regression:** the opaque-origin sandbox,
  signed serve/proxy URLs, and `no-referrer` posture (ADR 260708-185519) are
  unchanged; the injected script never touches `/api/*`.
- **Honest scope:** works on served/proxied pages; degrades with a clear,
  actionable message everywhere else.

## Non-Goals

- **Instrumenting arbitrary external sites.** External pages render with
  `allow-same-origin` and live on their own origin — we cannot inject a script or
  read their frame. Out, permanently, by browser design.
- **A full DevTools clone.** No DOM/element inspector, no live style editing, no
  network throttling/blocking/replay/modification, no JS debugger/breakpoints, no
  performance/coverage profiling, no cookie/localStorage inspection, no
  source-map symbolication beyond the raw stack the runtime provides.
- **Codex parity for the read tools in v1** (see Detailed Design → Tool surface).
  The write path (`browser_navigate`) already works on both runtimes; the _read_
  tools ship Claude-Code-only in v1, mirroring the existing `get_ui_state`
  session-binding constraint. **Assumption A2 (OVERRIDABLE).**
- **Server-side headless capture** (Playwright/puppeteer/headless Chromium) for
  screenshots — rejected on install-footprint grounds (see Screenshot design).
- **Persisting captured page data** to disk or across sessions. In-memory,
  per-session, bounded, gone on session close.
- **Multi-frame / nested-iframe capture.** Only the top served/proxied document
  is instrumented.

## Technical Dependencies

- **No new server runtime deps for console/network.** Injection reuses the
  existing `handleServe` (`routes/workbench-serve.ts`) and `proxyToLocalhost`
  (`services/workbench-serve/proxy.ts`) response paths.
- **Screenshot (Chunk 3):** one client-side rasterization library —
  **`html-to-image`** (MIT, ~11 KB gzipped) — lazy-loaded _inside the injected
  capture script_, never in the main client bundle. Chosen over `html2canvas`
  (larger, heavier) and over any server-side headless browser (hundreds of MB;
  fails the npm-CLI-install quality bar). **Assumption A3 (OVERRIDABLE)** on the
  exact library; the architecture is library-agnostic.
- **Reused, unchanged:** the signed-URL serve/proxy routes, the opaque-origin
  sandbox (`WORKBENCH_SANDBOX_ISOLATED` in `features/canvas/lib/browser-url.ts`),
  the session gate (`services/core/auth/session-gate.ts`), the claude-code
  in-process MCP tool server (`mcp-tools/`), the `get_ui_state` data-returning
  tool pattern (`mcp-tools/ui-tools.ts`), the tool-filter allowlist
  (`tooling/tool-filter.ts`).

## Detailed Design

### The four data channels, and why each is where it is

The central constraint is the v1 security model: the preview renders in a
**sandbox without `allow-same-origin`** (opaque `"null"` origin). That single
fact dictates every capture decision below.

| Signal     | Captured where                                                          | Travels how                                                           | Why not elsewhere                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console    | **In-page injected shim** (only place console exists)                   | `window.parent.postMessage` → client → `POST /ingest` → server buffer | The server never sees console; it lives in the page.                                                                                                                                |
| Network    | **In-page injected shim** (`fetch`/XHR wrappers)                        | same as console                                                       | The proxy sees _proxied same-origin_ traffic only — it misses cross-origin fetches and client-side timing/initiator. One uniform channel beats two partial ones. **Assumption A1.** |
| Screenshot | **In-page injected shim** (`html-to-image` rasterizes its own document) | on-demand round-trip: SSE request → client → frame → back             | Parent can't canvas-read an opaque-origin frame (tainted). Server-side headless is too heavy.                                                                                       |
| Tool reads | **Server** (per-session ring buffer)                                    | session-bound MCP tool reads the buffer synchronously                 | Mirrors `get_ui_state`: client reports state, server stores it, tool reads it.                                                                                                      |

**Why the injected script posts to the _parent_ (postMessage), never to `/api/*`
directly** — this is the load-bearing security choice:

- The frame is opaque-origin. A direct `fetch('/api/...')` from the frame would
  be cross-origin (opaque → DorkOS origin), forcing us to open a CORS-`*`
  ingestion endpoint that _any_ page on the internet could POST to, and it would
  be subject to the page's own CSP `connect-src`. Both are bad.
- `postMessage` to `window.parent` is **not** gated by CSP `connect-src`, works
  from an opaque origin, and reaches only our own client app. The client app
  (same-origin, authenticated) is the one that talks to `/api/*`. The injected
  script's blast radius stays exactly what the sandbox already allows: scripting
  inside its own frame, messaging its parent. **The bridge adds no new capability
  to untrusted page content.**

### 1. Injection (server) — `services/workbench-serve`

Add a capture script and inject it into the top-level HTML the workbench serves
or proxies.

- **New module** `services/workbench-serve/devtools-inject.ts`:
  - `DEVTOOLS_AGENT_SCRIPT: string` — the in-page shim (below), built as a
    self-contained IIFE string (or read from a co-located `.js` asset at build).
  - `injectDevtoolsScript(html: string): string` — insert
    `<script>…</script>` as the **first `<head>` child** (mirrors
    `mcp-apps/lib/sandbox.ts` `buildSandboxSrcDoc` insertion logic) so it installs
    its hooks before any page script runs. Fragment/`<html>`-only/head-less
    documents handled the same way `buildSandboxSrcDoc` handles them.
- **`handleServe`** (`routes/workbench-serve.ts`): when the resolved file's
  content-type is `text/html`, read the file to a string (HTML docs are small;
  the existing size posture is fine), inject, and send the rewritten string with
  a recomputed `Content-Length`. Non-HTML responses stream byte-for-byte
  unchanged (today's path).
- **`proxyToLocalhost`** (`services/workbench-serve/proxy.ts`): when the upstream
  `content-type` is `text/html`, buffer the (small) HTML body, inject, relay with
  recomputed length. All other content-types stream unchanged (today's path). The
  proxy already strips `frame-ancestors`; injection is one more transform on the
  same HTML-only branch.
- **Gating:** injection is on only when a capture consumer is live for the
  session (see §4 "opt-in") — but because the injected shim is inert until the
  parent acknowledges it (handshake below), always-inject is also safe. Default:
  **always inject into served/proxied HTML; the shim self-suppresses when no
  parent handshake arrives.** Keeps the serve/proxy routes stateless.

**Best-effort honesty (documented):** a served/proxied page that ships its own
strict CSP forbidding inline scripts will refuse our injected `<script>`, so that
page is not instrumented. We inject inline (not `<script src>`, which the opaque
frame would fetch cross-origin and which CSP `script-src` would more often block).
This is a real, disclosed limitation — most local HTML files and dev servers have
no such CSP; the ones that do simply get an empty console/network buffer and a
tool note saying so.

### 2. The in-page shim (the injected script)

A tiny, dependency-free IIFE that runs first in the served/proxied document:

- **Handshake:** on load, `postMessage({ __dorkosDevtools: 'hello' }, '*')` to
  the parent and listen for the parent's ack. Until acked, it buffers locally
  (small cap) and does not spin. This keeps it inert when embedded anywhere that
  is not our browser pane.
- **Console:** wrap `console.log/info/warn/error/debug`, preserving passthrough
  to the original. Serialize args safely (structured-clone-safe, depth/size
  capped, circular-safe). For `error` and thrown values, attach `.stack`.
- **Uncaught errors:** `window.addEventListener('error', …)` (message, filename,
  line/col, `error.stack`) and `'unhandledrejection'` (reason + stack).
- **Network:** wrap `window.fetch` and `XMLHttpRequest` (open/send/loadend) to
  record `{ method, url, status, ok, startedAt, durationMs, responseSize?, initiator }`.
  Never capture request/response bodies in v1 (size + secret-leak surface).
- **Delivery:** batch on a short debounce (e.g. 250 ms) and post
  `{ __dorkosDevtools: 'batch', console: [...], network: [...] }` to
  `window.parent`. Monotonic sequence numbers so the client can detect gaps.
- **Screenshot (Chunk 3):** on a `{ __dorkosDevtools: 'capture-request', requestId }`
  message from the parent, lazy-`import('html-to-image')`, rasterize
  `document.documentElement` to a PNG data URL (capped dimensions), and post
  `{ __dorkosDevtools: 'capture-result', requestId, dataUrl }` back. On failure,
  post `{ …, error }`.
- **Reset:** on `pagehide`/`beforeunload`, post `{ __dorkosDevtools: 'navigated' }`
  so the client can mark a navigation boundary in the buffer.

### 3. Client relay — `features/canvas`

`CanvasBrowserContent.tsx` (or a co-located `use-devtools-bridge.ts` hook it
mounts) owns the parent side:

- Register a `message` listener that accepts only events where
  **`event.source === iframeRef.contentWindow`** (origin is `"null"` for the
  opaque frame, so source-identity is the check — same discipline as the
  mcp-apps bridge). This rejects nested-frame and foreign posts.
- On `hello`, ack the child and start relaying.
- Batch incoming console/network (coalesce on a debounce) and
  `POST /api/sessions/:id/devtools/ingest` with `{ documentId, logicalUrl, console, network, seq }`.
  The **client** app makes this call — it is same-origin and authenticated, so it
  passes the session gate normally. The injected script never calls `/api/*`.
- Only relay for the **operator's attached session** (reuse the existing
  `attachedSessionId` guard that already gates `ui_command` delivery), so one
  session's preview never feeds another session's buffer.
- Screenshot: subscribe to a `devtools_capture_request` SSE event (see §5),
  forward it to the frame as `capture-request`, await `capture-result`, and
  `POST …/devtools/ingest` the resulting data URL with its `requestId`.

This adds a hook + listener to the existing component; no structural change. The
DevTools seam comment already in `CanvasBrowserContent.tsx` is where it lands.

### 4. Server ingestion + per-session capture store — `services/session`

- **New module** `services/session/devtools-capture-store.ts`: a
  `Map<sessionId, CaptureBuffer>` where
  `CaptureBuffer = { console: RingBuffer<ConsoleEntry>, network: RingBuffer<NetworkEntry>, screenshot: ScreenshotEntry | null, documentId, logicalUrl, updatedAt }`.
  Bounded rings — **console 500, network 200, screenshot latest-1** (constants in
  `config/constants.ts` under `WORKBENCH`). Chosen over storing on the
  per-query `session` object because capture is **continuous across turns** (the
  page emits between agent turns), so a side store keyed by session id outlives
  any single turn. Entry on session close → drop the map entry.
- **New route** `routes/session-devtools.ts` mounted under the session router:
  - `POST /api/sessions/:id/devtools/ingest` — Zod-validated batch; appends to
    the session's rings. Session-gated (credentialed client call). Rejects a body
    over a sane cap (per-batch entry limit → 413).
  - `GET`-less: the agent never reads via HTTP; it reads via the MCP tool.
- **Opt-in signal (optional refinement):** the store can expose
  `isConsumerActive(sessionId)` so injection could be conditional; v1 keeps
  injection unconditional (shim self-suppresses), so this is a no-op hook for now.

### 5. Screenshot on-demand round-trip

Screenshots are pull-based (the agent asks "what does it look like now?"), and
the frame is only reachable via its parent. So `browser_screenshot` triggers a
round-trip rather than reading a stale cadence-captured image:

1. Tool handler pushes a `devtools_capture_request` `StreamEvent`
   (`{ requestId }`) onto the session's event queue — same mechanism
   `control_ui` uses to reach the client (`session.eventQueue.push` + notify).
2. Client (attached session) receives it over SSE, forwards `capture-request` to
   the frame, gets `capture-result`, and `POST`s it to `…/devtools/ingest` tagged
   with `requestId`.
3. The tool handler awaits the matching screenshot landing in the store (poll the
   store or await a per-`requestId` resolver) with a timeout (e.g. 8 s). On
   timeout → return a structured "couldn't capture (no preview open / capture
   timed out)" result, never a hang.

**Assumption A4 (OVERRIDABLE):** if the round-trip proves fiddly, the fallback is
cadence-capture (shim rasterizes on load + throttled mutation, ingests
latest-1; tool returns latest with a freshness timestamp). Recommended design is
the round-trip (fresh, no wasted rasterization); Chunk 3 is independently
cuttable to a follow-up if it risks the release.

### 6. Tool surface (the read tools)

Three **data-returning, session-bound, in-process MCP tools** registered in the
claude-code adapter — the exact shape of the existing `get_ui_state` tool
(`mcp-tools/ui-tools.ts`): bound to a session at creation, read server state,
return structured JSON; session-less variant returns a clear error.

- **New module** `services/runtimes/claude-code/mcp-tools/devtools-tools.ts`
  exporting `getDevtoolsTools(deps, session?)`, wired into
  `mcp-tools/index.ts` alongside `getUiTools`.
- **Tools** (names mirror `chrome-devtools-mcp` conventions):
  - `browser_read_console` — input `{ level?: "error"|"warn"|"info"|"log"|"debug"|"all", limit?: number }`.
    Returns `{ documentUrl, capturedAt, entries: ConsoleEntry[], truncated, note? }`.
    `ConsoleEntry = { level, text, args?, stack?, timestamp, source? }`.
  - `browser_read_network` — input `{ status?: "all"|"failed", limit?: number }`.
    Returns `{ documentUrl, capturedAt, requests: NetworkEntry[], truncated, note? }`.
    `NetworkEntry = { method, url, status, ok, durationMs, responseSize?, timestamp }`.
  - `browser_screenshot` — input `{}` (v1). Returns MCP **image content** (PNG)
    plus `{ documentUrl, capturedAt }`, or a structured note on no-preview/timeout.
- **Staleness / no-doc semantics:** every tool resolves the session's
  `CaptureBuffer`. If none exists (no workbench browser document open, or the open
  doc is an external/non-instrumentable page), return
  `{ entries: [], note: "No workbench browser document is currently open, or the open page can't be instrumented (external sites and pages with a strict CSP are not captured). Ask the user to open a local preview with browser_navigate." }`.
  The `capturedAt`/`documentUrl` fields let the agent judge freshness.
- **Tool-filter allowlist:** add the three tool ids to
  `tooling/tool-filter.ts` (mirroring `mcp__dorkos__get_ui_state`).
- **Codex:** **not exposed in v1.** Rationale is identical to why `get_ui_state`
  is Codex-excluded (`codex-ui-mcp-server.ts` module doc): the Codex external MCP
  server is session-less, so a read tool there cannot resolve _which_ session's
  buffer to read, and — unlike the fire-and-forget `control_ui` write, whose real
  effect the event-mapper injects downstream — a read tool must return data _in_
  its result, which a session-less stub cannot produce. `browser_navigate`
  (opening the preview) already works on both runtimes. Codex read parity is a
  tracked follow-up (**Assumption A2, OVERRIDABLE**).

### Code structure & file organization

- **Server:**
  - `apps/server/src/services/workbench-serve/devtools-inject.ts` (new — script + `injectDevtoolsScript`)
  - `apps/server/src/routes/workbench-serve.ts` (extend `handleServe` HTML branch)
  - `apps/server/src/services/workbench-serve/proxy.ts` (extend HTML-relay branch)
  - `apps/server/src/services/session/devtools-capture-store.ts` (new — ring buffers)
  - `apps/server/src/routes/session-devtools.ts` (new — ingest route)
  - `apps/server/src/services/runtimes/claude-code/mcp-tools/devtools-tools.ts` (new)
  - `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts` + `tooling/tool-filter.ts` (wire + allowlist)
  - `apps/server/src/config/constants.ts` (`WORKBENCH` buffer caps, debounce, screenshot timeout/dims)
- **Shared:** `packages/shared/src/schemas.ts` — `DevtoolsIngestSchema`,
  `ConsoleEntrySchema`, `NetworkEntrySchema`, `DevtoolsCaptureRequest` StreamEvent
  variant, and the tool I/O DTOs.
- **Client:**
  - `apps/client/src/layers/features/canvas/model/use-devtools-bridge.ts` (new hook)
  - `apps/client/src/layers/features/canvas/ui/CanvasBrowserContent.tsx` (mount the hook at the seam)
  - transport method for the ingest POST + capture-request SSE handling
    (`packages/shared/src/transport.ts` + both impls; `DirectTransport` no-ops —
    the browser is web-only already).

### API changes

- **New:** `POST /api/sessions/:id/devtools/ingest` (session-gated; batch of
  console/network entries and/or a screenshot data URL tagged by `requestId`).
- **New SSE event:** `devtools_capture_request` on the session event stream
  (server → attached client), carrying `{ requestId }`.
- **Extended (transparently):** `GET /api/workbench/serve/:token/*` and
  `ALL /api/workbench/proxy/:token/*` now inject a script into `text/html`
  responses. No signature/route change; behavior change confined to HTML bodies.

### Data model changes

None persistent. The per-session `CaptureBuffer` is in-memory, bounded, and
dropped on session close. No DB, no config schema change (buffer caps are
constants, not user config — revisit only if operators need to tune them).

## User Experience

- **The agent** (primary "user" here): after `browser_navigate` opens a local
  preview, the agent calls `browser_read_console` and sees
  `Uncaught TypeError: Cannot read properties of undefined (reading 'map') at App.tsx:42`
  — with the stack — then fixes it and re-reads to confirm the console is clean.
  `browser_read_network` surfaces the `404 /assets/logo.svg` it forgot to create.
  `browser_screenshot` gives it the rendered page to eyeball layout.
- **The operator:** nothing new to learn. The preview looks and behaves exactly
  as v1. Optionally, a small "DevTools connected" affordance in the browser chrome
  (a subtle dot/badge) tells the operator the agent can see this page's console —
  honest transparency, no new controls. (Nice-to-have; cut if it risks a chunk.)
- **Degradation:** on an external site, a page with a blocking CSP, or with no
  preview open, the tools return a plain-language note telling the agent exactly
  why and what to do (open a local preview). No errors, no confusion.
- **Obsidian/DirectTransport:** the browser is already web-only there; the bridge
  is simply absent, consistent with the parent spec's web-first framing.

## Testing Strategy

- **Unit (server — injection):** `injectDevtoolsScript` inserts before the first
  `<head>` child; handles head-less fragments and `<html>`-only docs; leaves
  non-HTML untouched. Purpose: prove the shim installs before page scripts and
  never corrupts non-HTML. Edge cases that can fail: uppercase `<HEAD>`,
  attributes on `<head …>`, doctype-only preamble.
- **Unit (server — proxy):** HTML upstream is buffered+injected+length-recomputed;
  non-HTML upstream streams unchanged; injection composes with existing
  `frame-ancestors` stripping.
- **Unit (server — store):** ring eviction at the caps (501st console entry drops
  the 1st); per-session isolation (session B never reads session A's buffer);
  navigation marker resets/segments; drop on close.
- **Unit (server — ingest route):** Zod rejection of malformed batches; per-batch
  size cap → 413; session-gated (401 without auth when auth enabled);
  unknown-session handling.
- **Unit (server — tools):** `browser_read_console`/`_network` return buffered
  entries, honor `level`/`status`/`limit` filters, return the no-doc note when the
  buffer is empty, and return the session-less error when unbound (mirror the
  `get_ui_state` test). `browser_screenshot` resolves on a matching ingest and
  times out cleanly with a structured note.
- **Unit (client — shim serialization):** the argument serializer is
  circular-safe, depth/size-capped, and preserves stack traces (run the shim's
  pure helpers under vitest; the DOM hooks are covered by the RTL test).
- **Client (RTL + mock Transport):** the bridge hook accepts only
  `event.source === contentWindow` messages (rejects a foreign/nested post),
  batches to the ingest transport method, relays only for the attached session,
  and drives the screenshot round-trip (request → frame → result → ingest).
- **E2E (Playwright, `apps/e2e`):** serve a local HTML file that throws a
  `console.error` and does a failing `fetch`; assert `browser_read_console` and
  `browser_read_network` (via a test-mode agent / direct tool exercise) return the
  entries; assert a CSP-locked page yields the no-instrumentation note; assert the
  opaque-origin sandbox flags are unchanged (regression guard on the v1 security
  model).
- **Security regression:** an explicit test asserting the injected script cannot
  reach `/api/*` (it has no origin/credentials) and that the sandbox string is
  still `WORKBENCH_SANDBOX_ISOLATED` (no `allow-same-origin`).
- **Mocking:** `FakeAgentRuntime` for tool wiring; mock Transport for the client;
  a fake `contentWindow`/`postMessage` for the bridge hook; a stub
  `html-to-image` for the screenshot path.

## Performance Considerations

- **Injection** touches only `text/html` responses (small); assets stream
  unchanged, so preview asset throughput is unaffected. Length is recomputed only
  for the injected HTML.
- **Shim overhead** in the page: console/network wrappers are thin; batching on a
  250 ms debounce bounds postMessage volume; the serializer is depth/size-capped
  so a giant logged object can't stall the page.
- **Buffers** are bounded rings (500/200/1) per session — O(cap) memory, not
  O(page lifetime). Screenshots are single-slot and dimension-capped.
- **Screenshot** is on-demand only (no background rasterization in the
  recommended design), so it costs nothing until the agent asks.
- **`html-to-image`** is lazy-imported _inside the shim_, so it never enters the
  main client bundle and only downloads if a screenshot is actually requested.

## Security Considerations

The v1 origin-isolation model (ADR 260708-185519) is the thing to protect. This
design was chosen specifically to preserve it:

- **The injected script gains untrusted page content no new capability.** It runs
  inside the existing `allow-scripts`, opaque-origin sandbox and talks only to its
  parent via `postMessage` — a channel the sandbox already permits. It never
  calls `/api/*` (it _can't_: opaque origin, no credentials), so no CORS hole and
  no CSP `connect-src` dependency are introduced. **The sandbox string is
  unchanged; `allow-same-origin` is still absent.**
- **The credentialed ingestion path is the client app, not the page.** Only the
  same-origin, authenticated DorkOS client posts to `/api/sessions/:id/devtools/ingest`,
  passing the normal session gate. The trust boundary is exactly where v1 put it.
- **Source-identity validation:** the client accepts capture messages only from
  its own iframe's `contentWindow` (origin is `"null"`, so identity is the check)
  — a nested frame or a foreign window cannot inject fake capture data.
- **Cross-session isolation:** the capture store is keyed by session id, the read
  tools are session-bound, and relay is gated to the attached session — one
  session's page data can never reach another session's agent.
- **Captured-data sensitivity:** console output and request URLs can contain
  secrets (tokens in query strings, logged env). v1 **does not capture request or
  response bodies**, keeps everything in memory only, never persists, and drops on
  session close. Under the single-operator trust model the agent already has a
  shell in this worktree — reading the preview's console is strictly less reach
  than that. Documented in the ADR.
- **Injection honesty:** a page whose own CSP forbids inline scripts is not
  instrumented (the tools say so). We never weaken a page's CSP to force
  instrumentation.

## Documentation

- **User docs (`docs/`):** extend "The Workbench" with "Your agent can see the
  preview" — what the bridge captures, that it works on local files and localhost
  dev servers (not external sites), and the single-operator privacy note. Follow
  `writing-for-humans`. Do not claim Obsidian support (demo-claim gate).
- **`contributing/`:** extend the workbench architecture guide with the capture
  data-flow (inject → postMessage → ingest → buffer → tool), the security
  rationale (why postMessage-to-parent, not fetch-to-API), and how to add a
  future capture signal. Changelog fragment per chunk.
- **ADR:** `260711-143246` "DevTools bridge capture architecture: in-page shim
  over postMessage, server-buffered, Claude-Code read tools"
  (`decisions/260711-143246-devtools-bridge-postmessage-capture-channel.md`,
  proposed; records: shim vs. proxy-side capture; postMessage vs. direct POST;
  in-page rasterization vs. server headless; Codex read-tool exclusion;
  retention model).

## Implementation Phases

- **Phase 1 — Chunk 1 (Capture infrastructure):** injection + shim + client relay
  - ingest route + server buffer. Ships console+network capture end-to-end, but
    no agent-facing surface yet (verify via the ingest store in tests). Prereq for 2 & 3.
- **Phase 2 — Chunk 2 (Read tools):** `browser_read_console` + `browser_read_network`
  MCP tools + allowlist. This is the **minimal excellent core** — the
  self-verification loop is live after Chunk 2.
- **Phase 3 — Chunk 3 (Screenshot):** shim rasterization + on-demand round-trip +
  `browser_screenshot`. Independently cuttable to a follow-up without blocking the
  console/network value.

## Open Questions

- **Q1 — Screenshot round-trip vs. cadence-capture.** Recommended: on-demand
  round-trip (§5). Fallback: cadence-capture. Resolved at Chunk-3 build time;
  non-blocking (Assumption A4).
- **Q2 — Codex read-tool parity.** v1 excludes it (Assumption A2), mirroring
  `get_ui_state`. If a session-resolution mechanism for the Codex external MCP
  server lands (e.g. active-attached-session resolution), parity becomes a small
  follow-up. Non-blocking.
- **Q3 — "DevTools connected" operator affordance.** Include a subtle badge in the
  browser chrome, or keep the bridge invisible? Default: subtle badge (honesty
  that the agent can see this page). Non-blocking; cut if it risks Chunk 1.

## Related ADRs

- `260708-185519` local-HTML serving + origin isolation — **the model this must
  not break.**
- `260708-185518` multi-document canvas model (browser docs live here).
- `260708-111459` two-tier generative UI (never invent a third delivery
  mechanism — the read tools are plain MCP tools, the capture-request rides the
  existing SSE event stream).
- **`260711-143246`** DevTools bridge capture architecture: in-page shim over
  postMessage, server-buffered, Claude-Code read tools
  (`decisions/260711-143246-devtools-bridge-postmessage-capture-channel.md`,
  proposed).

## References

- Parent: `specs/right-panel-workbench/01-ideation.md` (D11, round 2 item 2,
  research §4), `02-specification.md` (Non-Goals), `04-implementation.md`.
- Shipped seam: `apps/server/src/routes/workbench-serve.ts`,
  `apps/server/src/services/workbench-serve/proxy.ts`,
  `apps/client/src/layers/features/canvas/ui/CanvasBrowserContent.tsx`,
  `apps/client/src/layers/features/canvas/lib/browser-url.ts`.
- Tool precedent: `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts`
  (`get_ui_state`), `services/runtimes/shared/ui-tool-contract.ts`,
  `services/runtimes/codex/codex-ui-mcp-server.ts` (why Codex is read-excluded).
- Sandbox precedent: `apps/client/src/layers/features/mcp-apps/lib/sandbox.ts`.
- External: Google `chrome-devtools-mcp` (tool-naming + scope model),
  `html-to-image`.
- Prior art reconciled (scope-separate): `research/20260225_browser_testing_system.md`,
  `specs/browser-testing-system/`.

## Assumption Trail

- **A1 — In-page shim is the single capture channel for both console and
  network** (not proxy-side network logging). Rationale: the proxy sees only
  proxied same-origin traffic and no console at all; one uniform in-page channel
  catches cross-origin fetches and client timing and avoids double-capture.
  Reversible. _Default taken; non-blocking._
- **A2 (OVERRIDABLE) — Read tools ship Claude-Code-only in v1; Codex excluded**,
  mirroring `get_ui_state`'s session-binding constraint. The write path already
  works on both. Codex parity is a tracked follow-up. _Senior-architect default
  on a genuine runtime fork._
- **A3 (OVERRIDABLE) — `html-to-image` for in-page rasterization**, lazy-loaded
  inside the shim; server-side headless capture rejected on CLI-footprint grounds.
  Library choice is swappable; the architecture is library-agnostic.
- **A4 (OVERRIDABLE) — Screenshot uses an on-demand SSE round-trip** (fresh, no
  wasted work) with a cadence-capture fallback if the round-trip proves fiddly.
  Chunk 3 is independently cuttable.
- **A5 — Injection is always-on for served/proxied HTML; the shim self-suppresses
  until the parent handshakes**, keeping the serve/proxy routes stateless.
  Reversible to consumer-gated injection if load warrants.
- **A6 — Buffer caps (console 500 / network 200 / screenshot 1) are constants,
  not user config.** No config-schema migration in v1; promote to config only if
  operators need tuning.
