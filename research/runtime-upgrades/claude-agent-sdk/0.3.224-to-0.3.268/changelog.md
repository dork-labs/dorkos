# @anthropic-ai/claude-agent-sdk Changelog: 0.3.224 → 0.3.268

**Generated**: 2026-09-11
**From**: 0.3.224 (published 2026-08-07) — the pin in root `pnpm.overrides`, `apps/server`, `apps/desktop`, `packages/cli`, and `claude-code/tooling/provision.ts`
**To**: 0.3.268 (`latest`, published 2026-09-10)
**Versions in range**: 35 published releases (0.3.225 … 0.3.268; 0.3.230, 0.3.244, 0.3.249, 0.3.253–0.3.256, 0.3.262, 0.3.264 were never published)
**Sources**: npm registry `time` field; 33 GitHub releases; upstream `CHANGELOG.md` (gap-filled 0.3.242 and 0.3.243, which have no GitHub release); `.d.ts` and `sdk.mjs` diff of both tarballs
**Companion**: [`impact-assessment.md`](./impact-assessment.md)

**17 of the 35 releases carry nothing but "Updated to parity with Claude Code v2.1.NNN"** — 0.3.226, 0.3.227, 0.3.231, 0.3.235, 0.3.237, 0.3.240, 0.3.241, 0.3.242, 0.3.245, 0.3.250, 0.3.251, 0.3.252, 0.3.258, 0.3.263, 0.3.266, plus the parity lines riding 0.3.257/0.3.259/0.3.260/0.3.261/0.3.265/0.3.267/0.3.268. They are counted once under Internal and not analysed individually — but note that a parity bump moves the bundled CLI binary, which is where the four non-import couplings live.

## Summary of counts

| Category                    | Count |
| --------------------------- | ----- |
| Breaking 🔴 (type/contract) | 15    |
| Breaking 🔴 (behavioral)    | 10    |
| Deprecated 🟡               | 0     |
| Feature 🟢                  | 42    |
| Fix 🔧                      | 19    |
| Performance ⚡              | 4     |
| Internal ⚪                 | 19    |

**Zero new `@deprecated` annotations** across the whole range — the count in `sdk.d.ts` is 5 before and 5 after, on the same five symbols. There is nothing to migrate off.

**Type-surface shape**: `sdk.d.ts` grew 7429 → 8978 lines. Public exports: **8 added, 0 removed**. Two non-exported internal control-request types were deleted. `Options` gained 3 top-level fields and removed none. The `SDKMessage` union is **unchanged** — same 38 members, no additions, no removals.

---

## Breaking Changes 🔴 — type and contract

### 0.3.234 — `ExitReason` / `EXIT_REASONS` drop `'bypass_permissions_disabled'` **(types)**

Upstream removed the value outright, saying it was never emitted. Both the const tuple and the union narrow from 6 values to 5. A consumer with an explicit `case 'bypass_permissions_disabled'` gets a compile error; runtime behavior is unaffected because nothing ever produced it.

### 0.3.234 — `ApiKeySource` widened to the values `system/init` actually reports **(types)**

`'user' | 'project' | 'org' | 'temporary' | 'oauth'` → the same five **plus** `'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'`. This is the type catching up to shipped behavior, not a behavior change: the CLI has been reporting the new strings all along. Exhaustive switches over the old union break.

### `SDKAssistantMessageError` widened by three values **(types)**

Added `'account_on_hold'`, `'verification_required'`, `'cloud_credential_error'` beside the existing eleven. Any hand-maintained set or exhaustive switch over the old values silently under-covers the new ones.

### 0.3.268 — `kind` is now a **required** field on every `get_context_usage` category **(types)**

`SDKControlGetContextUsageResponse.categories[]` gains `kind: 'used' | 'free' | 'buffer' | 'deferred'` — not optional. `isDeferred?: boolean` survives beside it. The doc on `name` now says outright: _"Use `kind` (not this name) to classify the row."_ A consumer that only reads the response is unaffected; a consumer that **constructs** one (a test double, a fixture) must add the field.

