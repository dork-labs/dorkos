# @anthropic-ai/claude-agent-sdk Changelog: 0.3.268 → 0.3.280

**Generated**: 2026-09-22
**From**: 0.3.268 (published 2026-09-10), the pin at all seven sites (root `pnpm.overrides`, `apps/server`, `apps/desktop` + its `-darwin-arm64` / `-win32-x64` optional deps, `packages/cli`, `CLAUDE_SDK_VERSION` in `claude-code/tooling/provision.ts`), verified consistent
**To**: 0.3.280 (`latest`, published 2026-09-22T15:51Z; `next` points at the same version, so there is no pre-release channel ahead of it)
**Versions in range**: 11 published releases. **0.3.279 was never published to npm**, though upstream `CHANGELOG.md` has a parity-only `## 0.3.279` block
**Sources**: npm registry `time` field; 11 GitHub releases (every published version has one, so no gap-fill was needed); upstream `CHANGELOG.md` (cross-checked; identical bullets); `sdk.d.ts` / `sdk-tools.d.ts` / `package.json` diff of both tarballs; string reads of the `claude-agent-sdk-darwin-arm64` binary at 0.3.268, 0.3.278 and 0.3.280; the Claude Code `CHANGELOG.md` for the parity releases 2.1.269–2.1.280
**Companion**: [`impact-assessment.md`](./impact-assessment.md)

| Version | Published (UTC)  | Notes                             |
| ------- | ---------------- | --------------------------------- |
| 0.3.269 | 2026-09-11 18:15 | 5 items                           |
| 0.3.270 | 2026-09-12 18:53 | parity only                       |
| 0.3.271 | 2026-09-14 19:47 | 4 items                           |
| 0.3.272 | 2026-09-14 23:34 | parity only                       |
| 0.3.273 | 2026-09-15 18:09 | 5 items                           |
| 0.3.274 | 2026-09-16 22:38 | 9 items                           |
| 0.3.275 | 2026-09-17 20:23 | 5 fixes                           |
| 0.3.276 | 2026-09-18 01:40 | parity only                       |
| 0.3.277 | 2026-09-18 16:22 | 6 items                           |
| 0.3.278 | 2026-09-19 01:49 | parity only                       |
| 0.3.280 | 2026-09-22 15:51 | 8 items, **adds Claude Opus 5.5** |

Four releases (0.3.270, 0.3.272, 0.3.276, 0.3.278) carry nothing but "Updated to parity with Claude Code v2.1.NNN". Every release moves the bundled CLI binary, which is where the model catalog and the non-import couplings live, so the parity bumps were read through the Claude Code changelog rather than skipped.

## Summary of counts

| Category                    | Count |
| --------------------------- | ----- |
| Breaking 🔴 (type/contract) | 2     |
| Breaking 🔴 (behavioral)    | 10    |
| Deprecated 🟡               | 2     |
| Feature 🟢                  | 26    |
| Fix 🔧                      | 24    |
| Performance ⚡              | 3     |
| Internal ⚪                 | 8     |

**Type-surface shape**: `sdk.d.ts` grew 8978 → 9551 lines. Public exports: **9 added, 0 removed** (`McpServerProvenance`, `SDKStartupFailureReason`, `SDKUsageReport`, `SDKControlListPermissionRulesResponse`, `SDKControlPermissionRulesState`, `SDKPermissionRuleEntry`, `SDKPermissionRuleDescription`, `SDKPermissionWorkspaceDirectory`, `SDKControlMcpReadResourceResponse`). The `SDKMessage` union is **unchanged** (same 39 members). `Options` gained 2 fields (`verbatimPrompts`, `projectConfigRoot`) and lost none. `Query` gained 1 method (`readMcpResource`) and widened 2 signatures. `@deprecated` tags: 5 before, 5 after, same symbols. `sdk-tools.d.ts` shrank 4170 → 4153 lines and **lost three exports**.

**Packaging**: unchanged apart from the version. Same 8 platform optional dependencies (`-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-arm64-musl`, `-linux-x64`, `-linux-x64-musl`, `-win32-arm64`, `-win32-x64`), all version-locked; same `peerDependencies`, `engines`, `exports` and `dependencies`.

---

## Breaking Changes 🔴 — type and contract

### 0.3.271 (+ parity) — three built-in tool types removed from `sdk-tools.d.ts`

- `TaskOutputInput`, `REPLInput` and `REPLOutput` are gone from the `./sdk-tools` subpath. The `taskOutputMaxChars` settings doc now says outright that "the TaskOutput tool was removed".
  - **Affected API**: `@anthropic-ai/claude-agent-sdk/sdk-tools` → `TaskOutputInput`, `REPLInput`, `REPLOutput`
  - **Migration**: none for a consumer that never imported them. A host that renders `TaskOutput` tool calls by name stops ever seeing one.

