# @anthropic-ai/claude-agent-sdk Changelog: 0.3.168 → 0.3.175

**Generated**: 2026-06-12
**Sources**: GitHub Releases (anthropics/claude-agent-sdk-typescript), npm registry timestamps
**Releases covered**: 6 (0.3.169, 0.3.170, 0.3.172, 0.3.173, 0.3.174, 0.3.175 — 0.3.171 was never published to npm)

## Breaking Changes 🔴

None. Peer dependencies (`zod ^4.0.0`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`) and the native-binary optional-dependency layout are identical between 0.3.168 and 0.3.175.

## Deprecations 🟡

None.

## New Features 🟢

### 0.3.170 — Fable 5 model support (2026-06-09)

- Added `claude-fable-5` model and the `fable` alias to SDK model types
  - **API**: SDK model types / `supportedModels()` now report Fable 5
  - **Use case**: This is the release that makes Fable 5 selectable through the SDK — the reason for this upgrade. Announcement: https://www.anthropic.com/news/claude-fable-5-mythos-5

### 0.3.169 — Experimental usage API + browser SSE (2026-06-08)

- `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` on `Query` returns structured session cost, plan rate-limit, and local usage-behaviors data
  - **API**: `Query.usage_EXPERIMENTAL_...()`
  - **Use case**: future cost dashboards; explicitly unstable, do not adopt yet
- `sse` option (`SSEOptions`) added to `BrowserQueryOptions` as an alternative to `websocket`
  - **Use case**: browser SDK consumers only — DorkOS runs the SDK server-side

### 0.3.172 — Plugin MCP discovery opt-out (2026-06-10)

- `plugins` option entries now accept `skipMcpDiscovery: true`, letting a host that manages a plugin's MCP connections itself load skills/hooks from the plugin path without the engine re-reading its `.mcp.json`
  - **API**: `Options.plugins[].skipMcpDiscovery`
  - **Use case**: hosts that own plugin MCP wiring (DorkOS deliberately does not — see ADR-0239)

### 0.3.174 — Expanded model-fallback notifications (2026-06-11)

- SDK consumers now receive the `system/model_fallback` message for all fallback triggers — `overloaded`, `server_error`, and `last_resort` in addition to `model_not_found` and `permission_denied`; the message's `trigger` field gained `server_error` and `last_resort` values
  - **API**: `SDKMessage` system subtype `model_fallback`
  - **Use case**: surfacing "your session fell back to model X" notices in the chat UI

## Bug Fixes 🔧

- 0.3.172: Slash-followed-by-whitespace input (e.g. `/ add tests`) was silently dropped instead of treated as a plain prompt — now fixed

## Internal ⚪

- 0.3.173, 0.3.175: parity-only releases with Claude Code v2.1.173 / v2.1.175 (no SDK-surface notes)
- 0.3.170 also includes parity with Claude Code v2.1.170