### `SDKResultError` gains five previously-absent fields **(types)**

`user_message_uuid?`, `user_message_uuids?`, `resume_reason?`, `result_index?`, `queued_turn_count?` are now declared on the error result, not only on `SDKResultSuccess`. At 0.3.224 `SDKResultError` declared **none** of the uuid fields. This flips a documented invariant that a consumer may have keyed its correlation logic on.

### 0.3.232 — Subagent MCP `tool_result` frames with `_meta` change shape

A subagent MCP `tool_result` whose result carries `_meta` now emits `tool_use_result` as `{ content, _meta }`, matching main-loop frames, instead of a bare value. A reader that assumed the bare value reads `undefined` for the payload.

### 0.3.229 — `terminal_reason` for oversized conversations reclassified

A conversation whose messages alone exceed the API's 32 MB limit ends the turn with `terminal_reason: "api_error"` instead of `"image_error"`; `StopFailure` `error_details` is now `"request_body_over_limit: …"`.

### 0.3.238 — `command_lifecycle` gains the terminal state `refused`

A cross-session peer message the receive-side policy declines now reports `refused` instead of producing no lifecycle frames at all. A state machine over the previous states sees a value it has never seen.

### 0.3.238 — `vcs_state_changed` push emits one event per pushed branch

Previously one event covered a push. A consumer counting events now counts more of them. (0.3.232 separately started populating the `branch` field for pushes, sourced from the pushed ref; 0.3.234 made the event report the directory the shell **finished** in, so an inner `cd` is reflected.)

### 0.3.243 — Read tool PDF results relocate the `document` block

The `document` block — or the page `image` blocks for a `pages` read — now arrives **inside** the `tool_result` content instead of as a separate `user` message after it. A consumer that watched for the trailing user message no longer sees one.

### 0.3.243 — Managed `disableAllHooks` no longer disables `hooks`-option callbacks

Callbacks registered through the SDK `hooks` option keep running under managed `disableAllHooks`, matching `allowManagedHooksOnly`. A deployment that relied on the managed setting to silence SDK-registered callbacks no longer gets that.

### 0.3.239 — `total_cost_usd` / `modelUsage.costUSD` include the US-inference multiplier

Both now carry the 1.1× US-only-inference (data residency) multiplier when the response reports `inference_geo: "us"`. Reported costs rise 10% on affected responses with no change to what was actually spent per token.

### 0.3.260 — `rewindFiles()` now fails where it used to report success

A rewind that restored no files — for example when checkpoint backups are missing — reported success. It now fails.

### 0.3.260 — `error_max_structured_output_retries` result text changed

The result now appends the last StructuredOutput tool error, and validation errors name the offending key, the allowed values, and the actual length or count. A test asserting the old message text breaks.

### Internal control-request types removed **(types, non-exported)**

`SDKControlGetPlanRequest` (`get_plan`) and `SDKControlGetWorkspaceDiffRequest` (`get_workspace_diff`) are gone from `sdk.d.ts` entirely, along with their members of the `SDKControlRequestInner` union. Neither was ever an `export declare`, so no public export was removed.

### 0.3.257 — `mcp_set_servers` reclassifies a throwing server

A server whose connection attempt **throws** is now also listed under `added` (with a `failed` row in `mcp_status`), not only under `errors`. A consumer that treated `added` as "these connected" is now wrong.

### Sandbox-settings Zod schemas restructured **(types)**

`z.ZodPipe<z.ZodTransform<…>, …>` became `z.ZodPreprocess<…>` across the sandbox settings schemas (`files`, `envVars`, `bwrapPath`, `socatPath`). Type-level only; the parsed shape is the same.

---

## Breaking Changes 🔴 — behavioral (no compiler catches these)

### 0.3.233 + 0.3.268 — Task and Todo tools left the default tool surface

