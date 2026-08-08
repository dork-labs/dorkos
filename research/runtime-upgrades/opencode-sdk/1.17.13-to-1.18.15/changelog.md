# @opencode-ai/sdk Changelog: 1.17.13 → 1.18.15

**Generated**: 2026-08-07
**Sources**: GitHub Releases (sst/opencode, monorepo — filtered for server/Core/SDK relevance), npm registry timestamps (`@opencode-ai/sdk` and `opencode-ai` sidecar), `.d.ts` diff of the packed 1.18.15 tarball against the installed 1.17.13 tree
**Releases covered**: 23 (1.17.14, 1.17.15, 1.17.16, 1.17.17, 1.17.18, 1.17.19, 1.17.20, 1.18.0, 1.18.1, 1.18.2, 1.18.3, 1.18.4, 1.18.5, 1.18.6, 1.18.7, 1.18.8, 1.18.9, 1.18.10, 1.18.11, 1.18.12, 1.18.13, 1.18.14, 1.18.15)
**Dist-tags**: only `latest` (→ 1.18.15) considered; the dozens of `0.0.0-snapshot-*` / `0.0.0-v1-*` / `0.0.0-windows-*` etc. tags on this package are noise, per `runtime-deps.json` guidance.

This is a monorepo release train covering Core (the `opencode serve` server/CLI — what DorkOS's client actually talks to), TUI, and the Desktop app. Desktop and TUI made up the large majority of the ~130 changelog bullets in this range; they are summarized, not itemized, below. Core/server bullets are itemized in full because that is DorkOS's actual dependency surface (`upgrade_notes`: "server-driven contract... release notes can matter more than client type changes").

## Type-level findings (`.d.ts` diff)

The packed 1.18.15 tarball's `dist/` was diffed file-by-file against the installed 1.17.13 tree (`node_modules/.pnpm/@opencode-ai+sdk@1.17.13`). Every file DorkOS's import graph can reach — `index.d.ts`, `client.d.ts`, `server.d.ts`, `process.d.ts`, `error-interceptor.d.ts`, `gen/types.gen.d.ts`, `gen/sdk.gen.d.ts`, `gen/client.gen.d.ts` — is **byte-for-byte identical** between the two versions. Zero exported symbols added, removed, or reshaped on the surface DorkOS's `apps/server/src/services/runtimes/opencode/*.ts` files import from (confirmed against every name in every `import type { ... } from '@opencode-ai/sdk'` in the directory — see Phase 3 report for the full list).

The only `.d.ts` file that changed at all is `dist/v2/gen/types.gen.d.ts` (a separate `@opencode-ai/sdk/v2` export subpath): a `subagent_depth?: number` field was added to the config type, and the `interleaved` reasoning-field union widened (`"reasoning_details"` renamed to `"reasoning_text"`, plus a `string` catch-all and a `boolean` shorthand). **DorkOS does not import from `@opencode-ai/sdk/v2` anywhere** — grep confirms no `@opencode-ai/sdk/v2`, `/client`, or `/server` subpath import exists in `apps/server/src`. These changes are irrelevant to this upgrade.

The Desktop-app release notes repeatedly reference a parallel "legacy" vs. "current"/"v2" **server** distinction ("Detect legacy and current servers so the desktop app can work with both", "Keep current servers out of the legacy layout", v1.18.5–v1.18.12) — that is the opencode project's own internal migration of its Desktop client onto a newer server protocol generation, tracked separately from the `v2` SDK export subpath. It does not change the REST/SSE contract the top-level `@opencode-ai/sdk` export (what DorkOS uses) speaks, confirmed by the empty diff above.

## Breaking Changes 🔴

None. No exported type, function signature, or removed API on DorkOS's actual import surface (top-level `@opencode-ai/sdk` export). No Core release note in this range describes a subtractive/incompatible behavior change to the REST API or event stream DorkOS depends on.

## Deprecations 🟡

None formally announced. Worth a watch-item, not a deprecation: the Desktop app's "legacy vs. current server" language (see above) suggests the project is migrating its own client onto a new server generation over time. Nothing in this window deprecates the surface DorkOS's SDK-level client uses, but a future release could start doing so — re-check this section on the next bump.

## New Features 🟢

### 1.17.14 — Code mode MCP adapter (2026-07-06)

- Added a code-mode MCP adapter for running confined orchestration scripts against connected MCP tools, gated behind hiding the `execute` tool unless code mode is enabled.
  - **Relevance**: low. DorkOS's `OpenCodeMcpManager` (`mcp-manager.ts`) only injects/reads MCP server registrations (`client.mcp.add`, status); it does not touch tool-execution modes. No action needed, but worth knowing this capability exists if a future DorkOS feature wants MCP-tool scripting.

### 1.18.2 — Subagent nesting default + `subagent_depth` (2026-07-15)

- Subagents no longer launch nested subagents by default; a configurable `subagent_depth` limit is available when nesting is wanted.
  - **Relevance**: low. `opencode-runtime.ts:814` documents that "OpenCode agents are prompt-scoped, not a DorkOS-dispatchable subagent registry" — DorkOS does not orchestrate or configure OpenCode's subagent nesting today. This is a sidecar-side default-behavior change a DorkOS OpenCode session's own prompts could trigger, but nothing in DorkOS's code path is affected.

### 1.18.10 — Modal provider auto-discovery (2026-07-30)

- Modal models are now discovered automatically.
  - **Relevance**: none for DorkOS code — provider catalogs flow through unchanged, already-typed `ProviderListResponse`; a new provider just shows up in the projected model list (`models.ts`) with no code change.

### 1.18.14 — Simplified xAI login (2026-08-05)

- xAI login is now a single device-code flow.
  - **Relevance**: none — provider-side auth UX, not something DorkOS's `check-dependencies.ts` / credential flow touches (OpenCode's own CLI-auth path, not a DorkOS-connected provider).

