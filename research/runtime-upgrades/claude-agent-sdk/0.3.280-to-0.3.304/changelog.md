# @anthropic-ai/claude-agent-sdk Changelog: 0.3.280 → 0.3.304

**Generated**: 2026-10-20
**From**: 0.3.280 (published 2026-09-22), the pin at all seven sites, verified consistent on `origin/main` (`c31970db88`)
**To**: 0.3.304 (`latest`, published 2026-10-19T19:48Z; `next` points at the same version, so there is no pre-release channel ahead of it)
**Versions in range**: 22 published releases. **0.3.297 and 0.3.298 were never published to npm**, though upstream `CHANGELOG.md` carries parity-only blocks for both.
**Sources**: npm registry `time` field; GitHub releases API; upstream `CHANGELOG.md` (cross-checked, same bullets); `sdk.d.ts` / `sdk-tools.d.ts` / `package.json` diff of both tarballs; `sdk.mjs` string reads at 0.3.280, 0.3.281–0.3.300 (bisect) and 0.3.304; `strings` of the `claude-agent-sdk-darwin-arm64` binary at 0.3.280 and 0.3.304; the Claude Code `CHANGELOG.md` for the parity releases 2.1.281–2.1.304; an in-process `tools/list` repro (no CLI, no model) at 0.3.280 and 0.3.304 with zod 4.6.5
**Companion**: [`impact-assessment.md`](./impact-assessment.md)