**0.3.233**: `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` and `TodoWrite` are no longer default tools on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models. **0.3.268** restated the rule from the other side: they are default tools **only** on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6 and Haiku 4.5. Everywhere else you must name them in `tools`, reference them in `allowedTools`, or set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.

Nothing errors. The tools simply are not offered, the model never calls them, and any host that renders todo/task state from those tool calls renders an empty list forever.

### 0.3.265 — Multi-turn sessions no longer reset the shell working directory each turn

Previously each new user message reset the shell cwd to the `cwd` option. Now a `cd` the agent made **persists across turns**, as in the interactive app. Framed upstream as a fix; it is a change in where a long-lived session's commands actually run.

### 0.3.267 — `systemPrompt` recording defaults ON for custom prompts and appends

Recording (snapshotting) is now the default; a mid-session prompt change takes effect **at the next compaction** rather than on the next request. `snapshot: false` restores per-request rendering. The new `snapshot?: boolean` field is on both the `{type:'custom'}` and `{type:'preset'}` branches of `Options.systemPrompt`.

### 0.3.246 — `interrupt()` stops background agents and workflows unless you opt out

New `perTaskStopAffordance` option: when set, `interrupt()` aborts only the current turn and leaves background agents and workflows running. **Otherwise — and always for one-shot string prompts — they stop.** The option names a previously unnamed default and gives it a lever; the default side of it is what an existing host inherits.

### 0.3.265 + 0.3.268 — `user_message_uuid` emission cadence changed

`user_message_uuid` is now set on the first reply **after each change of the message a turn is answering**, instead of once per turn on one reply frame. On the automatic re-run of a host-restart-interrupted turn it names that turn's **last** user prompt. Any consumer that treated "one uuid per turn" as an invariant now sees more of them.

### 0.3.233 — Notification hooks fire for pending permission prompts on the SDK path

Matching the interactive REPL. A host that registers a `Notification` hook and assumed permission prompts did not reach it now gets them.

### 0.3.243 + 0.3.257 — MCP status and MCP control-request targeting changed

**0.3.243**: `mcp_status` no longer reports a remote MCP server as connected after its connection dropped — it reports `pending` while reconnecting, then `connected` or `failed`. So `pending` now means two different things, and the status **distribution** a snapshot returns has shifted. **0.3.257**: `mcp_reconnect` and `mcp_toggle` stopped acting on a same-named `.mcp.json` / `~/.claude.json` server instead of the `--mcp-config` or `mcp_set_servers` one, and `mcp_toggle` disable stopped removing the tools of a sibling server whose name extends the disabled one's (disabling `foo` had dropped `foo__bar`'s tools).

### 0.3.268 — `setModel()` confirms unknown model ids with the API instead of refusing

A model id the CLI does not know locally is now confirmed with the API the first time a session uses it, rather than refused as unrecognized. This partially reverses 0.3.200's tightening: a set that used to fail fast now costs an API round trip and may succeed.

### 0.3.247 — Per-turn `system/init` `permissionMode` reports the live mode

It reported the mode at turn start; it now reports the live mode, so a mode switch made right after submitting no longer sends a stale value.

### 0.3.257 — Agent tool calls emit the periodic `tool_progress` heartbeat

Agent (subagent) tool calls now emit `tool_progress` with `heartbeat: true` like other long tools. Heartbeat frames never clear a `subagent_retry` indicator. A consumer counting `tool_progress` frames sees new traffic on a path that previously produced none.

---

## Deprecations 🟡

**None.** `sdk.d.ts` carries exactly 5 `@deprecated` annotations at 0.3.224 and the same 5 at 0.3.268, on the same symbols. No API was newly marked for removal in this range.

---

## Features 🟢

### Turn correlation — the largest cluster in the range

