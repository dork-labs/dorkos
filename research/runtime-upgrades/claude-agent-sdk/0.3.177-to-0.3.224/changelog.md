# @anthropic-ai/claude-agent-sdk Changelog: 0.3.177 → 0.3.224

**Generated**: 2026-08-07
**Sources**: npm registry (version timeline via `.time`), CHANGELOG.md (raw GitHub `main`), GitHub Releases API (2 pages, 180 releases), and a direct `.d.ts` / bundle diff of both published tarballs
**Releases covered**: 43 published to npm (0.3.178 → 0.3.224, published 2026-06-15 → 2026-08-07); the CHANGELOG additionally documents 0.3.180/184/188/192/194, which were never published to the registry
**Version significance**: Patch-level within one pre-1.0 minor (0.3.x → 0.3.x). No minor bump, so the "treat pre-1.0 minors like majors" rule does not fire — but 47 sequential patch releases accumulate real API surface, so every entry was reviewed and the types were diffed rather than trusted to the notes.

> **Reading note.** 15 of the 47 entries are bare `Updated to parity with Claude Code vX` lines with no SDK-surface change. They are collapsed under **Internal** at the bottom. Everything with a real API or behavior change is itemized. Where the release notes were thin, the authoritative answer came from diffing `sdk.d.ts` and, for the project-slug algorithm, the minified `sdk.mjs` bundle — those findings are marked **(types)** or **(bundle)**.

## Summary of counts

| Category       | Count |
| -------------- | ----- |
| Breaking 🔴    | 14    |
| Deprecated 🟡  | 3     |
| Feature 🟢     | 46    |
| Fix 🔧         | 31    |
| Performance ⚡ | 1     |
| Internal ⚪    | 15    |

---

## Breaking Changes 🔴

### 0.3.217 — Subagents no longer spawn nested subagents by default

The subagent spawn-depth cap dropped from **5 to 1**. A subagent can no longer launch its own subagent unless the host opts back in.

- **Affected API**: no type change — runtime behavior of the `Task` tool inside a session.
- **Migration**: set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` in the CLI subprocess environment to restore deeper nesting.
- **Use case**: guards against runaway recursive agent trees; costs any host that deliberately builds depth-2+ orchestration.

### 0.3.217 — Cap on concurrently-running subagents

A new default ceiling of **20** concurrently-running subagents per session.

- **Affected API**: runtime behavior; no type change.
- **Migration**: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` overrides the default.
- **Use case**: bounds fan-out; only bites hosts that dispatch more than 20 subagents from one session.

### 0.3.214 — `set_permission_mode` rejects unrecognized modes

Previously an unknown mode string was silently adopted. It is now an error. The `'manual'` alias is accepted at every ingress.

- **Affected API**: `Query.setPermissionMode()`, the `set_permission_mode` control request.
- **Migration**: send only members of the SDK's `PermissionMode` union. Validate at your own boundary — a mode your schema allows but the SDK does not now fails the call instead of degrading.
- **Use case**: turns a silent-wrong-mode class of bug into a loud one.

### 0.3.200 — `set_model` rejects unrecognized model strings

Invalid models are rejected before latching rather than accepted and failed later.

- **Affected API**: `Query.setModel()`, the `set_model` control request.
- **Migration**: pick from `supportedModels()`; do not pass user-typed model ids straight through.

### 0.3.221 — `skills` option validation tightened

Malformed skill names (delimiters, control characters) and wildcard-form names are now rejected with a clear error instead of being accepted.

- **Affected API**: `Options.skills`.
- **Migration**: use `skills: 'all'` to enable every skill; wildcards no longer work.

### 0.3.205 — `Query.interrupt()` return type changed **(types)**

`interrupt(): Promise<void>` → `interrupt(): Promise<SDKControlInterruptResponse | undefined>`.

- **Affected API**: `Query.interrupt`.
- **Migration**: a caller that discards the result is unaffected (return-type widening). A caller that _annotates_ the result as `Promise<void>`, or an object typed as implementing `Query`, must be updated.
- **Use case**: the resolved receipt carries `still_queued` — uuids of async user messages that survive the interrupt.

### Query interface gained required members **(types)**

`setMcpPermissionModeOverride(serverName, mode)` and `reinitialize()` (0.3.195) were added to the `Query` interface.

- **Affected API**: `Query`.
- **Migration**: breaks any object _declared as_ `Query` (structural implementers, strongly-typed test doubles). Consumers that only hold a `Query` are unaffected.

