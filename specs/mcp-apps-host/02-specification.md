# MCP Apps Host Support — Specification (v1)

**Date:** 2026-07-08 · Decisions in `01-ideation.md` (D1–D6). Investigation evidence below was gathered against main + `feat/gen-ui-widgets` on 2026-07-08.

## 0. Gate: the `_meta` survival spike — RESOLVED 2026-07-08 (fallback path taken)

Build a minimal fixture MCP server whose tool result carries `_meta.ui.resourceUri` (and the deprecated flat `_meta["ui/resourceUri"]`) plus a trivial `ui://` HTML resource. Run it through a real claude-code SDK session and inspect the raw `tool_result` block in the SDK `user` message (`message-event-mapper.ts` receives it at the path documented at its line ~116 comment). Outcomes:

- `_meta` present → proceed per this spec.
- `_meta` stripped by the SDK → amend the trigger: detect `ui://` **embedded resource blocks** in tool-result content (and/or `resource_link` blocks) instead of `_meta`; update §2 accordingly and record the finding in the PR + this spec before continuing.

### Empirical outcome (spike ran 2026-07-08, Claude Agent SDK 0.3.177)

**`_meta` is STRIPPED, and so is _all_ structured tool-result content.** The fixture
(`apps/server/src/services/mcp-apps/__tests__/fixtures/fixture-mcp-app-server.mjs`) was run
through a real `query()` session with `bypassPermissions`. The `tool_result` block DorkOS
receives in the `user` message contains **only** `type`, `tool_use_id`, and `content`, where
`content` is `text`-only:

- Top-level `_meta` (nested `ui` **and** flat `ui/resourceUri`) → **gone**.
- Per-content-block `_meta` → **gone**.
- A structured **EmbeddedResource** block (`{ type: 'resource', resource: { uri: 'ui://…', text } }`)
  → **flattened to a `text` block**: `"[Resource from <server> at <ui://uri>] <full HTML>"`.
- A **resource_link** block (`{ type: 'resource_link', uri: 'ui://…' }`)
  → **flattened to a `text` block**: `"[Resource link: <name>] <ui://uri>"`.

The SDK serializes every MCP tool-result content shape to plain text for the model; there is no
option (`includePartialMessages`, output schemas, etc.) that preserves structured tool output or
`_meta`. **The only survivor is the `ui://` URI, embedded in serialized text.**