### 0.3.271 — `persistent` removed from `MonitorInput`

- The Monitor tool input no longer declares `persistent`.
  - **Affected API**: `MonitorInput.persistent` (`./sdk-tools`)
  - **Migration**: drop any reference.

## Breaking Changes 🔴 — behavioral (no compiler catches these)

### 0.3.280 — the `opus` alias now means Claude Opus 5.5

- The bundled model catalog adds `claude-opus-5-5` ("Opus 5.5", June 2026 knowledge cutoff, 1M context, 128k default output) and points `aliases.opus.default` at it (first-party, Bedrock, Vertex, Mantle and anthropic_aws; Foundry and gateway keep older targets). The picker entries `opus` and `opus[1m]` now describe "Opus 5.5". Upstream Claude Code 2.1.280: "Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model — 1M context, $4/$20 per Mtok with $0.20/Mtok cache reads". Any session pinned to the alias `opus` or `opus[1m]` changes model **and price** on the bump with no setting touched.
  - **Affected API**: `supportedModels()` / `ModelInfo` values and resolved models; `Options.model = 'opus'`
  - **Migration**: none needed to get the new model; pin a full id (`claude-opus-5`) to keep the old one.

### 0.3.269 — plan mode routes writes through `canUseTool` even with `allowDangerouslySkipPermissions`

- The flag now only enables a later switch to `bypassPermissions`. Before, it evidently changed how plan mode's writes were gated.
  - **Affected API**: `Options.allowDangerouslySkipPermissions` + `permissionMode: 'plan'`

### 0.3.269 — `user_message_uuid` / `user_message_uuids` / `resume_reason` also stamped on the first complete assistant message

- With partial messages on, the same uuid now appears on the first stream event **and** the first assistant message of a turn.

### 0.3.274 — queued background-task completions share one model call

- Each queued completion still gets its own `result`, but all but the last are **empty, with `num_turns: 0`**. A host that treats every result as "a turn ran" sees results with nothing behind them.

### 0.3.274 — first turn stops waiting for deferred-tool MCP servers from settings files and plugins

- The first turn no longer waits up to 2s for MCP servers from settings files or plugins whose tools tool search defers; they arrive on a later turn. `options.mcpServers` servers are still awaited. A first-frame `mcp_status` can again show such servers `pending`.

### 0.3.277 — resumed and forked sessions continue their cost and usage totals

- `total_cost_usd`, `modelUsage` and `get_usage` totals no longer start at zero after a resume or fork: the first result already carries the earlier turns. `maxBudgetUsd` still counts only spend since this `query()` began.

### 0.3.280 — `session_state_changed` reports `requires_action` during an MCP elicitation

- Under `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, a pending MCP elicitation now reports `requires_action`, as permission prompts do.

### 0.3.280 — headless sessions cancel an MCP server's pending form question when its tool call ends

- An elicitation whose originating tool call ended is now cancelled rather than left open.

### 0.3.273 — `Stop` / `SubagentStop` / `SessionStart` hook timeouts count as "no decision"

- A timed-out SDK hook callback on those events was reported as a hook failure and discarded other hooks' decisions; now it counts as no decision, and a one-line transcript notice is shown once until the host answers again.

### Parity (from the binary) — a fourth abort cause joins the suppression set

- Not in any release note; read out of the 0.3.280 binary (see impact assessment). The CLI's suppression set is now `interrupt`, `turn-abort`, `refusal-fallback-edit`, **`permission-stop`**. `permission-stop` is raised when a `deny` permission decision ends the turn, and maps to the `turn_teardown` cause.

---

## Deprecations 🟡

No new `@deprecated` tags. Two settings became documented no-ops:

### 0.3.271-era — `Settings.taskOutputMaxChars`

- **Current usage**: none in DorkOS
- **Replacement**: none; read a background task's output file with the Read tool
- **Removal timeline**: not stated; the field is accepted and ignored

### Parity — `skipLfs` on git marketplace sources

- **Current usage**: none in DorkOS
- **Replacement**: none; Claude Code's own git never downloads LFS content now. Run `git lfs pull` by hand
- **Removal timeline**: not stated; "accepted so existing settings keep working"

---

## New Features 🟢

### Models

1. **Claude Opus 5.5 in the bundled catalog (0.3.280)** — `claude-opus-5-5`, display name "Opus 5.5"; also the new `opus` alias target (see Breaking). Absent from the 0.3.268 and 0.3.278 binaries.

### MCP trust, status and resources

2. **`McpServerProvenance` (0.3.274)** — `{ name, source }`; `source: 'sdk'` means an in-process server the host registered, and "a configured server of the same name never reads `sdk`". The SDK doc says: "Key trust decisions on `source`, not on the name or the tool-name prefix."
   - **API**: `canUseTool` options `mcpServer?: { name, source }`; `mcp_server?: McpServerProvenance` on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` and `PermissionDenied` hook inputs; `McpServerStatus.source?`; `source?` on the `system/init` `mcp_servers` rows
   - **Use case**: telling your own in-process tool server apart from a configured server that picked the same name