### `applyFlagSettings` mapped type narrowed for `effortLevel` **(types)**

`{[K in keyof Settings]?: Settings[K] | null}` → `{[K in keyof Settings]?: K extends 'effortLevel' ? EffortLevel | null : Settings[K] | null}`.

- **Affected API**: `Query.applyFlagSettings`.
- **Migration**: `effortLevel` now accepts `'max'` (session-scoped, never persisted). Callers passing a `Settings['effortLevel']`-typed value still compile; callers relying on the old exact mapped type may not.

### `./assistant` subpath export removed **(types)**

The package `exports` map lost `"./assistant"`, and `assistant.d.ts` / `assistant.mjs` are no longer published.

- **Affected API**: `import … from '@anthropic-ai/claude-agent-sdk/assistant'`.
- **Migration**: none published — the subpath is gone.

### Remote Control types removed **(types)**

`ConnectRemoteControlError`, `ConnectRemoteControlOptions`, `ConnectRemoteControlResult`, and `InboundPrompt` are no longer exported from `sdk.d.ts`.

- **Affected API**: the `connectRemoteControl` typed surface.
- **Migration**: none documented; Remote Control moved behind other entry points.

### `setMcpServers({})` no longer removes plugin-introduced MCP servers

Servers a plugin brought in are exempt from the omit-to-remove rule: they keep running and are absent from the response's `removed` list.

- **Affected API**: `Query.setMcpServers`.
- **Migration**: `setMcpServers({})` no longer guarantees zero dynamic MCP surface when plugins are loaded. Name a plugin server explicitly to act on it.

### 0.3.204 / 0.3.206 — `terminal_reason` taxonomy widened; some turns reclassified

New values: `tool_deferred_unavailable`, `turn_setup_failed`, `api_error`, `malformed_tool_use_exhausted`, `budget_exhausted`, `structured_output_retry_exhausted`. Turns that died on an exhausted-API-retry or a malformed-tool-use give-up **previously reported `completed`** and now classify as dead turns; commands consumed by them report `command_lifecycle` state `cancelled`.

- **Affected API**: result-message `terminal_reason`, `command_lifecycle` frames.
- **Migration**: lifecycle sweeps that read a missing `terminal_reason` as clean completion will now see failures they previously missed — which is the point, but it changes counts.

### 0.3.186 — Background agents forward permission prompts instead of auto-denying

`can_use_tool` control requests gained an `agent_id` field, and background agents now route their permission prompts to the host's `canUseTool` callback rather than auto-denying. Stdin stays open while background tasks run.

- **Affected API**: `Options.canUseTool`.
- **Migration**: a host implementing `canUseTool` will now receive prompts it never saw before, from background agents. Ensure the callback is safe to invoke outside a foreground turn.

### 0.3.223 — Bare headless emits `system/permission_denied`

`-p` / SDK `query()` **without** `canUseTool` now emits `system/permission_denied` stream events when a tool call is auto-denied, where it previously emitted nothing.

- **Affected API**: the `SDKMessage` stream.
- **Migration**: additive for tolerant consumers; a strict exhaustive switch will now hit a case it never saw.

---

## Deprecations 🟡

### `team_name` on task/teammate hook inputs **(types)**

Deprecated on `TaskCompletedHookInput`, `TaskCreatedHookInput`, and `TeammateIdleHookInput`.

- **Replacement**: none needed — "sessions have a single implicit team; this carries the session-derived team name and will be removed in a future release."
- **Migration**: stop reading `team_name` from hook payloads.

### (Carried forward, not new in range) `Options.maxThinkingTokens` and `Query.setMaxThinkingTokens`

Both were already `@deprecated` at 0.3.177 in favour of the `thinking` option / `ThinkingConfig`. Still deprecated at 0.3.224, still functional.

- **Replacement**: `thinking: { type: 'adaptive' }` or `thinking: { type: 'enabled', budgetTokens: N }`.

---

## Features 🟢

### Interrupt receipts and queued-message cancellation (0.3.205, 0.3.219)