1. **`user_message_uuids` (plural) (0.3.259)** — beside `user_message_uuid` on a turn's first reply frame and on the result: **every** user message the turn answered, so a reply to several merged messages can be matched to each individually.
2. **`user_message_uuid` on error results** — newly declared on `SDKResultError` (see Breaking).
3. **`user_message_uuid` on synthetic and self-started turns (0.3.265)** — for a message sent with `isSynthetic: true` and a `uuid`, and for a turn Claude Code started itself (such as a resume), naming the messages it picked up mid-turn.
4. **`user_message_uuid` on `thinking_tokens` system messages (0.3.260)** — links thinking progress to the user message that triggered the turn.
5. **`result_index` (0.3.268)** — the result's position in delivery order within the run, from 0.
6. **`queued_turn_count` on result messages (0.3.243)** — how many queued user sends were still pending when the result was produced, so a host knows whether another turn and result will follow.
7. **`resume_reason` (0.3.268)** — on assistant, stream-event and result messages; set **only** on the automatic re-run of a turn a host restart interrupted.
8. **`local_command` (0.3.268)** — on the result of a turn that ran a slash command without entering the model loop, carrying the command's name.

### Options

9. **`perTaskStopAffordance?: boolean` (0.3.246)** — see Breaking; the opt-out for narrow interrupts.
10. **`permissionPrompts?: 'host' | 'none'` (0.3.259)** — `'none'` auto-denies permission prompts in sessions with nobody to answer them, **without** disabling auto mode's classifier.
11. **`pluginDelivery?: 'argv' | 'initialize'` (0.3.261)** — sends `plugins` over stdin so the launch command line no longer grows with the plugin count. Fixes Windows start failures with many plugins.
12. **`systemPrompt.snapshot?: boolean`** — on both the custom and preset branches (see Breaking).
13. **`SdkPluginConfig.skipMcpDiscovery?: boolean`** — load a plugin's skills/hooks/agents/commands but **not** its `.mcp.json` or manifest `mcpServers`, for when the SDK host owns that plugin's MCP connections.
14. **`managedSettings.modelPricing` (0.3.246)** — for hosts that set `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; an admin-managed settings source setting `modelPricing` still wins.

### MCP and tool servers

15. **`createSdkMcpServer({ timeout })` (0.3.248)** — a per-server timeout overriding `MCP_TOOL_TIMEOUT` for that server's tool calls. Previously the only lever was the process-wide env var.
16. **`tool_use_result.resourceLinks` (0.3.257)** — the `resource_link` blocks an MCP tool returned, on user messages carrying its result, so a host can render returned files without parsing result text. New exported type `SDKMcpResourceLink`.
17. **`resource_links` on `task_notification` (0.3.257)** — for an auto-backgrounded MCP tool call that completed; join to the call via `tool_use_id`.

### Context usage

18. **`getContextUsage({ detail })` (0.3.257)** — `'summary'` answers from the last response's usage and local estimates, skipping the per-category token-count API calls; default stays `'full'`.
19. **`SDKContextUsage` / `SDKContextUsageCategory` exported types (0.3.232)** — `/context` result messages now carry a structured `context_usage` payload, so the context card renders without parsing the markdown table. Includes `over_limit: { tokens_over, kind }` and an `mcp_tools` breakdown.
20. **`kind` on control-response categories (0.3.268)** — see Breaking; classifies a row without matching its display name.

### Plugins, skills, styles, settings

21. **`Query.reloadPlugins({ holdOnCacheImpact })` (0.3.268)** — holds a reload that would invalidate the session's prompt cache; the response carries `held: true` plus `cache_impact` describing what applying would change (`mcp_servers_added`, `lsp_tool_change`, `estimated_cache_write_usd`). Call again without the option to apply anyway.
22. **`Query.reloadOutputStyles()`** — new control request `reload_output_styles` and exported `SDKControlReloadOutputStylesResponse`. Also drops the shared markdown-file scan cache, so agents, skills and routines re-read their directories on next use.
23. **`SDKControlUpdateSettingsRequest` (`update_settings`)** — merges settings into the flag-settings layer at runtime.

### Hooks

24. **`PreModelSwitch` / `PostModelSwitch` hook events** — four new exported types (`PreModelSwitchHookInput`, `PreModelSwitchHookSpecificOutput`, and the Post pair), carrying `from_model` / `to_model` / `requested_model` and a `source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume'`.
25. **`PostToolUse` `hookSpecificOutput.classifierContext` (0.3.236)** — a short host-asserted note about a tool call's result that the **auto mode permission classifier** reads alongside that result.
26. **`UserPromptExpansion` `suppressOriginalPrompt` (0.3.238)** — matching `UserPromptSubmit`.