3. **`McpServerStatus.tools[]._meta` (0.3.280)** — the MCP Apps (SEP-1865) `ui` metadata of each tool, validated and size-bounded, from CLIs advertising `mcp_tool_ui_meta_v1`.
4. **`Query.readMcpResource(serverName, uri)` (0.3.280, `@alpha`)** — reads a `ui://` resource through the connection the CLI itself dialed. Rejects SDK-type servers. Returns `SDKControlMcpReadResourceResponse`. Needs `mcp_read_resource_v1` in `system/init.capabilities`.
5. **`CLAUDE_CODE_MCP_STARTUP_WAIT_MS` (0.3.274)** — pass via `env` to bound (or with `0` disable) the first-turn wait for connecting MCP servers.

### Prompts

6. **`Options.verbatimPrompts` (0.3.280)** — every user message goes with `client_composed: true`: no `@path` expansion and no slash-command dispatch. On current CLIs it also skips the turn-start attachment pass (nested `CLAUDE.md` and rules files, skill and tool listings, reminders). Needs Claude Code 2.1.248+.
7. **`SDKUserMessage.client_composed?: true` (0.3.280)** — the same, per message.
8. **`SDKUserMessage.pasted_content` and `inline_pastes` (0.3.277)** — pasted text kept apart from typed text.

### Results and errors

9. **`startup_failure_reason` / `SDKStartupFailureReason` (0.3.274)** — 16 machine-readable reasons (`cwd_unavailable`, `shell_tool_missing`, `cli_version_too_old`, `bypass_root`, `session_held_by_background`, `proxy_invalid`, `temp_dir_unusable`, the org-pin and gateway family, and so on) on the zeroed `error_during_execution` result a stream-json run writes before exiting. Some failures produce that result only when the host sets `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`.
10. **`task_notification.reason: 'worker_restart'` (0.3.273)**.
11. **Remote-session latency fields (0.3.277)** — `first_text_post_ms`, `first_text_post_wall_ms`, `first_stream_post_queue_wait_ms`, `first_stream_post_queued_behind`.
12. **`usage_report` / `SDKUsageReport` (0.3.273)** — structured twin of a headless `/usage` result on the synthetic assistant message. Marked experimental.

### Sessions, agents, settings

13. **`AgentDefinition.omitClaudeMd` (0.3.271)** — a subagent runs without user, project and local `CLAUDE.md`.
14. **`Options.projectConfigRoot` (types only, no release note)** — for a `cwd` that is a worktree: project settings, `.mcp.json`, the `.claude` trees and `CLAUDE_PROJECT_DIR` come from the trusted checkout instead of the branch.
15. **`updateSettings('userSettings', { effortLevel })` (0.3.277)** — saves the effort level for the current model the way `/effort` does.
16. **`SlashCommand.builtin` (0.3.277)** — marks Claude Code's own commands.
17. **`fireReason` on the task-notification origin (0.3.280)** — why a scheduled trigger fired; a local host may declare its own scheduled runs only in a process started with `CLAUDE_CODE_HOST_SCHEDULED_RUN=1`.
18. **`ForkSessionOptions.upToMessageId` accepts the client `uuid` of a streamed message** (doc + 0.3.275 fix).
19. **`list_permission_rules` control request** (types only; `SDKControlListPermissionRulesResponse` and friends exported, no `Query` method) — the live rules the terminal's `/permissions` lists, each with its source.
20. **`get_hooks_listing` control request** (non-exported types) — the `/hooks` menu's data.
21. **`rename_session` gains `source: 'remote' | 'host'` and `session_id`** (control request types).
22. **`setMaxThinkingTokens(…, 'highlights')`** — one-line thinking titles; honored only for Anthropic-hosted remote sessions.
23. **`Settings.bashEditDiffEnabled`**, and **npm marketplace sources gain `version` and `registry`**.
24. **`CLAUDE_CODE_EMIT_STARTUP_TIMING=1` (0.3.274)** — per-phase `startup_timing` on the first `system/init`.
25. **Unattended retry (0.3.280)** — under `CLAUDE_CODE_RETRY_WATCHDOG`, a usage-limit wait emits `rate_limit_event` (`rejected`, `resetsAt`) as it begins; `api_retry` heartbeats continue while subagent work waits.
26. **`askSideQuestion()` sees the running turn (0.3.280)** — not declared in `sdk.d.ts`; not a public `Query` method at this version.

---

## Bug Fixes 🔧