| Version | Published (UTC)  | Notes                                                                  |
| ------- | ---------------- | ---------------------------------------------------------------------- |
| 0.3.281 | 2026-09-23 17:02 | 9 items (sdk.mjs slimmed, `Settings.attribution` widened)              |
| 0.3.282 | 2026-09-24 15:53 | 5 items (`/core` entry, `prewarm()` alpha)                             |
| 0.3.283 | 2026-09-25 18:49 | 4 items (`plugin_errors` typed, informational messages emitted)        |
| 0.3.284 | 2026-09-28 17:15 | 9 items; **CLI 2.1.284 adds Sonnet 5.5 and retargets `sonnet`**        |
| 0.3.285 | 2026-09-29 17:35 | 9 items; **bundled zod 4.4.3 → 4.5.4 (silent; see #454)**              |
| 0.3.286 | 2026-09-30 17:17 | 6 items (unconvertible tool schema now drops one tool, not the server) |
| 0.3.287 | 2026-10-01 17:03 | 8 items                                                                |
| 0.3.288 | 2026-10-02 18:33 | parity only                                                            |
| 0.3.289 | 2026-10-03 20:12 | parity only                                                            |
| 0.3.290 | 2026-10-05 18:15 | 6 items                                                                |
| 0.3.291 | 2026-10-06 03:33 | parity only                                                            |
| 0.3.292 | 2026-10-06 17:14 | 9 items (subagent `agent_id`, task `run_id`/`parent_task_id`)          |
| 0.3.293 | 2026-10-07 17:21 | 1 item                                                                 |
| 0.3.294 | 2026-10-08 16:36 | parity only; **CLI 2.1.294 adds Haiku 5.5 and retargets `haiku`**      |
| 0.3.295 | 2026-10-08 18:22 | 14 items (many `tool_use_result` caps, `--flag=value` argv)            |
| 0.3.296 | 2026-10-09 16:59 | 5 items (`claude_code_version` on initialize)                          |
| 0.3.299 | 2026-10-14 00:23 | 7 items                                                                |
| 0.3.300 | 2026-10-14 14:28 | 7 items; bundled zod → 4.6.2; CLI starts writing `api-request*` rows   |
| 0.3.301 | 2026-10-15 14:35 | 6 items (per-tool MCP permission policy, `BUILTIN_TOOL_NAMES`)         |
| 0.3.302 | 2026-10-16 16:47 | 3 items (default `permissionMode`, fork subagents on)                  |
| 0.3.303 | 2026-10-18 21:15 | parity only                                                            |
| 0.3.304 | 2026-10-19 19:48 | 4 items                                                                |

Six releases carry nothing but "Updated to parity with Claude Code v2.1.NNN". Every release moves the bundled CLI binary, which is where the model catalog and most non-import couplings live, so parity releases were read through the Claude Code changelog rather than skipped.

## Summary of counts

| Category                    | Count |
| --------------------------- | ----- |
| Breaking 🔴 (type/contract) | 1     |
| Breaking 🔴 (behavioral)    | 9     |
| Deprecated 🟡               | 0     |
| Feature 🟢                  | 27    |
| Fix 🔧                      | 30    |
| Performance ⚡              | 5     |
| Internal ⚪                 | 6     |

**Type-surface shape**: `sdk.d.ts` grew 9551 → 10179 lines. Public exports: **5 added, 0 removed** (`BUILTIN_TOOL_NAMES`, `LEGACY_TOOL_NAME_ALIASES`, `prewarm`, `SpareProcess`, `ClaimOptions`); two non-exported declarations added (`SDKControlGetTaskOutputRequest`, `SDKControlGetTaskOutputResponse`). The **`SDKMessage` union is unchanged** (same 39 members). `Options` gained no fields (docblock changes only). `Query.reloadPlugins()` gained `addPlugins?`. `@deprecated` tags unchanged. `sdk-tools.d.ts` grew 4153 → 4222 lines, **2 exports added** (`OfferChromeSetupInput`, `OfferChromeSetupOutput`), 0 removed, all other changes additive optional fields.

**Packaging**: new `./core` subpath export (`core.mjs`, `core.d.ts`, plus two chunk files `core-*.mjs`); `sdk.mjs` stays self-contained (it imports neither chunk). Same 8 platform optional dependencies, all version-locked and all published at 0.3.304. Same `peerDependencies` (`@anthropic-ai/sdk` 0.123.0, `@modelcontextprotocol/sdk` 1.31.0, `zod` ^4.0.0), `engines` and `dependencies`. `claudeCodeVersion` 2.1.280 → 2.1.304. The darwin-arm64 binary grew **217 MB → 271 MB** (+25%).

---

## Breaking Changes 🔴 — type and contract

### 0.3.281 — `Settings.attribution` widened to `boolean | {...}`

- TypeScript that reads `attribution.commit` off returned settings needs a narrow.
  - **Affected API**: `Settings.attribution` (as returned by `getSettings()` / `applied`)
  - **Migration**: none for DorkOS (no read of `attribution` anywhere in the runtime).

Also widened, compile-safe for a consumer that does not switch on them exhaustively: `NonNullableUsage` now leaves `fallback_credit` nullable; `SDKControlGetUsageResponse` insight `key` gained `'max_effort' | 'workflow' | 'always_on_context' | 'large_tool_results'`; `SDKStartupFailureReason` gained `'provider_not_allowed' | 'org_config_required_unavailable' | 'org_config_refused'`; `SDKMessageOrigin.subkind` gained `'session-inbox'`.

## Breaking Changes 🔴 — behavioral (no compiler catches these)

### 0.3.284 (CLI 2.1.284) — the `sonnet` alias now means Claude Sonnet 5.5

- Catalog adds `claude-sonnet-5-5` ("Sonnet 5.5", June 2026 cutoff, 1M context, 128k default output, `default_effort: "medium"`, capability `rejects_disabled_thinking`) and points `aliases.sonnet.default` (first-party) at it. `latest_per_family.sonnet` moves with it. Per-provider targets (Bedrock/Vertex/Foundry/Mantle `claude-sonnet-4-5`, anthropic_aws/gateway `claude-sonnet-4-6`) are unchanged.
- Price per the binary: `tier_2_10_cache_read_0_10` ($2/$10, cache read $0.10) vs Sonnet 5's `tier_2_10` (cache read $0.20). CLI 2.1.295 corrected the cache-read price from $0.20 to $0.10.
- Default effort drops from `high` (Sonnet 5) to `medium` (Sonnet 5.5) for sessions that do not set one.

### 0.3.294 (CLI 2.1.293/2.1.294) — the `haiku` alias now means Claude Haiku 5.5

- Catalog adds `claude-haiku-5-5` ("Haiku 5.5", June 2026 cutoff, 1M context vs 200k, 128k default output, `rejects_disabled_thinking`, `fallback_3p: claude-haiku-4-5`) and points `aliases.haiku.default` at it. New `per_provider` block keeps every third-party provider on `claude-haiku-4-5`.
- Price `haiku_55`: $0.10/$0.50 per Mtok under 100k prompt tokens, $0.50/$2.50 above (Haiku 4.5: $1/$5). Claude Code 2.1.294: "Added Claude Haiku 5.5 (`claude-haiku-5-5`), now the default Haiku model on the Anthropic API".

`opus` (→ `claude-opus-5-5`) and `fable` (→ `claude-fable-5-1`) are unchanged; `best` is still `fable`; `defaults` and `alias_migration` are still `{}`.

### 0.3.286 → 0.3.302 — an omitted `permissionMode` changed twice

- 0.3.286: omitted `permissionMode` is left to Claude Code (settings `defaultMode`, else auto mode on third-party providers or with telemetry off). 0.3.302: on third-party providers, telemetry off, or a fresh install, it starts in `default` again. Net at 0.3.304: an omitted mode follows `permissions.defaultMode` from loaded settings, else auto where auto is the default.
  - **Affected API**: `Options.permissionMode` when omitted

### 0.3.300 — `thinking: { type: 'disabled' }` runs as adaptive thinking on models that cannot turn thinking off

- Both 5.5 Sonnet and Haiku carry `rejects_disabled_thinking`, so "thinking off" silently becomes adaptive thinking there.
  - **Affected API**: `Options.thinking`, `maxThinkingTokens: 0`

### 0.3.300 — `updatedInput` from PreToolUse and PermissionRequest hooks is validated; unknown keys dropped, rejected input denies the call

- `canUseTool`'s `updatedInput` is unchanged.

### 0.3.302 — fork subagents (`subagent_type: "fork"`) on by default in SDK sessions

- A fork inherits the parent conversation, so it costs more context than a fresh subagent. `CLAUDE_CODE_FORK_SUBAGENT=0` turns them off.

### 0.3.286 — a priority `now` message backgrounds running work and joins the turn instead of stopping it

### 0.3.295 — the SDK passes named option values as `--flag=value` (one argv entry), not `--flag value`

- Matters only to a host that inspects argv in `spawnClaudeCodeProcess`.

### CLI 2.1.300 (SDK 0.3.300) — transcripts now record each API request's system prompt, tools and parameters

- Three new JSONL row types: `api-request`, `api-request-shape`, `api-request-blob`. Observed on this machine in two real transcripts written by an interactive 2.1.300 CLI: one burst of ~650 KB (one `api-request-shape` row of 105–111 KB, up to 231 `api-request-blob` rows of up to 107 KB each, one `api-request` row) written mid-file at the first request after the version change. No env switch to turn it off was found in the binary (the new `CLAUDE_CODE_*` names are `CLAUDE_CODE_TRANSCRIPT_SLIM_TOOL_RESULTS`, `CLAUDE_CODE_GZIP_REQUEST_BODY_BLOCKS`, `CLAUDE_CODE_GZIP_REQUEST_BODY_LEVEL`).

## New Features 🟢

### 0.3.281

- `conversation_reset` gains `trigger` (`clear` | `plan_mode_exit` | `fresh_session` | `onboarding`), `user_message_uuid`, `timestamp`.

### 0.3.282

- `@anthropic-ai/claude-agent-sdk/core`: smaller entry (query, MCP tool helpers, session mutations, `resolveSettings`) that **uses your installed zod and MCP SDK** — the fix the #454 thread asked for.
- `prewarm()` + `SpareProcess.claim()` (`@alpha`): start a CLI process before the session is known (tools, plugins, host MCP handshakes done ahead), bind folder/model/permissionMode later. Parked process holds ~230–260 MB.
- `strictKnownMarketplaces` / `blockedMarketplaces` in host `managedSettings`.

### 0.3.283

- `plugin_errors[]` typed on `system/init` (with `path` for a `--plugin-dir` entry that did not load).

### 0.3.284

- `applied.ultracodeAvailable` / `applied.ultracodeRequested` on `getSettings()`; renamed-skill aliases on `SlashCommand`.

### 0.3.285

- `provider_not_allowed` startup reason, `Settings.allowedProviders`; `Artifact` read result `title`.

### 0.3.286

- Initialize field `sdk_mcp_manifests_parked`, init capabilities `sdk_mcp_manifests`, `sdk_mcp_tools_list_changed`.

### 0.3.287

- Success-result latency fields `first_text_post_queue_wait_ms`, `first_text_post_queued_behind`.

### 0.3.290

- WebFetch `offset` for long pages.

### 0.3.292

- `agent_id` on subagent `assistant`/`user` messages (equals the subagent's `task_id`, stable across resume).
- `parent_task_id` on `task_started` and `background_tasks_changed`; `run_id` on task events and `origin.runId` on task notifications.
- Typed `ListAgents` result sections, `recipient_kind` on SendMessage, `read_at`/`arrived_at` on ReadNotifications.

### 0.3.293

- `subagent_type` on `background_tasks_changed` entries.

### 0.3.295

- `overageEnabled` on `SDKRateLimitInfo`.

### 0.3.296

- `claude_code_version` on the `initialize` control response.
- `AgentDefinition.autoCompactWindow`.

### 0.3.299

- `nextFireAt` on CronCreate/CronList outputs; `property_order` on elicitation requests.

### 0.3.301

- Per-tool permission policy on sdk-type MCP server configs: `McpSdkServerConfig.tools: McpServerToolPolicy[]` with `always_ask` / `always_deny`.
- `BUILTIN_TOOL_NAMES`, `LEGACY_TOOL_NAME_ALIASES` exports.
- `Query.reloadPlugins({ addPlugins })` loads more plugin folders into a running session.

### 0.3.304

- Stable row `id`s on `getContextUsage()` categories; plugin ids, agent/skill file paths and per-server MCP-instruction token shares (`mcpInstructions`) when the CLI answers on its own stdio.
- Browser SDK `suspendSseStream` / `resumeSseStream`.

### Model catalog (binary)

- Claude Sonnet 5.5 (`claude-sonnet-5-5`, CLI 2.1.284) and Claude Haiku 5.5 (`claude-haiku-5-5`, CLI 2.1.294) — see Breaking.

## Bug Fixes 🔧

- 0.3.281: permission/dialog callbacks no longer fire after `close()`; control requests after close no longer hang or leak; `session_state_changed` no longer sticks at `requires_action` after overlapping prompts.
- 0.3.282: `readMcpResource()` drops `com.anthropic/` `_meta` keys.
- 0.3.283: `getSessionMessages()` / `forkSession()` no longer return a rewound-away branch.
- 0.3.284: **`query()` no longer closes stdin before a follow-up turn woken by a finished background agent** (that turn's hooks, `canUseTool` and SDK MCP calls failed with "Stream closed"); `forkSession()` copies read back the right history after rewind/compaction; `getSessionMessages()` includes messages from other agents/sessions/channels; Elicitation hook `{ decision: 'block' }` honoured.
- 0.3.285: `toggleMcpServer(name, false)` closes a not-yet-connected server; `getSessionMessages()` keeps a message sent while working; Bash/PowerShell `timeout` now bounds a `run_in_background` command (default 30 min, max 2 h).
- **0.3.285 (no release note): the bundled zod moved 4.4.3 → 4.5.4**, whose JSON Schema context carries `deferred` and `intersections`; with it, `z.record`, `z.json` and `z.intersection` tool schemas convert again with app zod 4.6.5. 0.3.300 (or earlier, between 0.3.296 and 0.3.300) moved it again to 4.6.2.
- 0.3.286: **an SDK MCP server no longer lists zero tools when one tool's schema cannot be converted**; that tool is left out with a warning (`CLAUDE_SDK_MCP_TOOL_SCHEMA_UNCONVERTIBLE` via `process.emitWarning`). `toggleMcpServer()` now disconnects/re-enables `createSdkMcpServer()` servers; foreground subagents get the task-tracking tools listed in `tools`/`allowedTools`.
- 0.3.287: `includePartialMessages` cut-short replies send `message_stop`; revoked-OAuth error text; tool call to a toggled-off in-process MCP server no longer hangs; `commands_changed` no longer before `init` or twice.
- 0.3.290: deny/ask rules match `toolAliases` with wildcards; same-uuid resend replay timing; `message_stop` always sent when a stream is cut.
- 0.3.292: subagents with a declared auto mode use `canUseTool` when auto mode is unavailable.
- 0.3.295: stale tool list after `mcp_set_servers`; streamed text loses `citations`; `allowed_warning` rate-limit events carry overage fields.
- 0.3.296: `sandbox` option merges with an inline `settings.sandbox` block.
- 0.3.299: rewind of a message stopped during prompt hooks; in-process servers named `constructor`/`toString`; queued content-block messages merged without a line break; `origin.body` on merged peer messages.
- 0.3.300: `importSessionToStore` skipping rows with U+2028/U+2029; background subagent final report runs as its own turn; `rewind_conversation` with `interrupt_if_running`.
- 0.3.301: **`setModel()` with a model id no longer fails at the five-hour or weekly limit**.
- 0.3.302: structured output on an API refusal is now an error with no payload.
- 0.3.304: `startup()` no longer times out during a long SessionStart/Setup hook; keeps only the newest `hook_progress` per hook.
- CLI (parity) highlights: resumed SDK sessions keep compaction-kept messages and summaries (2.1.300); MCP tool calls no longer fail or run twice on a background reconnect (2.1.299); remote MCP servers reconnect after a >15 s outage with backoff (2.1.295); a regression where a headless session could run an approved tool call twice on resume after restart (introduced 2.1.296, fixed 2.1.299); one-shot runs no longer stop a background command 5 s after the result (2.1.292); "model switches, messages and interrupts waiting behind a context usage check in SDK sessions" (2.1.304).

## Performance ⚡

- 0.3.281: `sdk.mjs` no longer bundles unused dependencies (1.47 MB → 0.97 MB; measured 1.59 MB → 1.30 MB on disk incl. new code); in-process MCP handshake runs inside the SDK (`initialize` may wait up to 250 ms for it); the CLI answers initialize before its background start-up work.
- 0.3.300: browser SDK bundle 40% smaller.
- CLI 2.1.299: first turn no longer waits for HTTP/SSE MCP servers' `resources/list`.
- CLI 2.1.304: resume of large compacted SDK sessions sends its first request sooner.

## Internal ⚪

- 0.3.288, 0.3.289, 0.3.291, 0.3.294, 0.3.303: parity only (0.3.294's parity carries Haiku 5.5).
- 0.3.295: MCP `tool_use_result` caps (`structuredContent` 1,048,576 / 8,388,608 JSON chars for MCP Apps; text past 500,000 dropped when saved to file); `pasted_content` over 1,000 entries ignored; `updatedPermissions` over 4,096 entries count as a denial.
- 0.3.296: up-front MCP tool description and server-instruction cap 2,048 → 4,096 chars (16,384 via tool search, 0.3.295).
- 0.3.299: reserved MCP server names (`__proto__` etc.) refused.
- 0.3.301: full-disk login refresh error becomes `invalid_request` with `api_error_status: null`; `mcpServerStatus()` keeps `_meta.ui.visibility` when the rest of `_meta.ui` fails validation.
- 0.3.292 → 0.3.300: `suppressAlwaysAllowRule` on `canUseTool` options for org-gated connector tools added, then reverted.