### Background tasks and subagents

27. **`is_backgrounded` and `spawn_depth` on `task_started` (0.3.238)** — for subagent tasks; `is_backgrounded` also on background Bash tasks.
28. **`ambient` flag on `task_started` / `task_notification` / `background_tasks_changed` entries (0.3.247)** — so a host can exclude housekeeping tasks from activity indicators.
29. **`background_tasks_changed` snapshot after a repeated `initialize` (0.3.239)** — a reconnecting host sees work that is still running.

### Permissions

30. **`canUseTool` options `defaultToNo` and `suppressAlwaysAllowRule` (0.3.268)** — hints that the prompt should open on its decline option, or offer no persistent "always allow" choice.
31. **`initialize` success response always includes `pending_permission_requests` (0.3.268)** — empty when nothing is pending, so a client can tell that apart from an older CLI that omitted it.
32. **`origin.fromMode?: 'bypass' | 'prompting'` (0.3.234)** — a peer `origin` injected by the host may declare the sending session's permission class, so a same-class message is delivered to a recipient that runs without asking.

### Usage, cost, telemetry

33. **`modelUsage[*].costBasis: 'list' | 'managed' | 'unknown'` (0.3.246)** — which price table each model's `costUSD` was computed from.
34. **`ModelUsage.thinkingTokens` (0.3.257)** — a subset of `outputTokens`.
35. **`AgentOutput.usage.output_tokens_details` carried through (0.3.228)** — on Agent tool results.
36. **Remote-session latency breakdown on success results (0.3.260)** — `first_content_frame_ms`, `first_stream_post_ms`, `first_stream_post_ack_ms`, `first_stream_post_wall_ms`.
37. **`rate_limit_event` re-emits during an exceeded window (0.3.260)** — on repeat 429s, about once per 30 s per limit window, so stream consumers can refresh stale rate-limit state.

### System init and origins

38. **`terminal_slash_commands?: string[]` on `system/init` (0.3.229)** — so remote-control clients can hide terminal-oriented commands.
39. **`SDKSystemMessage.effort` (0.3.234)** — the session's applied effort level, or `null` when none is sent. Set on Remote Control bridge init frames.
40. **`initialize` response `hooks_applied` (0.3.238)** — reports whether hook callbacks actually took effect after a re-sent `initialize`.
41. **`origin.subkind: 'projects-relay'` and prompt `source: 'poll_event'`** — two new provenance values on existing open unions.

### Browser SDK (not used by DorkOS)

42. **SSE transport additions (0.3.267)** — `getCcrEvent(query, message)`, `getSseLastSequenceNum(query)`, plus `fromSequenceNum`, `onCatchUpTruncated` and `onDeliveryUpdate` SSE options.

---

## Fixes 🔧

