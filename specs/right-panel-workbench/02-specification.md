---
slug: right-panel-workbench
id: 260708-144354
created: 2026-07-08
status: specified
---

# Right-Panel Workbench — Specification (v1)

**Status:** Draft
**Author:** Dorian + Claude (orchestrated; decisions in `01-ideation.md` D1–D11)
**Date:** 2026-07-08
**Tracker:** DOR-211 (umbrella) · project "Right-Panel Workbench" · fast-follows DOR-212 (diff viewer), DOR-213 (DevTools bridge)

## Overview

Turn the DorkOS right panel into a **workbench**: a tree file explorer with full CRUD, a file-viewer matrix (text/code, images, PDF, 3D, CSV, markdown), an embedded browser with navigation chrome and local-HTML/dev-server serving, and an embedded terminal. The agent can open files, URLs, and terminals into the panel. Built on the already-shipped right-panel extension slot and the generative-UI canvas content union (PRs #127–#136, merged 2026-07-08), not around them.

## Background / Problem Statement

DorkOS is mission control for coding agents, but today the operator cannot **see or touch the workspace** without leaving the cockpit. The canvas renders agent-pushed markdown/image/PDF, but there is no way to browse the file tree, edit a non-markdown file, preview a running dev server, or run a shell command in the session's worktree. Every "let me just look at that file / run that command / check the preview" forces a context switch to a separate editor and terminal — breaking the single-pane-of-glass promise and the worktree isolation the product is built around. Kai (10 agents across 5 projects) needs to inspect and correct agent work in place; Priya needs to read files before trusting output. The workbench closes that gap inside the cockpit.

## Goals

- **File explorer**: hierarchical tree rooted at the session cwd, worktree-aware (branch/workspace badge), lazy-expanding, with create / rename / delete / move for files and folders.
- **Viewer matrix**: view text/code (CodeMirror 6, syntax-highlighted, editable+save), images (reuse shipped `image` canvas), PDF (reuse shipped `pdf`), 3D models (glTF/GLB/STL/OBJ), CSV (table), markdown (reuse shipped Blintz).
- **Embedded browser**: navigation chrome (back/forward/reload/URL), render local HTML files (relative assets work) and localhost dev servers, degrade gracefully for un-embeddable external sites.
- **Terminal**: xterm.js terminal attached to a PTY spawned in the session cwd/worktree; web-only in v1.
- **Multi-document canvas**: several files/pages open at once via a document-tab strip; agent `open_*` commands append-and-activate.
- **Agent control**: new `control_ui` actions (`open_file`, `open_terminal`, `browser_navigate`) wired for both claude-code and codex.
- **Extensibility**: first-party mime→viewer registry with config-choosable defaults; third-party viewers routed to MCP Apps; terminal/browser not third-party-swappable in v1.

## Non-Goals

- Third-party/marketplace-swappable terminal or browser implementations (MCP-Apps is the sanctioned third-party viewer path; terminal/browser stay first-party — D7).
- Full IDE: multi-file language services (Monaco-class IntelliSense), debugger, SCM/git UI.
- Diff viewer with per-hunk accept — **fast-follow DOR-212**, after v1 ships and verifies.
- DevTools bridge (console/network/screenshot → agent) — **fast-follow DOR-213 (v2)**; v1 browser is pre-architected for it.
- Guaranteed embedding of arbitrary external sites (X-Frame-Options makes this impossible in-browser).
- Obsidian/DirectTransport parity for byte-serving viewers, browser, and terminal (web-first; `transport.mediaUrl` returns `null` under DirectTransport). Terminal tab hidden there.
- Split panes / side-by-side documents (v2); mobile terminal beyond degraded read-mostly; `pip`/floating surfaces.

## Technical Dependencies

- **`@xterm/xterm`** + `@xterm/addon-fit` + `@xterm/addon-webgl` (MIT) — terminal renderer. Ghostty-web noted as a future same-API drop-in; rejected for v1 (data:-WASM breaks under strict CSP; unoptimized).
- **`node-pty`** (MIT) — PTY spawning on the server. Native addon; must build on Node 20/22 across the CLI's supported platforms (verify in the terminal chunk before committing).
- **CodeMirror 6** (`@codemirror/state`, `/view`, `/language`, `/commands`, `/lang-*`, `@uiw/react-codemirror` wrapper) (MIT) — text/code editor, ~50–300KB tree-shaken.
- **`@google/model-viewer`** (Apache-2.0) — glTF/GLB. **three.js** `STLLoader`/`OBJLoader` for STL/OBJ.
- **`react-zoom-pan-pinch`** (MIT) — image zoom/pan (enhances the shipped image viewer).
- **`papaparse`** (MIT) — CSV parse; render via existing TanStack Virtual table.
- Already shipped and reused: `GET /api/files/raw`, `transport.mediaUrl`, `PUT /api/files/content`, `boundary.ts`, the 7-variant canvas union, `control_ui` + `ui-action` channels, the mcp-apps sandbox (`lib/sandbox.ts`).

## Detailed Design

### Architecture changes

Two new **right-panel contributions** (`Files`, `Terminal`) registered in `apps/client/src/app/init-extensions.ts`, siblings to `agent-hub` and `canvas`. Viewers extend the **canvas** content union (canvas stays the single document stage; explorer clicks open into it). The browser is a new canvas content variant with chrome. Three server domains are added/extended: file CRUD (`services/workspace` or `routes/files.ts`), a local-HTML/proxy serving domain, and a new `services/terminal` PTY domain.

**Canvas becomes multi-document (D11).** Replace the single-slot canvas store with `openDocuments: CanvasDocument[]` + `activeDocumentId`. `CanvasDocument = { id, content: UiCanvasContent, openedAt, sourceLabel }`. `open_canvas`/`open_file`/`browser_navigate` **append-and-activate** (dedup by `sourcePath`/URL → re-activate existing); `update_canvas` mutates the active doc. LRU eviction at a cap (start 12). Per-document `canvasEditing` state (edit-protection is per-doc, not global). A tab strip in `CanvasHeader` renders open docs with close buttons. Persistence (`use-canvas-persistence.ts`) serializes the document array per session.

### Implementation approach — six execution chunks

**Chunk A — File-service foundation** (server + shared + transport; prerequisite for B, C).

- New endpoints on `routes/files.ts` (all reuse `validateBoundary` double-check against session cwd, atomic writes, boundary error → HTTP mapping):
  - `GET /api/files/tree?cwd=&path=&depth=` → one directory level: `{ entries: FileEntry[] }`, `FileEntry = { name, path, type: 'file'|'dir', size, mtime, isSymlink }`. Lazy (depth 1 default); honors `.gitignore` via the existing `file-lister` git awareness, with a `showHidden` flag.
  - `GET /api/files/content?cwd=&path=` → **text** file content (UTF-8) + SHA-256, size-capped (e.g. 5 MB → 413). Distinct from `/raw` (bytes/media). Returns `{ content, hash, encoding }`; 415 for binary.
  - `POST /api/files` → create file or dir (`{ cwd, path, type, content? }`); 409 if exists; atomic.
  - `DELETE /api/files?cwd=&path=` → delete file/dir (recursive for dir with explicit flag); refuses cwd root.
  - `POST /api/files/rename` → `{ cwd, from, to }` move/rename; 409 if target exists; both paths boundary-validated.
  - Extend `GET /api/files/raw` MEDIA allowlist for 3D model MIME types (`model/gltf-binary`, `model/gltf+json`, `model/stl`, `.obj`) so viewers can stream model bytes.
- **Transport methods** (both `HttpTransport` and `DirectTransport`): `readFileTree`, `readFileContent`, `createEntry`, `deleteEntry`, `renameEntry`. DirectTransport implements via in-process fs (Obsidian gets explorer + text editing; only byte-serving viewers/browser/terminal remain web-only).
- Shared Zod schemas for all request/response DTOs in `packages/shared/src/schemas.ts`.

**Chunk B — File explorer UI** (client `Files` right-panel contribution; depends on A).

- New FSD feature `apps/client/src/layers/features/file-explorer/`. Tree component (lazy-expand, keyboard nav, virtualized for large dirs), rooted at `selectedCwd`, workspace/branch badge via `transport.resolveWorkspace(cwd)`. Context menu + inline rename for CRUD (create/delete/rename/move), each calling the Chunk-A transport methods with optimistic UI + rollback on error. Drag-to-move. Click a file → dispatch `open_file` locally (opens the right viewer in the canvas tab). "Agent touched this" provenance badges (from the `ui-action`/session event stream) — nice-to-have within B, cut if it risks the chunk.
- Register `files` contribution (icon `FolderTree`, priority 15, `visibleWhen` any session-scoped route) in `init-extensions.ts`.

**Chunk C — Viewer matrix + CodeMirror editor** (client canvas renderers + new canvas variants; depends on A).

- New canvas content variants in `UiCanvasContentSchema`: `file` (`{ sourcePath, language?, readOnly? }` — CodeMirror text/code), `model3d` (`{ src }`), `csv` (`{ src }`). Extend `contentType` enum + `applyUiCommandToState`.
- `CanvasFileContent.tsx` — CodeMirror 6, language auto-detected from extension, read-only by default with an edit toggle; save via the existing `useCanvasFileSave` → `PUT /api/files/content` optimistic-concurrency flow; per-doc `canvasEditing` protection. Markdown still routes to Blintz; everything else routes to CodeMirror.
- `CanvasModel3dContent.tsx` — `<model-viewer>` for glTF/GLB; three.js loaders for STL/OBJ; bytes via `transport.mediaUrl`.
- `CanvasCsvContent.tsx` — papaparse + virtualized table.
- Enhance shipped `CanvasImageContent` with `react-zoom-pan-pinch` (in-canvas zoom/pan).
- A **mime→viewer registry** (`packages/shared` or a `workbench` feature): maps extension/MIME → canvas content `type`, with a config field (`workbench.defaultViewers`) letting the default be overridden. This is the first-party extensibility seam (D7).

**Chunk D — Embedded browser + local-HTML serving** (server serving/proxy + client browser chrome; closes DOR-98; depends on multi-doc from C or a shared prerequisite).

- Server: session-cwd-scoped **static serving** route for local HTML (`GET /api/workbench/serve/:token/*`), authenticated by **short-lived signed URLs** (not API cookie/header auth), serving from the confined cwd so relative assets resolve. Plus a **reverse-proxy** route (`/api/workbench/proxy/:port/*` → `http://localhost:<port>`) that strips `X-Frame-Options`/`frame-ancestors` for dev-server preview.
- **Security (D6):** served/proxied content renders in a sandboxed iframe **without `allow-same-origin`** (opaque origin — mirrors the mcp-apps posture in `lib/sandbox.ts`), so a malicious local HTML file can never ride the user's credentials into `/api/*`. Threat model differs from mcp-apps (arbitrary URLs / untrusted project files vs. trusted server-fetched app HTML) — documented in the ADR.
- Client: browser content variant with chrome (URL bar, back/forward via an in-component history stack, reload), replacing/extending `CanvasUrlContent`. External-site embedding: attempt iframe → detect load refusal (X-Frame-Options) → show "open in system browser" affordance. Architected so the DevTools bridge (DOR-213) can attach: the proxy already sees all traffic; console capture will be an injected script on served pages.
- Port-detection → auto-offer preview: **nice-to-have**, cut to DOR follow-up if it risks the chunk.

**Chunk E — Terminal** (server PTY domain + client xterm tab; independent, can parallelize).

- Server: new `apps/server/src/services/terminal/` domain. PTY lifecycle keyed to a terminal-session id, spawned in the session cwd/worktree. Byte-stream transport over **WebSocket** (new `/api/terminal/:id/socket`) — SSE is JSON-event only; a PTY needs a bidirectional byte channel. Input POST or the same socket; resize control message. Idle/exit teardown; boundary-confined cwd.
- Transport: `openTerminal(cwd)` → duplex stream modeled on `subscribeSession`'s `AsyncIterable`+`AbortSignal` shape, plus a `writeTerminal`/`resizeTerminal` control path. `DirectTransport` throws "unsupported" (tab hidden).
- Client: `apps/client/src/layers/features/terminal/` — xterm.js + fit + webgl addons, resize observer → PTY resize, theme from Tailwind tokens. Register `terminal` contribution (icon `SquareTerminal`, priority 25) with `visibleWhen` = has-http-transport AND session-scoped (hidden under DirectTransport, D3, and on mobile it's read-mostly).
- Verify `node-pty` builds on the CLI's Node 20/22 targets **first** (spike at chunk start); if it can't ship in the bundled CLI, escalate before building the UI.

**Chunk F — Agent control_ui actions** (shared + both runtimes; depends on B/C/D/E surfaces existing).

- New `UiCommandSchema` actions: `open_file` (`{ sourcePath }` → resolves viewer via the registry, opens in canvas), `open_terminal` (`{ cwd? }` → opens/focuses terminal tab), `browser_navigate` (`{ url }` → opens browser doc). Each added in the **3-place recipe**: `UiCommandSchema`, `ui-tool-contract.ts` (`CONTROL_UI_DESCRIPTION` + `CONTROL_UI_INPUT`), `applyUiCommandToState`. Codex parity via the shared contract + `codex-ui-mcp-server.ts` event-mapper interception. Honor per-doc `canvasEditing`.

### Code structure & file organization

- Server: `apps/server/src/routes/files.ts` (extend), new `apps/server/src/services/terminal/`, new `apps/server/src/routes/workbench-serve.ts` + `services/workbench-serve/` (static+proxy), `apps/server/src/routes/terminal.ts`.
- Shared: `packages/shared/src/schemas.ts` (DTOs + canvas variants + UiCommand actions), `packages/shared/src/transport.ts` (new methods), viewer registry.
- Client: `layers/features/file-explorer/`, `layers/features/terminal/`, `layers/features/canvas/ui/Canvas{File,Model3d,Csv}Content.tsx` + multi-doc store changes, `layers/features/canvas/ui/CanvasBrowserContent.tsx`, `app/init-extensions.ts` (register 2 tabs).

### API changes

New: `GET /api/files/tree`, `GET /api/files/content`, `POST /api/files`, `DELETE /api/files`, `POST /api/files/rename`, `GET /api/workbench/serve/:token/*`, `/api/workbench/proxy/:port/*`, `GET /api/terminal/:id/socket` (WS), `POST /api/terminal` (create), `DELETE /api/terminal/:id`. Extended: `GET /api/files/raw` (3D MIME allowlist).

### Data model changes

Canvas store: single content object → `openDocuments[] + activeDocumentId`. New config field `workbench.defaultViewers` (mime→viewer overrides) via the config-manager Zod schema + semver migration (per `adding-config-fields` skill). No DB schema changes (files are on disk; terminals are ephemeral).

## User Experience

- **Explorer:** operator opens the Files tab; tree shows the session's worktree rooted at cwd with a branch badge. Expand folders lazily; click a file → it opens in the Canvas tab in the right viewer. Right-click / long-press → New File, New Folder, Rename, Delete; inline rename; drag to move. Errors (permission, conflict) surface as toasts with the boundary-safe message.
- **Viewers:** text/code opens read-only with an edit pencil (mirrors markdown); edit → save is optimistic-concurrency-guarded (409 → Reload/Overwrite). Images zoom/pan; 3D orbit/zoom; CSV sorts.
- **Browser:** operator opens a URL or clicks a served-HTML file; chrome offers back/forward/reload/URL. Local files and localhost dev servers render inline; un-embeddable external sites show "open in system browser."
- **Terminal:** Terminal tab (web only) gives a shell in the worktree; resize reflows; hidden entirely under Obsidian.
- **Agent-driven:** the agent runs `open_file` / `browser_navigate` / `open_terminal`; the panel opens and activates the relevant document/tab (only for the session the operator is attached to — the existing `attachedSessionId` guard).

## Testing Strategy

- **Unit (shared):** Zod round-trips for every new DTO, canvas variant, and UiCommand action; the mime→viewer registry resolution + config override; multi-doc store reducer (append-and-activate, dedup, LRU eviction, per-doc edit-protection).
- **Unit (server):** file CRUD routes — create/delete/rename happy paths + boundary-escape rejection (`..`, symlink), 409 conflicts, cwd-root refusal, size cap 413, binary 415; signed-URL serve route (valid/expired/forged token, path confinement); proxy header-stripping; terminal PTY lifecycle (spawn in cwd, resize, teardown, boundary confinement) with a mock pty. Each test carries a purpose comment; include the escape-rejection edge cases that can actually fail.
- **Client (RTL + mock Transport):** explorer tree expand/CRUD with optimistic rollback; CodeMirror edit→save→409 flow; viewer dispatch per mime; browser history nav + X-Frame-Options fallback; terminal tab hidden under a DirectTransport mock.
- **Integration/E2E (Playwright):** open a file from the explorer into the canvas; edit + save a text file; render a local HTML file with a relative asset; open a terminal and run `echo`; agent `open_file` opens the viewer. `visibleWhen` gating verified across transports.
- **Mocking:** `FakeAgentRuntime` for runtime tool wiring; a mock `node-pty` for terminal unit tests; mock Transport for client.

## Performance Considerations

- Tree listing is lazy (depth 1) and paginated/virtualized for large dirs; reuse `file-lister`'s cache where applicable. Text-content route is size-capped (5 MB). Viewers lazy-load their heavy deps (CodeMirror, model-viewer/three.js, xterm) via `React.lazy` + route/tab-level code-splitting so the main bundle is unaffected — matching the existing `BlintzCanvas` lazy pattern. Terminal WebGL renderer for smooth output; DOM fallback. Multi-doc LRU cap bounds memory.

## Security Considerations

- **Every** new file/dir/serve/terminal route reuses `validateBoundary` (double-validated against session cwd) — no path logic reinvented. Null-byte/symlink-escape rejection is mandatory-tested.
- **Local-HTML origin isolation (the central risk):** served/proxied content runs in a `sandbox="allow-scripts"` iframe **without `allow-same-origin`** (opaque origin), authenticated by short-lived signed URLs rather than the API's own auth — a workspace HTML file (possibly agent-fetched from the internet) cannot call `/api/*` as the user. Mirrors `mcp-apps/lib/sandbox.ts`.
- **Terminal = arbitrary code execution by design** — it's a shell in the user's worktree. Scope: same trust level as the agent already has (the agent runs shell commands). Confine cwd to the boundary; no privilege escalation beyond the user's own shell; hidden under untrusted embed contexts. Document the trust assumption in the ADR.
- Proxy route only targets `localhost:<port>` (no SSRF to arbitrary hosts); validate the port is a bound local dev server.
- CSP planned up front so iframes + (future) xterm/ghostty-web don't trip it (the OpenCode `data:`-WASM lesson).

## Documentation

- User docs (Fumadocs `docs/`): "The Workbench" — explorer, viewers, browser preview, terminal; note web-only surfaces. Never claim Obsidian parity for byte-serving/terminal (demo-claim gate).
- `contributing/`: a workbench architecture guide (canvas multi-doc model, viewer registry, adding a viewer, the serve/proxy security posture, PTY transport). Changelog fragments per chunk.

## Implementation Phases

- **Phase 1 — Foundation (Chunk A):** file-service endpoints + transport methods + DTOs. Unblocks B and C.
- **Phase 2 — Core surfaces (Chunks B, C, E in parallel):** explorer, viewer matrix + editor, terminal. E is independent (gated on the node-pty spike); B and C depend on A.
- **Phase 3 — Browser + agent control (Chunks D, F):** D closes DOR-98; F wires agent actions once the surfaces exist. Multi-doc canvas store lands early in Phase 2 (shared prerequisite for C/D) — sequence it as the first task of C.
- **Fast-follows (post-v1, separate):** DOR-212 diff viewer, DOR-213 DevTools bridge.

## Open Questions

- ~~**Q1 — node-pty in the bundled CLI.**~~ **(RESOLVED 2026-07-08 — 🟢 GREEN, spike `spike-node-pty`.)** **Answer:** ship `node-pty@^1.1.0` mirroring the existing `better-sqlite3` native-addon pattern — add to `packages/cli/package.json` dependencies + mark `external` in **both** esbuild arrays in `packages/cli/scripts/build.ts` (the `.node` binary loads from node_modules at runtime, never bundled). Confirmed working (PTY spawned on darwin arm64). node-pty 1.1.0 ships macOS/Windows prebuilds and compiles from source on Linux — DorkOS Docker images are Debian-slim (glibc) and already install python3 + build-essential for better-sqlite3, so the Linux compile succeeds; musl/Alpine is not used. **Rationale:** zero new bundling machinery, exact precedent exists, no sidecar/fallback needed, no spec change. **Caveat baked into Chunk E:** assert `spawn-helper` is executable in the packaged artifact (add a spawn-a-shell check to `smoke:docker`). No blocker remains for Chunk E.
- **Q2 — Multi-doc canvas vs. a dedicated workbench document area.** v1 reuses the canvas tab as the multi-doc host. If document tabs + the existing right-panel tab bar feel nested/cramped, a later refactor could promote documents to their own panel region. Default: reuse canvas; revisit after dogfooding. (Non-blocking.)
- **Q3 — Serve route auth mechanism.** Short-lived signed URLs vs. a dedicated sandbox subdomain/origin. Default: signed URLs + opaque-origin sandbox (matches mcp-apps' srcdoc approach without needing a second origin in dev/prod/Electron). Confirm concretely in the Chunk-D ADR. (Non-blocking; ADR-time.)

## Related ADRs

- `260708-111459-two-tier-generative-ui` (MCP Apps = third-party viewer path)
- `0290`–`0293` (canvas markdown/Blintz, edit-protection, editor-owns-document/host-owns-file)
- mcp-apps-host spec + `lib/sandbox.ts` (sandbox posture precedent)
- **New (seeded by this spec):** multi-document canvas model; local-HTML serving + origin isolation; embedded-terminal PTY architecture; first-party mime→viewer registry + config-choosable defaults.

## References

- Ideation: `specs/right-panel-workbench/01-ideation.md` (D1–D11, full research)
- DOR-211 (umbrella), DOR-98 (local HTML/CORS), DOR-212 (diff fast-follow), DOR-213 (DevTools v2)
- Shipped platform: PRs #127–#136; `routes/files.ts`, `transport.ts:466` (`mediaUrl`), `schemas.ts:2126-2191` (canvas union), `mcp-apps/lib/sandbox.ts`
- External: xterm.js, node-pty, CodeMirror 6, `@google/model-viewer`, react-zoom-pan-pinch, papaparse, VS Code Simple Browser + Live Preview (serve+iframe pattern)