| Version    | Fix                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.3.269    | `result.permission_denials` omitting Read, Edit and Write calls blocked by a path-scoped deny rule                                                           |
| 0.3.269    | Interrupts and permission responses delayed while a host-started MCP OAuth sign-in waited on a slow authorization server                                     |
| 0.3.269    | Missing `tool_use_id` on `task_started` / `task_notification` when the CLI resumes a background subagent on its own                                          |
| 0.3.271    | `listSessions` / `getSessionMessages` / `getSessionInfo` with `dir` on Windows missing sessions on a mapped network or SUBST drive                           |
| 0.3.271    | `sessionStore` resume losing the global config stored under a legacy or OAuth-suffixed file name                                                             |
| 0.3.273    | `Stop` / `SubagentStop` / `SessionStart` hook timeouts discarding other hooks' decisions                                                                     |
| 0.3.273    | Browser SSE transport dropping `system/commands_changed`                                                                                                     |
| 0.3.274    | `getSessionMessages()` omitting a message the user sent while Claude ran a tool                                                                              |
| 0.3.274    | Missing `origin: {kind: 'task-notification'}` on a replayed user message when a background task finished mid-turn                                            |
| 0.3.275    | A deferred tool call's result emitted with internal keys (`toolUseResult`) instead of `tool_use_result` when the tool re-runs at the start of a resumed turn |
| 0.3.275    | `getSessionMessages()` / `forkSession()` sometimes missing a turn's assistant message right after its `result`                                               |
| 0.3.275    | `forkSession({ upToMessageId })` rejecting a non-UUID client `uuid`                                                                                          |
| 0.3.275    | `forkSession` rejecting the id `getSessionMessages` returns for a message sent while Claude worked, and a fork showing a re-run prompt twice                 |
| 0.3.275    | `getSessionMessages()` omitting a queued message Claude read while running a tool                                                                            |
| 0.3.277    | Resumed or forked session totals starting at zero (also a behavior change, see Breaking)                                                                     |
| CC 2.1.280 | A model switch made from an SDK host while Claude works causing a prompt-cache miss on the next prompt                                                       |
| CC 2.1.280 | Messages sent to a background subagent silently lost in headless and SDK sessions when it was finishing its turn                                             |
| CC 2.1.277 | `claude -p` and Agent SDK sessions that could **hang with no result after an internal error**; they now report the error and exit 1                          |
| CC 2.1.277 | Every request failing with "text content blocks must be non-empty" when an earlier assistant turn held an empty text block, including after resume           |
| CC 2.1.277 | Resumed subagents re-rendering loaded MCP tool definitions, and attachments re-rendered after a resume (both broke prompt caching)                           |
| CC 2.1.275 | `--forward-subagent-text` SDK output dropping the messages of subagents spawned by a `context: fork` skill                                                   |
| CC 2.1.274 | `--strict-mcp-config` with an empty `--mcp-config` holding the first non-interactive turn for up to `MCP_TIMEOUT`                                            |
| CC 2.1.274 | `"type": "sdk"` MCP entries in `.mcp.json`, settings, plugins and agent files now skipped with a warning: only an SDK host can register in-process servers   |
| CC 2.1.273 | SDK and stream-json output dropping a subagent's remaining messages and final report after it moved to the background mid-run                                |

## Performance ⚡

- 0.3.274: the first turn no longer waits up to 2s for deferred-tool MCP servers from settings files or plugins (also listed under Breaking).
- 0.3.274: queued background-task completions are answered by one model call instead of one each.
- CC 2.1.277: SDK and headless start-up no longer waits on the per-directory `CLAUDE.md` lookup before the first turn.

## Internal ⚪

- 0.3.270, 0.3.272, 0.3.276, 0.3.278: parity-only releases. 0.3.279: parity-only, in `CHANGELOG.md` but never published.
- `bridge.d.ts` (378 lines) and `browser-sdk.d.ts` (184 lines) unchanged in size; not imported by DorkOS.
- Doc-only rewrites of `applyFlagSettings`, `total_cost_usd`/`modelUsage`, `disableAllHooks`, `allowManagedHooksOnly`, the dynamic-workflow size guideline, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and `managedSettings.modelPricing` (multiplier range widened from (0, 1] to (0, 10]).
- `SDKControlGetUsageResponse` `model_scoped` doc clarified (absent vs. empty array); shape unchanged.
- Non-exported control-request unions grew by `get_hooks_listing`, `list_permission_rules` and `mcp_read_resource`.
- Packaging: identical apart from the version (see header).
- Tool-schema conversion still goes through `zod-to-json-schema@3.25.2` inside the bundle; the #454 crash is unchanged (see impact assessment).
- CC 2.1.274: Bedrock / Vertex / Foundry and telemetry-disabled installs moved to the v2 MCP client and MCP 2026-07-28 negotiation by default.