**Fallback taken:** the mapper detects an MCP-App by scanning tool-result **text** for a `ui://`
URI (matching the SDK's `[Resource …]` serialization markers, then any bare `ui://`). The
populated `ui.resourceUri` still drives the **server-side short-lived MCP client fetch** (ADR
`260708-141143`), which re-reads the resource _as structured data_ — recovering the correct
`mimeType`, CSP, and permissions that the text serialization discards. The server-side fetch is
therefore not just still valid but load-bearing: the flattened text is an unreliable carrier for
the HTML (prefix-wrapped, potentially truncated) and carries none of the sandbox metadata. See
§2.2 for the concrete trigger.

## 1. Findings of record (file:line)

- `ToolCallEventSchema` (`packages/shared/src/schemas.ts:359-367`) has no `_meta`; `tool_result` SessionEvent reuses its shape (`session-stream.ts:213`).
- claude-code mapper drops `_meta`: `message-event-mapper.ts:128-146` (`extractToolResultText` filters `type === 'text'` only). codex: `codex/event-mapper.ts:347,385,476`. opencode: `opencode/event-mapper.ts:410-411,426-427`.
- SDK `Query` surface (`sdk.d.ts:2240-2345`) has **no resource read**; `mcpServerStatus()` (`sdk.d.ts:2333`) returns per-server `config` (`McpStdioServerConfig`/`McpHttpServerConfig`/SSE, `sdk.d.ts:1058-1101`). DorkOS already calls it (`message-sender.ts:459-481`) but discards `config` when mapping to `McpServerEntry` (`transport.ts:123-139`).
- Approval pipeline is agent-tool-only: `createCanUseTool` (`interactive-handlers.ts:328-362`) → `handleToolApproval` (371-417), pendingInteraction keyed by SDK toolUseID; approve routes at `sessions.ts:479-609`. No client-origin entry point.
- Canvas iframe precedent: `CanvasUrlContent.tsx:1-69` (sandbox token allowlist; too permissive for app HTML — has `allow-same-origin`).
- Electron hardened: `window-manager.ts:54-58` (`contextIsolation`, `nodeIntegration:false`, `sandbox:true`).
- `@modelcontextprotocol/sdk@1.29.0` already in `apps/server/package.json:35`; no existing server-side MCP Client usage.

## 2. Architecture

### 2.1 Resource fetch (server)

New domain `apps/server/src/services/mcp-apps/`:

- `resolveAppResource(sessionId, serverName, uri)`: runtime capability `getMcpServerConfig(sessionId, serverName)` (claude-code: config captured from `mcpServerStatus()` into a **server-only** cache — do NOT put stdio command/env on the shared `McpServerEntry` type) → open short-lived SDK `Client` (`StdioClientTransport` | `StreamableHTTPClientTransport`) → `resources/read` → close. Enforce: `ui://` scheme, `text/html;profile=mcp-app` mimetype, `serverName` ∈ the requesting session's MCP set. Cache `{mimeType, text|blob, csp, permissions}` by `(serverName, uri)` with short TTL. Connection pooling per `(session,server)` with idle TTL is acceptable if stdio-spawn cost warrants; keep it simple first.
- Route: `POST /api/sessions/:id/mcp-app/resource` `{serverName, uri}` → `McpAppResourceResponse`. Thin, Zod-validated.

### 2.2 `ui` propagation — text-parse trigger (revised per §0 spike)

- `McpAppRefSchema = { resourceUri: string (ui://), preferredDisplayMode?: 'inline'|'fullscreen'|'pip' }` in shared.
- Optional `ui: McpAppRefSchema` on `ToolCallEventSchema`, `ToolCallPartSchema`; `tool_result` SessionEvent inherits via shape (add projector test).
- **Trigger (fallback, because `_meta` and structured resource blocks are stripped — §0):**
  `message-event-mapper.ts` scans the tool-result **text** for a `ui://` URI. A file-local
  `extractUiResourceUri(text)` helper matches the SDK's serialization markers first
  (`[Resource from <server> at <ui://…>]`, `[Resource link: …] <ui://…>`) then any bare
  `ui://…` token, and populates `ui: { resourceUri }` on the emitted `tool_result` event. The URI
  drives the server-side fetch (§2.1); the flattened HTML text is **not** trusted as the render
  source. `preferredDisplayMode` is unknown from text (it lived in the stripped `_meta`), so it is
  left undefined and defaults to `inline` at render.
- codex/opencode: explicitly leave `ui` undefined + regression test. (Their mappers are untouched;
  the field is optional so it is simply absent.)

### 2.3 Client bridge + rendering

New FSD feature `apps/client/src/layers/features/mcp-apps/`:

- `<McpAppFrame>`: sandboxed iframe, HTML pre-fetched via the resource endpoint. Prefer mcp-ui's low-level AppFrame if it accepts pre-fetched HTML + custom transport; else hand-roll (D3).
- Bridge (postMessage JSON-RPC): `ui/initialize` handshake advertising `availableDisplayModes: ["inline","fullscreen"]` + host context; `resources/read` proxied to the endpoint; `ui/notifications/tool-input|tool-result|host-context-changed` pushed in; `ui/open-link` → `LinkSafetyModal`; `ui/request-display-mode: fullscreen` → open canvas; `tools/call` → JSON-RPC error "not permitted in v1"; unknown methods → method-not-found. Origin + source-window checks on every inbound message.
- Surfaces: chat renders an app block on `tool_call` parts carrying `ui` (collapsed-by-default affordance is acceptable); canvas variant `{ type: 'mcp_app', serverName, uri, title? }` on `UiCanvasContentSchema` (+ `UiStateSchema.canvas.contentType`).
- **Render consent**: first app from a given server asks (LinkSafetyModal pattern, "Interactive app provided by {serverName}"); remembered per server (localStorage).

### 2.4 Sandbox/security (D6)

- `sandbox="allow-scripts"` — never `allow-same-origin`. `allow` attribute strictly from `_meta.ui.permissions` (camera/microphone/geolocation/clipboardWrite), default none.
- CSP: `_meta.ui.csp` when present, else spec default `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`. Never allow undeclared domains.
- Dedicated sandbox origin (open question #1): resolve concretely during implementation for vite dev + prod static + Electron; document the choice. srcdoc/blob with strict CSP + no-same-origin sandbox is an acceptable v1 if a true separate origin is disproportionate — justify in the PR.

## 3. Out of scope for v1

App-initiated `tools/call` execution, `pip`, `ui/update-model-context` → agent, codex/opencode support, server-side app state, DorkOS `ui://` resources on `/mcp`. v2/v3 staging in `01-ideation.md`.

## 4. Test strategy

- Mapper `_meta` survival tests (claude-code carries; codex/opencode undefined).
- Shared schema round-trips (`McpAppRefSchema`, canvas variant, DTOs).
- `mcp-apps` service against an in-memory/fixture MCP server: read/close/cache, `ui://`-scheme rejection, cross-session server rejection.
- Route tests (200 / 404 unknown server / 400 bad uri) per `sessions.test.ts` patterns.
- Bridge unit tests: handshake, read proxy, tools/call-not-permitted, unknown-method, origin rejection.
- Iframe attribute/CSP assertions (no `allow-same-origin`; `allow` from permissions).
- Browser test: fixture server + trivial app → inline render, fullscreen-to-canvas, open-link gate.

## 5. Acceptance criteria (v1)

1. A claude-code session using a fixture MCP-Apps server renders the app inline after tool completion (browser-verified) behind first-use consent.
2. `ui/request-display-mode: fullscreen` moves the app to the canvas; `control_ui`-opened `mcp_app` canvas content works.
3. `tools/call` from the app returns a spec-compliant error; `ui/open-link` goes through LinkSafetyModal.
4. Sandbox posture verified by tests (§2.4); resource endpoint rejects non-`ui://`, foreign servers, and sessions without the server.
5. codex/opencode sessions are unaffected (no `ui` field, no renderer activation).
6. Targeted typecheck/lint/tests green; changelog fragment; TSDoc.