- `Query.interrupt()` resolves to a typed receipt with `still_queued` (uuids of queued async messages that will **still run**).
- `system/init` advertises an `interrupt_receipt_v1` capability for feature detection.
- 0.3.219 adds opt-in `cancel_queued` to the interrupt control request (capability `interrupt_cancel_queued_v1`): cancels queued and pending-dispatch messages alongside the abort, listing them on the response's `cancelled` field.
- **Affected API**: `Query.interrupt`, `SDKControlInterruptResponse`, `SDKSystemMessage.capabilities`.
- **Use case**: "Stop" that actually stops, instead of stopping the current turn while queued work marches on.

### `SDKSystemMessage.capabilities: string[]` **(types)**

An open set of protocol capability strings on `system/init`, so hosts feature-detect instead of version-sniffing. Documented members so far: `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`.

- **Use case**: the correct way to adopt any of the newer control-protocol features without pinning behavior to a version number.

### `Query.reinitialize()` (0.3.195)

Re-sends the `initialize` control request to an already-running CLI. The response carries any `can_use_tool` / `request_user_dialog` requests the loop is still blocked on, and the SDK redelivers them to `canUseTool` / `onUserDialog`. Unlike `initializationResult()`, it always sends fresh rather than returning the cached first-connect result.

- **Use case**: recovering pending permission prompts after a transport gap (reattach, ring-buffer eviction, dropped socket). Callbacks should be idempotent per `request_id`.

### `SDKAssistantMessage.aborted?: true` (0.3.214) **(types)**

Set when an assistant message was truncated by an interrupt/abort before the stream completed — `stop_reason` was never received and the content may end mid-word.

- **Use case**: distinguishing a mid-stream partial from a completed message, so a UI can say so instead of rendering a truncated sentence as finished prose.

### `SDKAssistantMessage.timestamp` (0.3.211) **(types)**

ISO-8601, matching `SDKUserMessage`. Originating host's clock — display only, never an ordering key. Older emitters omit it; fall back to receive time.

### `SDKAssistantMessage.resumed_from_incomplete_thinking?: true` **(types)**

Marks a turn that continued a preceding truncated assistant turn inside its trailing signed thinking block (max-output-tokens recovery). A history replayed through the bridge must carry the flag back for the normalizer.

### `tool_result_meta` sidecar on user messages (0.3.216)

Carries `non_execution_kind` and `user_feedback` so consumers can classify denied, interrupted, or cancelled tool calls **without string-matching result prose**.

- **Use case**: correct "Denied" / "Cancelled" tool chips that survive a wording change upstream.

### `tool_progress` gains `subagent_type`, `subagent_retry`, `heartbeat` (0.3.214) **(types)**

`subagent_retry` is a struct: `{ agent_id, attempt, max_retries, retry_delay_ms, error_status, error_category }`.

- **Use case**: showing a subagent waiting out an API rate-limit retry, rather than an opaque stall.

### `background_tasks_changed` system message (0.3.203)

Carries the **full set** of live background tasks on every membership change.

- **Use case**: track background activity as a level rather than by pairing `task_started` / `task_notification` edges — robust against a missed edge.

### `command_lifecycle` frames (0.3.206)

Every uuid-stamped message reports its terminal state: `queued` / `started` / `completed` / `cancelled` / `discarded`. Zero-API results no longer report a stale `duration_api_ms`.

### `SDKMessageOrigin` widened substantially (0.3.204–0.3.224) **(types)**