### 1.18.15 — Export session transcripts as JSON (2026-08-07)

- Desktop UI gained "export full session transcripts as JSON."
  - **Relevance**: none — Desktop-app-only, not exposed through the server API DorkOS's SDK client uses.

## Bug Fixes 🔧

Grouped by the DorkOS subsystem they touch, not strictly by version — all are Core (server-side) fixes; itemized because they affect behavior of code DorkOS already wraps even though none required a code change (server-side-only, no type/contract change).

**MCP reliability** (touches `mcp-manager.ts`, `mcp-status.ts` — DorkOS's managed MCP injection and status surfacing):

- 1.17.14: Fixed paginated MCP tool catalogs losing tool metadata and output-schema validation.
- 1.18.8: Reconnects MCP servers after expired SDK sessions, including concurrent requests; honors configured MCP OAuth callback ports in `mcp debug`.
- 1.18.9: Restored compatibility with legacy MCP SDK clients (a fix for a regression introduced earlier in the 1.18.x line — both the break and the fix land inside this upgrade window, so net effect across 1.17.13→1.18.15 is neutral-to-positive).
- 1.18.11: Stopped MCP SSE connections from getting stuck in reconnect loops after server error responses.

**Session/directory routing** (touches the single-sidecar, per-request-directory model ADR-0308 decided on):

- 1.17.14: Fixed session lists to match equivalent instance directories reliably.
- 1.18.6: Fixed branch-specific repository caches so refreshing one reference no longer moves another branch checkout.

**Message/history ordering** (touches what `session-mapper.ts` / `log-backed-history.ts` read):

- 1.18.15: Chronological message ordering now stays correct even when imported or legacy message IDs are out of order; revert and fork actions now use real message chronology instead of message-ID ordering; repeated compaction now keeps earlier tool-call history in summaries instead of dropping orphaned results; blob-based attachments now load correctly in the web UI.

**Provider/model routing** (no DorkOS code path, listed for completeness):

- 1.17.14: OpenRouter small-model reasoning-effort preservation; GitHub Copilot model routing; Cerebras reasoning replay.
- 1.17.15: Z.ai context-overflow error classification; graceful handling of unavailable config directories.
- 1.17.16: Grok reasoning-effort variants; xAI prompt-cache routing + PDF support.
- 1.17.17: Meta model reasoning-variant handling.
- 1.17.18: GitHub Copilot crash fix for zero billing-batch-size models.
- 1.17.19: OpenAI pro reasoning mode; xAI Responses store-default; Luna Responses Lite OAuth; Codex context limits for GPT-5.6.
- 1.17.20: Removed obsolete Codex workaround; Azure GPT-5.6 support.
- 1.18.2: Meta model default reasoning depth.
- 1.18.4: Kimi adaptive thinking; OpenAI header timeouts; provider-defined reasoning options; Azure Cognitive Services endpoint restore.
- 1.18.5: Claude adaptive-thinking handling; OpenAI Responses phase-handling fix; grep symlink-path preservation; Mistral reasoning-history/prompt-caching stability; per-SDK prompt-cache keys; MiniMax M3 thinking-variant fix.
- 1.18.12: Azure GPT-5.5+ completion fix (reasoning enabled).
- 1.18.14: Preserved structured mid-stream provider errors for retry; retried more transient provider/network errors; ACP remote-workspace fixes (not applicable — DorkOS's sidecar is always local, never a remote ACP workspace).

## Performance ⚡

Nothing Core/server-side in this range. Desktop-only items (markdown parsing off the main thread, Home cold-load reduction) don't apply to DorkOS's server-side client.

## Internal ⚪

- 1.18.0 (the minor-version bump) and 1.18.1 shipped **zero Core-section notes** — the entire minor bump was Desktop v2 layout migration. Worth flagging explicitly since minor bumps are usually where a project spends its intentional-break budget; this one didn't touch Core.
- 1.18.3, 1.18.7, 1.18.13: Desktop/TUI-only releases, no Core notes.
- The majority of every release's bullet volume was Desktop (tab management, review panel, terminal, localization/RTL support) and TUI (spinner registration, debug dialogs, clipboard-over-SSH) — none of it reachable from DorkOS's server-side SDK usage.

## Sidecar (`opencode-ai`) version timeline

`opencode-ai` (the separate npm package that ships the `opencode serve` binary) publishes in lockstep with `@opencode-ai/sdk`: every SDK version in this range has a matching `opencode-ai` version published within about a minute of it (e.g. `opencode-ai@1.18.15` at `2026-08-07T06:51:43Z`, `@opencode-ai/sdk@1.18.15` at `2026-08-07T06:55:47Z`). This confirms the monorepo releases both packages together per version — see the impact assessment for what this means for DorkOS's pinned-provisioning and PATH-resolved binary paths.