| Version | Fix                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.3.225 | Background subagents in headless/SDK sessions never resuming when a background shell command or Monitor they left running completed                                             |
| 0.3.238 | SDK hook callbacks silently not applying after a host re-sends `initialize` to an already-running CLI                                                                           |
| 0.3.238 | `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` not keeping `prompt_suggestion` messages on when the account is near, but not over, its usage limit                                 |
| 0.3.239 | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in an array `systemPrompt` sent to the model as literal text on Bedrock, Vertex, Foundry and gateway providers                                 |
| 0.3.239 | A result held back for background subagents in one-shot mode reporting the turn-end snapshot of `total_cost_usd`/`duration_api_ms`/`modelUsage`                                 |
| 0.3.243 | `mcp_status` reporting a remote MCP server as connected after its connection dropped                                                                                            |
| 0.3.247 | Per-turn `system/init` `permissionMode` reporting the mode at turn start instead of the live mode                                                                               |
| 0.3.257 | `mcp_reconnect` / `mcp_toggle` acting on a same-named `.mcp.json` / `~/.claude.json` server instead of the `--mcp-config` or `mcp_set_servers` one                              |
| 0.3.257 | `mcp_toggle` disable also removing the tools of a sibling MCP server whose name extends the disabled one's                                                                      |
| 0.3.257 | The browser SDK bundle never streaming any messages on engines without native `Symbol.dispose`                                                                                  |
| 0.3.257 | A background Bash task still running when a stream-json session ends right after an interrupt never receiving its final `task_notification`                                     |
| 0.3.257 | `-p` giving up on a long-running background subagent without stopping it, so `background_tasks_changed` kept listing it and events arrived after `stopped`                      |
| 0.3.257 | Result-message `usage.output_tokens_details.thinking_tokens` reporting 0 instead of the session's real count                                                                    |
| 0.3.260 | `managedSettings` `disableAutoMode: "disable"` (either spelling) dropped by the restrictive-only filter instead of turning auto mode off                                        |
| 0.3.260 | `rewindFiles()` reporting success when no files could be restored                                                                                                               |
| 0.3.261 | `query()` throwing "Object not disposable" in runtimes without native `Symbol.dispose` — Node ≤22 `vm` contexts (Jest `node` env, vitest `vmThreads`/`vmForks`) and Node <18.18 |
| 0.3.261 | Windows start failures with many plugins (the launch command line growing past the limit) — addressed by `pluginDelivery: 'initialize'`                                         |
| 0.3.265 | Multi-turn sessions resetting the shell working directory to the `cwd` option at each new user message                                                                          |
| 0.3.265 | `user_message_uuid` missing from the success result of a turn that sent no API request, such as a slash command                                                                 |

---

## Performance ⚡

1. **`getContextUsage({ detail: 'summary' })` (0.3.257)** — answers from the last response's usage and local estimates, skipping every per-category token-count API call.
2. **`pluginDelivery: 'initialize'` (0.3.261)** — plugins over stdin instead of argv; the launch command line stops growing with plugin count.
3. **`reloadPlugins({ holdOnCacheImpact })` (0.3.268)** — avoids invalidating the session's prompt cache; the held response quantifies the cost via `estimated_cache_write_usd`.
4. **`subagentPromptCacheTtl` / `cache_ttl: '5m' | '1h'`** — cache-TTL controls newly surfaced in the settings and usage types.

---

## Internal ⚪

- **17 pure parity releases** (see header) with no SDK-surface note of their own. They still move the bundled CLI binary.
- **Two non-exported control-request types deleted** — `SDKControlGetPlanRequest`, `SDKControlGetWorkspaceDiffRequest`.
- **Doc-only clarifications** on `Options.agents[].model` ("Model alias … or full model ID") and on the MCP tool-call timeout paragraph, both reworded without behavior change.
- **`bridge.d.ts`** grew 296 → 378 lines and **`browser-sdk.d.ts`** 107 → 184 lines; neither subpath is imported by DorkOS.
- **`sdk-tools.d.ts`** grew 3831 → 4170 lines — built-in tool input/output schemas, tracking the CLI's own tools.
- **Packaging unchanged**: same 8 platform optional-dependency packages, same `peerDependencies` (`@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`), same `engines.node >=18.0.0`, same six `exports` subpaths (`.`, `./extract`, `./browser`, `./bridge`, `./sdk-tools`, `./sdk-tools.js`). Nothing added, nothing removed.