- New kinds: `unclassified`, `observer` (`{from, senderTaskId}`), `observer-activity`.
- `peer` gains `name` (harness-normalized sender display name — Cc/Cf/Cs/Zl/Zp stripped, ≤64 code points), `body` (decoded message body with the envelope stripped, byte-exact with what the model sees), `fromSession` (sender's host-openable session id, a navigation target only), and `verifiedPeerPid` (**kernel-verified** pid from SO_PEERCRED / LOCAL_PEERPID — never from the payload; absent when unverifiable, never wrong).
- `task-notification` gains `subkind?: 'scheduled-trigger' | 'peer-send-message'`.
- **Use case**: `verifiedPeerPid` is the first non-forgeable sender identity on this surface — `from` is sender-authored and forgeable by any same-user process.

### Cross-session messaging settings (0.3.224)

`crossSessionInbound` and `dialogExpiry`: cross-session messages sent to a session running with bypassed permissions are held for approval; messages to other sessions auto-deliver.

### `resumeDropsTurn` option (0.3.223)

Used with `resumeSessionAt`, declares the turn a truncating resume intends to drop. The CLI **refuses the resume** if anything else would be discarded.

- **Use case**: converts silent transcript loss on a stale anchor into a refused resume.

### `api_error_status` on results (0.3.218, 0.3.223)

Repeated 529 overload failures now include `api_error_status: 529` on the result message, so hosts detect overload terminations structurally instead of matching message text. 0.3.218 additionally fixed mid-stream rate-limit/overload errors reporting null; they now report 429/529.

### `modelUsage` entries gain `canonicalModel` and `provider` (0.3.218)

So downstream billing can look up the correct rate table for `costUSD`.

### `usage` vs `modelUsage` documented (0.3.223)

`usage` is main-loop-only and per-turn; `modelUsage` is cumulative, covers all query-pipeline calls, and **is the field for cost accounting**.

### `ModelInfo.resolvedModel?: string` **(types)**

Canonical wire model id an alias row resolves to (e.g. `sonnet` → `claude-sonnet-5`), so hosts can match a persisted explicit id against the alias row covering it.

### Plugin manifest `version` surfaced (0.3.214)

`system/init` `plugins[]` entries and the `reload_plugins` response now include each plugin's manifest `version`. Emitted verbatim and plugin-author-controlled — validate before trusting.

### `fast_mode_disabled_reason` (0.3.219) **(types)**

New `FastModeDisabledReason` type on result and init messages, so hosts can explain _why_ fast mode is off.

### `DirectoryAdded` lifecycle hook event (0.3.219)

Fires when a new working directory is registered mid-session.

### `rewind_conversation` control request (0.3.186), `rewindFiles` `skippedLinks` (0.3.216)

Rewind a conversation to a previous point with durable resume-anchor support; `skippedLinks` counts paths the rewind safety guards refused to restore or delete.

### `ReadMcpResourceDirTool` (0.3.186)

MCP resource-directory listing became a dedicated tool type instead of a fallback inside `ReadMcpResourceTool`.

### `canUseTool` gains `requestId`; may return `null` (0.3.199)

`requestId` correlates out-of-band permission responses; returning `null` suppresses the SDK's automatic control response.

### `canUseTool` shadowing warning (0.3.198)

Runtime warning when `canUseTool` is configured alongside `allowedTools` or `bypassPermissions`, which shadow the callback.

### `mcp_set_servers` per-server `request_timeout_ms` (0.3.198)

### `prompt_id` on hook input payloads (0.3.196)

For correlating hook events with OpenTelemetry prompt-level events.

### Rate-limit classification exports (0.3.211) **(@alpha)**

`USAGE_LIMIT_ERROR_PREFIXES`, `USAGE_WARNING_PREFIXES`, `USAGE_TRANSITION_PREFIXES`, `ORG_POLICY_LIMIT_PREFIXES` — classify rate-limit messages without hand-mirroring the lists.

### `SDKRateLimitInfo` extended (0.3.181, 0.3.191)

`errorCode`, `canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod` for credits-required rate limits; `seven_day_overage_included` rate-limit type and a `model_scoped` array on the usage response for per-model weekly limit windows with utilization and reset times.

### `tool_use_meta` sidecar on assistant messages (0.3.179, 0.3.181)

Display-friendly names for tool calls, so hosts render human-readable labels instead of raw wire names. 0.3.181 adds `tool_use_meta.icon_url`, populated from MCP server directory metadata.

### `SkillToolOutput.background` (0.3.218)

Reports `true` when a forked skill was dispatched as a detached background agent.

### `BashToolOutput.timedOutAfterMs` (0.3.210)

Set when a command is auto-backgrounded on timeout.

### `NotebookEdit` results gain `old_source` (0.3.191)

For `replace` and `delete` operations, enabling inline diffs.

### `AgentToolCompletedOutput` published (0.3.207)

The Agent tool's structured result now has a published SDK type matching the emitted object exactly.

### Agent tool output reports the resolved model (0.3.212)

When a mid-turn model swap changed the subagent's model.

### `parent_agent_id` on subagent session messages (0.3.202)

For building depth-2+ agent trees from disk-persisted metadata.

### `SessionStart` hooks report source `"fork"` (0.3.214)

Instead of `"resume"` when the session begins as a fork.

### Typed permission-denial reasons (0.3.178)

Permission-denied advisory messages carry typed denial reasons (`safetyCheck`, `asyncAgent`), so hosts match denial causes programmatically.

### `worker_shutting_down` system message (0.3.178)

Remote Control workers send it on graceful exit so remote clients can show why the session ended.

### `workflow_agent` progress gains `blocked` (0.3.199)

Indicates an agent blocked by the auto-mode safety classifier.

### `Query.setMcpPermissionModeOverride()` **(types)**

Pin or clear a per-MCP-server permission-mode override. **Tighten-only**: accepts `'default' | 'auto' | null`, and applies only when the session mode would already auto-allow, so it can never widen privilege. Returns `{warning?}` when the server name matches nothing currently known (typo detection); the override is stored regardless.

### `Query.setMaxThinkingTokens` gains `thinkingDisplay` **(types)**

Optional second parameter `'summarized' | 'omitted' | null` sets the thinking display mode for the rest of the session.

### Sandbox settings types (0.3.187, 0.3.199, 0.3.219, 0.3.224)

`sandbox.credentials` (credential file and env-var denial); `mode:"mask"` and per-credential `injectHosts`; `sandbox.network.strictAllowlist` (deterministically deny non-allowlisted hosts); credential-masking fields `decode: 'jwt'` with `maskClaims`, `extract`/`onExtractNoMatch` on `envVars`, and `awsPairs`/`sigv4` for AWS SigV4 re-signing.

### `workflowSizeGuideline` setting (0.3.219)

Advisory dynamic-workflow size guideline.

### `source: 'archive'` plugin config variant (0.3.224)

Install plugins from a zip over HTTPS, with `url` and optional `sha256`.

### Browser SDK `promptSuggestions` option (0.3.193)

Opts the remote CLI into emitting follow-up suggestions.

### New `SDKMessage` union members **(types)**

`SDKControlRequestProgressMessage`, `SDKModelRefusalNoFallbackMessage`, `SDKBackgroundTasksChangedMessage`, `SDKWorkerShuttingDownMessage`, `SDKInformationalMessage`, `SDKConversationResetMessage`. Also newly exported: `SDKActiveGoalMessage`, `SDKControlGetPlanRequest`, `SDKControlGetWorkspaceDiffRequest`, `SDKControlListModelsRequest`, `SandboxCredentialsConfig(Schema)`, `DirectoryAddedHookInput`.

### Result message correlation fields (0.3.216)

Optional `user_message_uuid` and `request_sent_wall_ms` on the success result, for cross-host request-latency correlation.

---

## Fixes 🔧

### Session storage and resume

- **0.3.224** — Long (>200 char) project paths resolved to **another project's** session directory under a shared sanitized prefix. Session list/get/rename/tag/fork/delete and `/resume` no longer cross projects. **(bundle: the slug computation itself — `path.replace(/[^a-zA-Z0-9]/g,'-')`, 200-char cut, base36 `(t<<5)-t+charCodeAt` hash of the original path — is byte-identical between 0.3.177 and 0.3.224; the fix is on the lookup side.)**
- **0.3.222** — `query({ sessionStore, resume })` did not carry user `settings.json` (`apiKeyHelper`, `env`, `hooks`, `permissions`) into the resumed subprocess.
- **0.3.212** — Dash-leading `resumeSessionAt` and `sessionId` values were passed to the CLI as separate argv tokens; both now use equals-form (`--flag=value`).
- **0.3.208** — `extraArgs` values that look like flags (e.g. `resume: '--version'`) were parsed as their own CLI flags; dash-leading values now bind with equals-form.

### MCP

- **0.3.221** — External MCP servers passed via the `mcpServers` option were **not connected before the first turn**, which caused the model to emit tool calls as literal text.
- **0.3.178** — MCP server-level specs (`mcp__server`, `mcp__server__*`) in `disallowedTools` were silently ignored; they now correctly remove all tools from the named server.
- **0.3.208** — `createSdkMcpServer` docs pointed at a nonexistent env var; the MCP tool-call timeout knob is `MCP_TOOL_TIMEOUT`.

### Permissions, hooks, and abort handling

- **0.3.207** — `canUseTool` returning `{behavior: 'allow'}` **without** `updatedInput` was rejected as a deny with a raw ZodError message; the tool now runs with the original input per the documented contract.
- **0.3.208** — A caller abort during a pending SDK hook callback was converted into hook _success_, letting PreToolUse-gated tools execute after the abort.
- **0.3.208** — An SDK `UserPromptSubmit` hook callback exceeding its timeout killed the entire query with an empty error; it now blocks the prompt with a clear message and the session continues.
- **0.3.208** — Abort-listener leak: streaming queries sharing one `AbortController` accumulated `abort` listeners on its signal after each completed query.
- **0.3.178** — `UserPromptSubmit` hook block feedback was not emitted to the SDK event stream, so consumers saw a silent hang instead of the reason.
- **0.3.200** — `onSetPermissionMode` callback did not fire for SDK-hosted Remote Control sessions.
- **0.3.202** — `apply_flag_settings` with a non-object settings value crashed the session instead of returning a control error.

### Control protocol and streaming

- **0.3.196** — Control-protocol deduplication dropped tool-use IDs after 1000 resolutions, causing duplicate `tool_result` deliveries in long-running sessions.
- **0.3.208** — Per-query resource leak in process tracking when spawning the CLI fails (nonexistent or inaccessible executable path).
- **0.3.208** — Uncaught exception when writing to stdin after the Claude Code subprocess has exited.
- **0.3.211** — `--replay-user-messages` with `--include-partial-messages` emitted the turn-start user replay _after_ the first content block instead of before the turn's content events.
- **0.3.211** — Process-exit errors now include the CLI's stderr output, so a failed child reports its actual cause instead of only an exit code.
- **0.3.198** — `SDKUserMessage.isSynthetic` was not mapped to `isMeta` on ingestion, so synthetic messages could be treated as real user messages.
- **0.3.198** — Workflow progress events silently dropped the earliest agents from the list while the phase counter remained correct.
- **0.3.204** — The post-merge cancel backstop cancelled every member of a coalesced prompt batch when a cancel named only one; uncancelled siblings now re-merge and run. (Previously they were reported `cancelled` — on remote transports that acknowledged them as processed, silently dropping messages nobody cancelled.)

### Commands, plugins, and skills

- **0.3.195** — `commands_changed` was not emitted for synced skills when the skill list resolved _before_ the change-detector subscribed.
- **0.3.203** — Stable releases shipped an `sdk.d.ts` with unresolved type references that broke consumer typechecking with `skipLibCheck` disabled.

### Models, modes, and fast mode

- **0.3.219** — The initialize response reported `fast_mode_state` from the spawn-time model after a model switch.
- **0.3.191** — Fast mode reverted to standard after the first turn when `settingSources` included user/project settings.

### Background agents and remote sessions

- **0.3.179** — `-p` mode exited before a completed background agent's notification was delivered, causing interim text to ship as the final result.
- **0.3.217** — Remote Control sessions did not re-send pending permission prompts to clients that connected after the prompt appeared.
- **0.3.181** — SDK-hosted Remote Control sessions dropped `file_attachments` from inbound user messages.

### Platform

- **0.3.193** — Brief console-window flashes on Windows when spawning CLI subprocesses.
- **0.3.178** — Spawn failures on an existing native binary now explain the likely libc mismatch (musl binary on a glibc host) and suggest `options.pathToClaudeCodeExecutable`.

---

## Performance ⚡

- **0.3.179** — Remote (stream-json) sessions no longer appear busy for the entire duration of a background workflow: the turn result is emitted at the turn boundary and the session reports idle while background tasks continue.

---

## Internal ⚪

Bare `Updated to parity with Claude Code vX` entries with no documented SDK-surface change:

0.3.180, 0.3.182, 0.3.183, 0.3.184, 0.3.185, 0.3.188, 0.3.190, 0.3.192, 0.3.194, 0.3.197, 0.3.201, 0.3.209, 0.3.213, 0.3.215, 0.3.220.

(0.3.204 also carries a parity line alongside its substantive entries.)

---

## Package-level facts verified from the tarballs

| Fact                   | 0.3.177                                                                                   | 0.3.224                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| `exports` subpaths     | `.`, `./extract`, `./browser`, `./bridge`, `./assistant`, `./sdk-tools`, `./sdk-tools.js` | same minus **`./assistant`**              |
| `optionalDependencies` | 8 platform binaries                                                                       | same 8, version-locked                    |
| `peerDependencies`     | `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`           | **unchanged**                             |
| `engines.node`         | `>=18.0.0`                                                                                | unchanged                                 |
| `Options` fields       | 63                                                                                        | 64 (**+`resumeDropsTurn`**, zero removed) |
| `PermissionMode`       | `default \| acceptEdits \| bypassPermissions \| plan \| dontAsk \| auto`                  | **identical**                             |
| `sdk.d.ts` size        | 6,508 lines                                                                               | 7,429 lines                               |
