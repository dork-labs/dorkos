# DevTools Bridge — Task Breakdown (DOR-213)

Spec: [`02-specification.md`](./02-specification.md) · Generated 2026-07-11 · mode: full

Three phases, four PR-sized tasks. The **minimal excellent core** is Phases 1–2
(console + network). Phase 3 (screenshot) is independently cuttable to a
follow-up without blocking that value.

```
1.1 ─┐
     ├─▶ 1.2 ─▶ 2.1 ─▶ 3.1
     │
  (server)  (client)  (tools)  (screenshot)
```

## Phase 1 — Capture infrastructure

The end-to-end capture pipeline, no agent surface yet (verified through the
buffer in tests). The load-bearing security choice lives here: the injected shim
talks only to `window.parent` via `postMessage` and **never** calls `/api/*`, so
untrusted page content gains no new capability and the opaque-origin sandbox is
unchanged.

### Task 1.1 — Inject shim + server ingest + per-session buffer (server) · large

- `services/workbench-serve/devtools-inject.ts` — the in-page shim (console +
  network + uncaught-error hooks, batched over postMessage) and
  `injectDevtoolsScript` (insert inline `<script>` as the first `<head>` child,
  mirroring `mcp-apps/lib/sandbox.ts`).
- Extend `handleServe` and `proxyToLocalhost` to inject into `text/html` only;
  everything else streams unchanged.
- `services/session/devtools-capture-store.ts` — bounded per-session rings
  (console 500 / network 200 / screenshot 1), dropped on session close.
- `routes/session-devtools.ts` — `POST /api/sessions/:id/devtools/ingest`
  (session-gated, Zod-validated, batch-capped).
- Shared DTOs + `WORKBENCH` constants.
- **Tests:** injection insertion edge cases, proxy HTML-only injection, ring
  eviction + per-session isolation, ingest validation/limits, shim serializer,
  and a **security regression** asserting the sandbox string is unchanged and the
  shim never targets `/api`.

### Task 1.2 — Client bridge relay (client) · medium · depends on 1.1

- `features/canvas/model/use-devtools-bridge.ts` — a `message` listener that
  accepts only `event.source === iframe.contentWindow` (origin is `"null"`), acks
  the shim handshake, coalesces batches, and relays to the ingest endpoint **only
  for the attached session**.
- Mount it at the existing DevTools-bridge seam in `CanvasBrowserContent.tsx`
  (add an iframe ref); no change to navigation, chrome, or sandbox.
- Transport `ingestDevtoolsCapture` (HttpTransport posts; DirectTransport no-ops).
- Optional: a subtle "DevTools connected" badge (cut if it risks the task).
- **Tests:** rejects foreign/nested-frame posts (the anti-spoofing guarantee),
  coalesces + relays, attached-session-only, handshake ack, unchanged sandbox.

## Phase 2 — Agent read tools (the self-verification core)

### Task 2.1 — `browser_read_console` + `browser_read_network` · medium · depends on 1.1, 1.2

- `runtimes/claude-code/mcp-tools/devtools-tools.ts` — data-returning,
  session-bound in-process MCP tools shaped exactly like `get_ui_state`. Read the
  per-session buffer; filter by `level`/`status` + `limit`; return a
  plain-language no-doc note when nothing is captured; session-less error when
  unbound.
- Register in `mcp-tools/index.ts`; add both ids to `tooling/tool-filter.ts`.
- **Codex: deliberately not exposed** (session-less external server can't resolve
  the buffer, and a read must return data in-result — same reason `get_ui_state`
  is Codex-excluded). Documented in the module doc.
- **Tests:** returns entries, honors filters/limits/`truncated`, no-doc note,
  session-less error, allowlist membership, not-registered-on-Codex.

**After Task 2.1 the edit → preview → read-own-errors → fix loop is live.**

## Phase 3 — Screenshot (independently cuttable)

### Task 3.1 — `browser_screenshot` via on-demand round-trip · large · depends on 1.1, 1.2, 2.1

- Because the parent can't canvas-read an opaque-origin frame, the shim
  rasterizes its own document with a lazy-imported `html-to-image` on demand.
- Round-trip: tool pushes a `devtools_capture_request` SSE event → client
  forwards to the frame → frame returns a PNG data URL → client ingests it tagged
  with `requestId` → the awaiting tool resolves (with an ~8 s timeout → structured
  note, never a hang).
- `browser_screenshot` returns MCP image content; allowlisted; Codex excluded.
- **Fallback (Assumption A4):** cadence-capture (latest-1) if the round-trip
  proves fiddly.
- **Server-side headless capture is rejected** — hundreds of MB fails the
  npm-CLI-install quality bar.
- **Tests:** resolves on matching ingest, clean timeout, no-preview note, event
  pushed onto the queue, client forward/relay path, lazy-import-only.

## Out of scope (from the spec)

Full DevTools clone (DOM/element inspector, live style editing, network
throttle/replay/modify, JS debugger, perf/coverage, cookie/storage inspection);
instrumenting external sites or nested frames; Codex read-tool parity in v1;
server-side headless screenshots; persisting captured data.
