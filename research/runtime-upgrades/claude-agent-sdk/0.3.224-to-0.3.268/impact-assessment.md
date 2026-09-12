# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.3.224 → 0.3.268

**Generated**: 2026-09-11
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`), enforced by ADR-0089 / Hard Rule 2
**Related ADRs**: 0089 (SDK import confinement), 0143 (retry depth over circuit breaker), 0239 (plugin activation via `options.plugins`), 0240 (permission-mode passthrough)
**Companion**: [`changelog.md`](./changelog.md)
**Predecessor**: [`../0.3.177-to-0.3.224/impact-assessment.md`](../0.3.177-to-0.3.224/impact-assessment.md)

## Summary

| Category                           | Count | Action Required                                                                       |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| Breaking changes — compile-level   | 0     | None. Verified by type diff against every DorkOS call site                            |
| Breaking changes — behavioral      | 3     | **Decide before bumping** (todo/task tools; multi-turn cwd; interrupt scope)          |
| Breaking changes — silent gap      | 1     | Fix in-bump (three new assistant error values never surface to the user)              |
| Breaking changes — stale invariant | 1     | Fix in-bump (`session-turn-windows.ts` doc + rule keyed on a fact that just flipped)  |
| Breaking changes — no DorkOS usage | 10    | No action (documented so the next upgrade need not re-derive)                         |
| Deprecations                       | 0     | Nothing to migrate                                                                    |
| Features (high)                    | 5     | 3 adopt in-bump, 2 separate spec                                                      |
| Features (medium)                  | 8     | Evaluate; 3 are cheap in-bump wins                                                    |
| Features (low/none)                | 29    | No action                                                                             |
| Fixes resolving DorkOS issues      | 5     | Auto-resolved by the bump                                                             |
| Stale version-pinned anchors       | 6     | Re-stamp or re-verify (4 files carry dated binary reads; 7 `sdk.d.ts:LINE` citations) |

**Overall risk: MEDIUM–HIGH.** Zero compile breaks — but this range contains the worst kind of change for a host like DorkOS: a tool the model used to have by default is now absent unless asked for, and nothing anywhere reports it. The todo/task-tool default change alone silently empties a whole DorkOS surface. The previous bump's two behavioral risks were "decide and document"; this bump has one that is "fix or lose a feature".

**Estimated total effort**: **4–7 hours** for the bump — 7 pin sites, the three behavioral decisions, two small in-bump fixes, the anchor re-stamping, conformance suite, and a browser-verified turn. Plus **1–2 hours** for the three recommended cheap feature adoptions. The two high-relevance features flagged `separate spec` are not bump scope.

---

## Surface-map drift found

`.claude/config/runtime-deps.json` `sdk_surface_map` drifted again — some of it is drift the previous assessment already reported and that was applied only partially, some is new. **Reported, not edited**, per the task brief. The reality below is a full enumeration produced by parsing every `import … from '@anthropic-ai/claude-agent-sdk'` in `apps/server/src` (45 non-test files; **25 distinct SDK symbols**).

### Corrections to existing entries

| Config claim                                                                                     | Reality                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"query()": "messaging/message-sender.ts"`                                                       | ⚠️ Incomplete — **4 files**: `claude-code-runtime.ts`, `sessions/pump-launch.ts`, `messaging/runtime-cache.ts`, `messaging/message-sender.ts`                                                                                                                                                     |
| `"SDKMessage": "sdk/sdk-event-mapper.ts"`                                                        | ⚠️ Badly incomplete — **14 files**: `sessions/{session-pump,pump-turn-stream,session-pump-contract,session-turn-windows,persistent-dispatch}.ts`, `sdk/sdk-event-mapper.ts`, `sdk/event-mappers/*.ts` (4), `media-capture.ts`, `messaging/{turn-liveness,message-sender,phantom-cancellation}.ts` |
| `"Options": "messaging/message-sender.ts"`                                                       | ❌ Wrong file set — **3 files**, and `message-sender.ts` is not one of them: `sessions/launch-fingerprint.ts`, `sessions/pump-launch.ts`, `messaging/launch-resolver.ts`                                                                                                                          |
| `"McpServerConfig": "mcp-server-config.ts, claude-code-runtime.ts, messaging/message-sender.ts"` | ⚠️ Third file is wrong — **4 files**: `claude-code-runtime.ts`, `sessions/launch-fingerprint.ts`, `mcp-server-config.ts`, `messaging/message-sender-shared.ts`                                                                                                                                    |
| `"renameSession()": "claude-code-runtime.ts"`                                                    | ✅ Correct                                                                                                                                                                                                                                                                                        |
| `"forkSession()": "sessions/session-store.ts"`                                                   | ✅ Correct                                                                                                                                                                                                                                                                                        |
| `"tool(), createSdkMcpServer()": "mcp-tools/*.ts (13 files …)"`                                  | ✅ Correct — `tool` in all 13, `createSdkMcpServer` in `mcp-tools/index.ts` only                                                                                                                                                                                                                  |

### Entries the map still omits entirely

| SDK surface                               | Files                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Query`                                   | **9**: `agent-types.ts`, `sessions/{session-pump-contract,persistent-dispatch,session-store,pump-launch}.ts`, `sdk/{subscription-usage,context-usage}.ts`, `messaging/{launch-probes,runtime-cache}.ts` |
| `PermissionUpdate`                        | **4**: `sessions/session-store.ts`, `messaging/{interactive-handlers,always-allow-scope,interaction-wait}.ts`                                                                                           |
| `PermissionUpdateDestination`             | `sessions/session-store.ts`, `messaging/always-allow-scope.ts`                                                                                                                                          |
| `ElicitationRequest`, `ElicitationResult` | `messaging/interactive-handlers.ts`, `messaging/interaction-wait.ts`                                                                                                                                    |
| `McpServerStatus`                         | `messaging/launch-probes.ts`, `messaging/message-sender-shared.ts`                                                                                                                                      |
| `getSessionInfo()`                        | `sessions/transcript-reader.ts`                                                                                                                                                                         |
| `PermissionMode`, `SdkPluginConfig`       | `sessions/launch-fingerprint.ts`                                                                                                                                                                        |
| `SpawnOptions`, `SpawnedProcess`          | `sessions/tracked-spawn.ts`                                                                                                                                                                             |
| `SDKControlGetUsageResponse`              | `sdk/subscription-usage.ts`                                                                                                                                                                             |
| `SDKControlGetContextUsageResponse`       | `sdk/context-usage.ts`                                                                                                                                                                                  |
| `PermissionResult`                        | `messaging/interactive-handlers.ts`                                                                                                                                                                     |
| `ModelInfo`                               | `messaging/runtime-cache.ts`                                                                                                                                                                            |
| `EffortLevel`, `ThinkingConfig`           | `messaging/thinking-config.ts`                                                                                                                                                                          |

### `non_import_couplings` — one to add, one to correct

The config lists four. All four were re-checked (results below). **Two amendments:**

1. **Add a fifth**: `sdk/sdk-error-mapping.ts` reasons about the CLI's own abort predicate — its nine-cause collapse and the two-member suppression set — read out of the shipped 0.3.224 binary and quoted at length in `research/20260903_claude-cli-aborted-refusal-shapes.md`, which carries a recipe for re-running it after an SDK bump. Same failure mode as the other four: no import, no grep hit, no failing test.
2. **The `plugin-activation.ts` entry should name the divergence, not just the mirroring.** The SDK's `SdkPluginConfig` gained an optional `skipMcpDiscovery?: boolean` in this range; the local `ClaudeAgentSdkPlugin` interface (`messaging/plugin-activation.ts:36`) does not have it. Harmless today — the mirror is structurally assignable — but it is the first time the two shapes have differed, which is exactly what the coupling note exists to catch.

**Also worth adding to `upgrade_notes`:** the pin is in **seven** places, not six. `apps/server/src/services/runtimes/claude-code/tooling/provision.ts:50` declares `export const CLAUDE_SDK_VERSION = '0.3.224'` — the on-demand CLI provisioner's version — and its own TSDoc says a bump must move it in lockstep, with a test going red otherwise. The previous assessment's pin table listed only the six manifest entries.

---

## Detailed breaking-change impact

### 1. Task and Todo tools left the default surface (0.3.233, refined 0.3.268) — **behavioral, decide before bumping, HIGHEST RISK IN THE BUMP**

Upstream removed `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` / `TodoWrite` from the default tool set on Opus 4.8, Sonnet 5, Fable 5, Mythos 5 and newer. 0.3.268 restated it as a positive list: default **only** on Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5. Elsewhere you must name them in `tools`, reference them in `allowedTools`, or set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.

- **DorkOS exposure: direct and total.** DorkOS builds its entire task/todo surface by watching those exact tool names go past:
  - live: `sdk/event-mappers/stream-event-mapper.ts:135-136` → `buildTaskEvent` / `buildTodoWriteEvent` (`sdk/build-task-event.ts:8` lists `'TodoWrite'`, `'TaskCreate'`, `'TaskUpdate'` as the trigger set);
  - hydration: `sessions/task-reader.ts:50-60` walks the same three tool_use block names out of the transcript;
  - transcript fallback: `sessions/transcript-reader.ts:982`;
  - client: `features/chat/model/{use-todo-events,use-task-state,use-celebrations}.ts`.
- **DorkOS sets neither `tools` nor `allowedTools`.** `messaging/launch-resolver.ts:457` says so explicitly — _"Nothing here sets `allowedTools`, on purpose (DOR-519)"_ — and `tooling/tool-filter.ts:14-62` is a long, deliberate argument for why nothing ever should: `allowedTools` is an auto-approval list, not an access list, and putting names in it widens auto-approval. So the shortest upstream-suggested lever (`allowedTools`) is the one this codebase has a standing, well-argued decision against.
- **Failure mode**: nothing errors. The tools are absent, the model never calls them, `buildTaskEvent` is never reached, and the todo panel and Tasks surface stay empty forever. No test fails: every existing test feeds fixture tool_use blocks, which will keep arriving in fixtures long after they stop arriving from a real model.
- **Effort**: **trivial (1 line)** for the env-var route — `CLAUDE_CODE_ENABLE_TODO_TOOLS: '1'` in the env object `messaging/launch-resolver.ts:298` already builds (`runtimeEnvironment('claude-code', 'turn', { … })`), which is also the mechanism `contributing/adding-a-runtime.md` already documents for the subagent-depth escape hatch. **Moderate** for the `tools` route, which means taking a position on the base tool set DorkOS has so far never taken.
- **Recommendation**: **set the env var in-bump**, and record the decision in `contributing/adding-a-runtime.md` beside the subagent-depth note, for the same reason: it is a behavior change no compiler catches and the next bump should not re-derive it. Reaching for `allowedTools` would contradict DOR-519's finding; reaching for `tools` re-centralises a list of names in an SDK option, which `tool-filter.ts` argues against in its own words.
- **Verification**: this one cannot be verified by a test. Run one real turn on the default model and confirm a todo list renders.
- **ADR conflict**: none. ADR-0070 is already superseded by ADR 260726-171347 on this ground.

### 2. Multi-turn sessions no longer reset the shell cwd each turn (0.3.265) — **behavioral, decide before bumping**

Previously each user message reset the shell working directory to the `cwd` option; now an agent's `cd` persists across turns.

- **DorkOS exposure**: the persistent session pump (`sessions/persistent-dispatch.ts`, spec `persistent-session-runtime`, DOR-1175) is exactly the multi-turn shape this describes — one CLI process, many turns. DorkOS passes `cwd: effectiveCwd` once at launch (`messaging/launch-resolver.ts:277`, `sessions/pump-launch.ts:112`) and boundary-validates `effectiveCwd` per dispatch (`persistent-dispatch.ts:384` logs `'[persistent-dispatch] boundary violation'`).
- **Why it matters**: the per-turn boundary check validates the cwd DorkOS _intends_. Before 0.3.265 the SDK reset the shell to that value at every turn, so intent and reality re-converged each turn for free. After it, they can diverge: a `cd` in turn 3 is still in effect at turn 30, and the boundary validator keeps approving the unchanged `effectiveCwd` while commands run somewhere else. This does not grant new access — `lib/boundary.ts` gates what a tool may touch, not where a shell sits — but it does mean the validated value stops describing the session.
- **Effort**: **zero lines** to keep working; **trivial** to re-assert per turn if the divergence is unwanted. The non-code cost is a decision and a comment.
- **Recommendation**: accept the new behavior (it matches the interactive app, which is the behavior an operator expects), and add a sentence to `persistent-dispatch.ts` saying the boundary check validates intent rather than the shell's live location, so nobody later reads it as the stronger claim.
- **ADR conflict**: none.

### 3. `interrupt()` stops background agents and workflows by default (0.3.246) — **behavioral, decide before bumping**

New `perTaskStopAffordance` option: when set, `interrupt()` aborts only the current turn and keeps background agents and workflows running. Otherwise they stop.

- **DorkOS exposure**: DorkOS already treats interrupt receipts as a first-class mechanism — `sessions/session-store.ts:844` ("Tries `query.interrupt()` first…"), `:914` awaits a `ControlAck`, `sessions/bounded-control.ts` bounds it, and `services/rooms/room-trigger.ts:4267,:4427` consume receipts for room turns. The 0.3.219 `cancel_queued` work was adopted.
- **What changed**: the SDK named a default DorkOS was already living under and gave it a lever. Nothing breaks. The question is a product one: when an operator presses Stop in a session whose agent has background subagents running, should those die? DorkOS's stated posture — an operator pressing Stop and work continuing is "the single most damaging trust failure" (previous assessment) — argues **keep the default**.
- **Effort**: **zero** to accept; **trivial** to opt out.
- **Recommendation**: accept the default (Stop means stop), record it, and revisit only if background-agent workflows become a headline feature.
- **ADR conflict**: none.

### 4. Three new `SDKAssistantMessageError` values never reach the user — **silent gap, fix in-bump**

`SDKAssistantMessageError` gained `'account_on_hold'`, `'verification_required'`, `'cloud_credential_error'`.

- **DorkOS exposure**: `sdk/sdk-error-mapping.ts:113` declares `SURFACED_ASSISTANT_ERRORS` as a **hand-maintained `Set`** of six strings, and `sdk/event-mappers/message-event-mapper.ts:129` gates every assistant-error card on `SURFACED_ASSISTANT_ERRORS.has(assistantError)`. A value absent from the set is dropped on the floor.
- **Consequence**: after the bump, a user whose Claude account is on hold, whose account needs verification, or whose Bedrock/Vertex credential failed gets **no error card at all** — the turn just ends. That is a direct violation of the honest-by-design filter, and it is the kind of failure a person cannot debug.
- **Which of the three belong in the set**: all three. None of them is double-reported by the `api_retry`, `rate_limit_event`, or `stop_reason === 'max_tokens'` channels the set's TSDoc lists as its exclusion criteria, and all three are actionable by the person.
- **Effort**: **trivial (3 lines + a line of TSDoc)**. `describeAssistantError` needs a branch for each so the card says something useful; `describeAuthError` (`@dorkos/shared/runtime-error-classification`) is the natural home for the two credential-shaped ones.
- **ADR conflict**: none.

### 5. `SDKResultError` now declares `user_message_uuid` — **stale invariant, fix in-bump**

- **DorkOS exposure**: `sessions/session-turn-windows.ts` is a load-bearing correlation subsystem, and its module doc states the invariant outright at lines 37-40: _"`SDKResultError` — every `error_during_execution`, `error_max_turns`, `error_max_budget_usd` result — has NO `user_message_uuid` field at all (`sdk.d.ts`, `SDKResultSuccess` declares it, `SDKResultError` does not)."_ Line 412 repeats it: _"the absence on `SDKResultError` is a fact this module's correlation rules turn on."_ **At 0.3.268 `SDKResultError` declares `user_message_uuid`, `user_message_uuids`, `resume_reason`, `result_index` and `queued_turn_count`.** The claim is now false.
- **Is the code broken?** No — and this is the good news. `readAnsweredId()` (`:415`) reads the field **defensively off `SDKMessage`**, not by type narrowing, precisely so it does not depend on which branch declares what. The four-row handling table covers a named error result under row 1 or row 3 rather than row 2. So the behavior is correct; the _reasoning_ recorded in the file is wrong, and the next person to edit this module will edit it against a false premise.
- **Behavior shift to expect**: error results that used to fall through row 2 ("no uuid at all → terminate whatever window is open") will now mostly land in row 1 ("answers this dispatch → close it"). That is a **better** outcome — it is the correlation the module wanted and could not get — but it is a different code path, and the module's own tests should be read for any that encode the absence.
- **Effort**: **trivial-to-moderate** — rewrite the two doc passages, then check the module's tests for a fixture that asserts the absence. Do not delete the defensive read: it is what made this a documentation problem instead of an outage.
- **ADR conflict**: none.

### 6–15. Breaking changes with zero DorkOS exposure — **verified, no action**

Each checked against real call sites, not assumed:

| Change                                                     | Why it does not affect DorkOS                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExitReason` loses `'bypass_permissions_disabled'`         | Zero references to `ExitReason`, `EXIT_REASONS`, or the literal anywhere in `apps/server/src`                                                                                                                                                                                                                                                              |
| `ApiKeySource` widened                                     | Zero references to the type. The `apiKeySource` DorkOS reads (`tooling/claude-cli-auth.ts:84`, `tooling/check-dependency.ts:198`) is a plain `string` off the CLI's `auth status` JSON. `scripts/harness-smoke/` already asserts the NEW values (`'ANTHROPIC_API_KEY'`, `'none'`) because it read them off a live CLI — the type was simply behind reality |
| `SDKContextUsageCategory.kind` now required                | `sdk/context-usage.ts` only **reads** the response; it never constructs one. A required added field on a read-only type is free                                                                                                                                                                                                                            |
| Subagent MCP `tool_result` `_meta` frame shape             | DorkOS reads `tool_use_result` content generically in `message-event-mapper.ts`; it has no bare-value assumption for the subagent-MCP case                                                                                                                                                                                                                 |
| `terminal_reason` `image_error` → `api_error` for >32 MB   | Zero references to `'image_error'`. The 9 `terminal_reason` sites go through `isInterruptedTerminalReason` and a default fallback                                                                                                                                                                                                                          |
| `command_lifecycle` gains `refused`                        | Zero references to `command_lifecycle` (unchanged since the last bump)                                                                                                                                                                                                                                                                                     |
| `vcs_state_changed` one event per pushed branch            | Zero references to `vcs_state_changed`                                                                                                                                                                                                                                                                                                                     |
| Managed `disableAllHooks` scope narrowed                   | Zero references to `disableAllHooks`; DorkOS ships no managed settings                                                                                                                                                                                                                                                                                     |
| `rewindFiles()` fails on zero restores                     | Zero call sites for `rewindFiles`                                                                                                                                                                                                                                                                                                                          |
| `total_cost_usd` includes the 1.1× US-inference multiplier | `sdk/event-mappers/result-event-mapper.ts` already reads `modelUsage` and sums across models rather than trusting `total_cost_usd` (the choice the previous assessment confirmed). The multiplier lands in `costUSD` too, so reported costs rise 10% on US-inference responses — that is correct reporting of a real charge, not a DorkOS bug              |
| Internal `get_plan` / `get_workspace_diff` types removed   | Never exported; zero references                                                                                                                                                                                                                                                                                                                            |
| `mcp_set_servers` lists throwing servers under `added`     | Zero `setMcpServers` call sites — the name appears once as a string in `sessions/session-pump-contract.ts:151`, a control-name union, not a call                                                                                                                                                                                                           |
| Sandbox-settings Zod `ZodPipe` → `ZodPreprocess`           | DorkOS does not import or construct those schemas                                                                                                                                                                                                                                                                                                          |
| `error_max_structured_output_retries` message text         | DorkOS does not set `structured_output`; `sdk-error-mapping.ts` switches on `subtype` with a `default` fallback and never reads the text                                                                                                                                                                                                                   |

---

## Deprecation migrations

**None.** `sdk.d.ts` carries the same five `@deprecated` annotations before and after, on the same symbols — verified by diffing the annotated declarations in both tarballs. DorkOS uses none of them (confirmed at the previous bump; nothing changed). Nothing to migrate.

---

## Recommended feature adoptions

### HIGH — `user_message_uuids` (plural) closes the coalescing hole windowing was built around (0.3.259) — _adopt in-bump_

- **What**: a turn's first reply frame and its result now carry `user_message_uuids: string[]` beside the singular field — **every** user message the turn answered.
- **Why it matters to DorkOS**: `sessions/session-turn-windows.ts` exists because "the nth result answers the nth message" is false once the CLI coalesces a dequeued batch into one turn. Its whole design — a window carrying a _set_ of ids, closed as a whole by one result naming _one_ of them — is a careful inference from a single uuid. The plural field replaces that inference with the actual answer: the SDK now names every message the turn absorbed. It also directly addresses the DOR-1294 case (row 3 of the module's table), where a steer pushed at the tail of a turn is answered in the _next_ turn coalesced with others — with `user_message_uuids`, that result names both.
- **Effort**: **moderate (6–30 lines)** — read the plural field when present, fall back to the singular, and close every named window rather than inferring the set. The tests for the four-row table are where the work is.
- **Recommendation**: adopt in-bump, at the same time as the row-2 doc correction (breaking change 5), because both touch the same forty lines and the second one makes the first easier to reason about.

### HIGH — `queued_turn_count` on results (0.3.243) — _adopt in-bump_

- **What**: how many queued user sends were still pending when the result was produced.
- **Why it matters to DorkOS**: the persistent pump's hardest question is "is this session done, or is another turn coming?" — the question `session-turn-windows.ts` answers today by tracking ids this session sent and has not seen answered. `queued_turn_count > 0` is the CLI telling you directly. It is also the missing input for an honest idle indicator: an operator watching a session that looks finished while three messages are queued is exactly the trust failure the product filter cares about.
- **Effort**: **trivial-to-moderate** — one field read on the result, one piece of session state, one event field.

### HIGH — `pluginDelivery: 'initialize'` (0.3.261) — _adopt in-bump_

- **What**: sends `plugins` over stdin instead of on the launch command line. Upstream ships it explicitly as the fix for **Windows start failures with many plugins**.
- **Why it matters to DorkOS**: ADR-0239 puts plugin activation squarely on `options.plugins`, and `messaging/plugin-activation.ts` builds that array from every enabled marketplace plugin — an unbounded, user-controlled count, each entry an absolute path under `<dorkHome>/plugins/<name>`. Windows has a hard command-line length limit. DorkOS ships a Windows x64 alpha that is **built and code-reviewed but not confirmed by a real end-user install**, so this is a failure mode nobody would have caught: the app starts fine with two plugins and refuses to start with fifteen, on the one platform with no confirmed install to notice.
- **Effort**: **trivial (1 line)** in `messaging/launch-resolver.ts`'s options object.
- **Caveat**: it changes how the CLI receives plugins, so verify one plugin-loading session after setting it — ADR-0239's stated negative is that the SDK pin is load-bearing for plugin runtime correctness.
- **Recommendation**: adopt in-bump on every platform, not just Windows. There is no argument for keeping an argv path that grows without bound.

### HIGH — `SDKContextUsageCategory.kind` replaces a display-name string match (0.3.268) — _adopt in-bump, trivial_

- **What**: every `get_context_usage` category now carries `kind: 'used' | 'free' | 'buffer' | 'deferred'`, and the SDK's own doc on `name` says _"Use `kind` (not this name) to classify the row."_
- **Why it matters to DorkOS**: `sdk/context-usage.ts:44` filters with `.filter((c) => !c.isDeferred && c.name !== 'Free space')` — a match on the CLI's **display string**. That is a latent break on any wording change, in a file whose own TSDoc already explains that the SDK's category colors are theme tokens it cannot trust. `kind === 'used'` is the same filter, stated correctly, and it also picks up the `'buffer'` rows the name match never knew about.
- **Effort**: **trivial (1 line)**. Decide deliberately whether `'buffer'` (the compaction reserve) belongs in the status-bar breakdown — it is real occupancy, and the existing filter silently included or excluded it depending on its display name.

### HIGH — `Query.reloadPlugins({ holdOnCacheImpact })` (0.3.268) — _separate spec_

- **What**: the CLI runs the check interactive `/reload-plugins` makes — when applying would change the session's tool list while the conversation's prompt cache depends on it, nothing is applied and the response carries `held: true` with `cache_impact` (`mcp_servers_added`, `lsp_tool_change`, `estimated_cache_write_usd`).
- **Why it matters to DorkOS**: `reloadPlugins` has **23 call sites** in `apps/server/src` — it is how the marketplace install half (ADR-0239) tells a live session about a plugin it just installed. Today every one of those reloads silently pays the cache invalidation. `estimated_cache_write_usd` turns that into a number DorkOS could show, or spend deliberately. "Installing this now will cost about $0.04 in cache rebuild — install now, or at the next natural break?" is a control-panel affordance the product's own positioning asks for.
- **Effort**: **significant** — the call is one option, but the product question (who decides, and how is it shown) is a spec.

### MEDIUM — `getContextUsage({ detail: 'summary' })` (0.3.257) — _evaluate, good fit_

`sdk/context-usage.ts:64` wraps `getContextUsage()` in a `Promise.race` against a timeout, with a TSDoc explaining the timeout exists so "a stuck control channel can never hang the stream." The dominant cost inside `'full'` is the per-category token-count API calls; `'summary'` answers from the last response's usage and local estimates without them. That is a cheaper, less stall-prone call for a status-bar indicator that does not need exact per-category counts. **Effort: trivial.** Worth measuring both before switching, since `'summary'` is an estimate.

### MEDIUM — `createSdkMcpServer({ timeout })` (0.3.248) — _evaluate_

`mcp-tools/index.ts` creates the one in-session DorkOS tool server. Today its tool-call ceiling is the process-wide `MCP_TOOL_TIMEOUT`, which `messaging/launch-resolver.ts` already has to defend against being inherited too short (there is a comment about exactly that, beside the in-session approval hold). A per-server timeout lets the DorkOS server declare its own bound directly instead of fighting an env var. **Effort: trivial-to-moderate.**

### MEDIUM — `permissionPrompts: 'none'` (0.3.259) — _evaluate_

Auto-denies permission prompts in sessions with nobody to answer them, **without** disabling auto mode's classifier. DorkOS runs plenty of sessions with no human attached — room turns, scheduled tasks, relay-triggered work. Today `messaging/interactive-handlers.ts` auto-denies on abort and on timeout, which gets the same outcome by waiting first. Declaring it up front is honest, faster, and keeps the classifier. **Effort: moderate** — the real work is deciding which DorkOS session kinds count as unattended, which is a product question the consent-led autonomy work already has opinions about.

### MEDIUM — `classifierContext` on `PostToolUse` hooks (0.3.236) — _evaluate_

A short host-asserted note about a tool call's result that the **auto mode** permission classifier reads. DorkOS ships `permissionMode: 'auto'` and has a whole guard for it (`messaging/permission-mode-guard.ts`). This is the first lever DorkOS has ever had to tell the classifier something it cannot see — e.g. that a tool result came from a DorkOS-owned MCP tool that already ran its own tier gate (`core/mcp-tool-gate.ts`). **Effort: moderate**; DorkOS registers `PreToolUse` only today, so a `PostToolUse` hook is new wiring. Strategically interesting: it is the supported way to make auto mode smarter without widening auto-approval lists, which is the thing DOR-519 taught this codebase to distrust.

### MEDIUM — `resume_reason` + `local_command` + `result_index` on results (0.3.268) — _adopt with the correlation work_

Three small result fields that all serve the same subsystem as the two HIGH correlation items. `resume_reason` is set **only** on the automatic re-run of a host-restart-interrupted turn — which is precisely the "a turn nobody in this session asked for" case that `session-turn-windows.ts` handles today by minting a synthetic `origin: 'runtime'` window. `local_command` names the slash command on a turn that never entered the model loop. `result_index` gives delivery order within a run. **Effort: trivial** if done alongside `user_message_uuids`; three more field reads on the same object.

### MEDIUM — `ambient`, `is_backgrounded`, `spawn_depth` on task events (0.3.238, 0.3.247) — _evaluate_

`sdk/event-mappers/system-event-mapper.ts` maps background-task events into the activity surfaces. `ambient` marks housekeeping tasks a host should exclude from activity indicators — directly relevant to `meta/agent-etiquette.md`'s "present, useful, and mostly quiet" standard, since a spinner for a housekeeping task is exactly the over-participation users complain about. `spawn_depth` pairs with the subagent depth cap this codebase already made a decision about at the last bump. **Effort: moderate** (needs a UI surface).

### MEDIUM — `ModelUsage.thinkingTokens` + `costBasis` (0.3.246, 0.3.257) — _cheap_

`result-event-mapper.ts` already reads `modelUsage` and sums across models. `thinkingTokens` (a subset of `outputTokens`) and `costBasis` (`'list' | 'managed' | 'unknown'`) are two more fields on an object DorkOS already walks. `costBasis` is the honest-by-design one: it says whether a reported cost came from the real price table or a host-managed one. **Effort: trivial.**

### MEDIUM — `user_message_uuid` on `thinking_tokens` system messages (0.3.260) — _cheap_

`system-event-mapper.ts:270` already handles the `thinking_tokens` subtype. The new field attributes thinking progress to a turn window, which the pump needs for the same reason it needs it on results. **Effort: trivial**, and it falls out of the correlation work.

### LOW / NONE — no action (29 items)

`terminal_slash_commands`, `SDKSystemMessage.effort`, `origin.fromMode`, `origin.subkind: 'projects-relay'`, prompt `source: 'poll_event'`, `hooks_applied` on the initialize response, `pending_permission_requests` always present, `background_tasks_changed` after a repeated `initialize`, `canUseTool` `defaultToNo` / `suppressAlwaysAllowRule`, `AgentOutput.usage.output_tokens_details`, the four remote-latency result fields, `rate_limit_event` re-emission, `SDKContextUsage` / `context_usage` on `/context` results, `Query.reloadOutputStyles()`, `SDKControlUpdateSettingsRequest`, `PreModelSwitch` / `PostModelSwitch` hooks, `suppressOriginalPrompt` on `UserPromptExpansion`, `managedSettings.modelPricing`, `SdkPluginConfig.skipMcpDiscovery`, `subagentPromptCacheTtl` / `cache_ttl`, `tool_use_result.resourceLinks` + `SDKMcpResourceLink`, `resource_links` on `task_notification`, the whole browser-SDK SSE surface (5 additions), `setModel()` API confirmation, `mcp_set_servers` `added` reclassification, and the `perTaskStopAffordance` opt-out itself.

Three worth a sentence:

- **`canUseTool` `defaultToNo` / `suppressAlwaysAllowRule`** — the SDK now lets the CLI tell the host how a prompt should open. DorkOS's permission cards are its own UI and it decides their shape itself, so these are hints it can ignore. Worth a look only if the "still asks" / green-unlocked work (full-power-by-default) ever wants the CLI's opinion.
- **`resourceLinks` / `SDKMcpResourceLink`** — MCP tools returning file references DorkOS could render without parsing text. Zero current usage (`resourceLinks`: 0 hits), and no DorkOS MCP tool returns `resource_link` blocks today. Free capability if one ever does.
- **`setModel()` confirming unknown ids with the API (0.3.268)** — this softens 0.3.200's hard refusal, which the previous assessment filed as "no impact today, latent hazard." The hazard is now smaller: a model id the CLI does not recognize costs a round trip instead of failing the call. DorkOS's ids come from `supportedModels()` via `messaging/runtime-cache.ts`, so it was never exposed either way.

---

## Behavioral changes no compiler catches — the standing list

Consolidated so the next bump can check them as a set. The first three are the ones this bump's decisions turn on; the rest are noted and verified as unexposed.

| #   | Change                                                           | DorkOS verdict                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task/Todo tools off the default surface (0.3.233, 0.3.268)       | **EXPOSED — must act.** Set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, or the Tasks/todo surface goes dark silently                                                                                                                                                                                        |
| 2   | Multi-turn shell cwd persists across turns (0.3.265)             | **EXPOSED — decide.** Persistent pump; accept and document the intent-vs-reality split                                                                                                                                                                                                             |
| 3   | `interrupt()` stops background agents by default (0.3.246)       | **EXPOSED — decide.** Recommend keeping the default (Stop means stop)                                                                                                                                                                                                                              |
| 4   | `user_message_uuid` emission cadence (0.3.265, 0.3.268)          | **EXPOSED — verify.** More uuid-bearing frames per turn; `session-turn-windows.ts` reads defensively, so likely fine, but its tests encode the old cadence                                                                                                                                         |
| 5   | `SDKResultError` now carries a uuid                              | **EXPOSED — doc fix.** See breaking change 5                                                                                                                                                                                                                                                       |
| 6   | Notification hooks fire for pending permission prompts (0.3.233) | Not exposed — DorkOS registers `PreToolUse` only (`messaging/launch-resolver.ts`); no `Stop` or `Notification` hook anywhere                                                                                                                                                                       |
| 7   | `mcp_status` pending-while-reconnecting (0.3.243)                | Touches the `mcp-revocation.ts` coupling — see below. Architecturally defended                                                                                                                                                                                                                     |
| 8   | `mcp_reconnect` / `mcp_toggle` retargeting (0.3.257)             | Not exposed — zero call sites for either                                                                                                                                                                                                                                                           |
| 9   | `setModel()` confirms unknown ids with the API (0.3.268)         | Not exposed — ids come from `supportedModels()`                                                                                                                                                                                                                                                    |
| 10  | Per-turn `system/init` `permissionMode` now live (0.3.247)       | Not exposed as a break; strictly more accurate for anything reading it                                                                                                                                                                                                                             |
| 11  | Agent tool calls emit `tool_progress` heartbeats (0.3.257)       | `stream-event-mapper.ts` already maps `tool_progress`; new frames carry `heartbeat: true` and are additive                                                                                                                                                                                         |
| 12  | Systemprompt `snapshot` defaults on (0.3.267)                    | Low exposure — `sessions/launch-fingerprint.ts:147` declares `systemPromptAppend: 'relaunch'`, so DorkOS restarts the session on an append change rather than mutating it mid-session. The new default changes nothing for the path DorkOS takes. Verify one relaunch-on-append-change turn anyway |

---

## The four (now five) non-import couplings — re-checked individually

### 1. `sessions/project-slug.ts` — the session-slug hash — **UNCHANGED, no action**

Re-diffed the shipped `sdk.mjs` of both versions. The algorithm is byte-identical; only minified identifiers moved.

|            | 0.3.224 (`sdk.mjs`)                                                                          | 0.3.268 (`sdk.mjs`)                                                                          |
| ---------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Max length | `var ro=200`                                                                                 | `var Os=200`                                                                                 |
| Hash       | `function Zb(e){let t=0;for(let r=0;r<e.length;r++)t=(t<<5)-t+e.charCodeAt(r)\|0;return t}`  | `function gC(e){let t=0;for(let n=0;n<e.length;n++)t=(t<<5)-t+e.charCodeAt(n)\|0;return t}`  |
| Base36     | `function tSe(e){return Math.abs(Zb(e)).toString(36)}`                                       | `function A1e(e){return Math.abs(gC(e)).toString(36)}`                                       |
| Replace    | `function vE(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}`                                      | `function Au(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}`                                      |
| Slug       | `function jo(e){let t=vE(e);if(t.length<=ro)return t;return \`${t.slice(0,ro)}-${tSe(e)}\`}` | `function om(e){let t=Au(e);if(t.length<=Os)return t;return \`${t.slice(0,Os)}-${A1e(e)}\`}` |

`slugForCanonicalPath()` (`project-slug.ts:118-123`) — dash-replace, 200-char cut, base36 hash **of the original path, not the replaced string** — remains an exact mirror, with `PROJECT_SLUG_MAX_LENGTH = 200` at `:41`. The only textual difference in the hash body is the loop variable (`r` → `n`).

**Action**: update the module's version stamp (`project-slug.ts:13-26` currently narrates 0.3.177 → 0.3.224 with its minified names) to record the 0.3.268 re-check, and follow its own advice from the mcp-revocation note: **cite strings, not symbols** — the names moved again, exactly as predicted.

### 2. `messaging/plugin-activation.ts` — the plugin shape — **DIVERGED (harmlessly), note it**

`SdkPluginConfig` is still `{ type: 'local'; path: string }` plus a **new** optional `skipMcpDiscovery?: boolean`. The local mirror `ClaudeAgentSdkPlugin` (`plugin-activation.ts:36-39`) has the first two and not the third, so every value it builds is still assignable to `Options.plugins`. No break.

But this is the first divergence between the two shapes, and `skipMcpDiscovery` is not a field DorkOS should ignore forever: it says "load this plugin's skills/hooks/agents/commands but not its `.mcp.json`", which is exactly the split ADR-0239 draws between the half DorkOS owns (install) and the half the SDK owns (runtime). **Action: add the field to the mirror's TSDoc as deliberately-not-mirrored, or mirror it.** Effort: trivial.

### 3. `sdk/sdk-utils.ts` `resolveClaudeCliPath()` — platform packages — **UNCHANGED, no action**

Both tarballs declare the **same 8** optional dependencies, same names, version-locked to the SDK version: `-linux-x64`, `-linux-arm64`, `-linux-x64-musl`, `-linux-arm64-musl`, `-darwin-x64`, `-darwin-arm64`, `-win32-x64`, `-win32-arm64`. `engines.node` is `>=18.0.0` in both. The `exports` map is identical (6 subpaths, nothing added or removed). `resolveClaudeCliPath()` (`sdk-utils.ts:443`) resolves `${SDK_PKG}-${platform}-${arch}` by name and `CLAUDE_BIN` is still `claude` / `claude.exe`; nothing in the packaging moved.

The dead `platform === 'android'` branch the previous assessment flagged is **still dead** — there is still no `-linux-*-android` package among the 8. Unchanged finding, unchanged recommendation: delete it.

### 4. `services/mesh/mcp-revocation.ts` — MCP connect timing — **RE-DERIVE REQUIRED, moderate**

This is the coupling that most needs attention, for the same reason it did last time, and the module's own doc says so: _"Still unverified on 0.3.224: the live half. Nobody has re-run the two-server 401 harness against it."_ That is now two bumps unverified.

What this range changed on exactly that surface:

- **0.3.243** — `mcp_status` no longer reports a remote server as connected after its connection dropped; it reports **`pending` while reconnecting**, then `connected` or `failed`. The module's point 3 reasons about `pending` meaning "still connecting when the snapshot was taken." `pending` now means that **or** "reconnecting after a drop." That is a second meaning on the one status value the module's timing argument rests on.
- **0.3.257** — `mcp_reconnect` / `mcp_toggle` stopped acting on the wrong same-named server, and `mcp_toggle` stopped removing a name-prefixed sibling's tools. Neither is called by DorkOS (zero call sites), so neither changes DorkOS behavior — but both are evidence the CLI's MCP server-identity handling moved in this range.
- **`McpServerStatus` gained three fields** — `added: string[]`, `removed: string[]`, `errors: Record<string,string>` — appended after the existing shape. The module's recorded claim that the type is _byte-identical_ across versions is therefore **no longer true**, though the five-value `status` union is unchanged and `errorCode` still does not cross the SDK boundary, so **point 2 still holds by construction**.

**Why this stays a documentation problem, not a correctness one**: the module's design choice holds. The status report only decides _whether to look_; the arbiter is a live reachability probe that dials the server through the connection a turn would use. A `pending` that now means "reconnecting" still just means "look with the probe."

**The failure mode to watch is unchanged and is worth restating**: the committed fixture at `services/mesh/__tests__/fixtures/mcp-server-status-401.observed.json` is a static file. `mcp-revocation.test.ts:537` will pass no matter how stale the anchor gets. **The suite cannot tell you this went stale.**

**Action**: re-stamp the module's version narrative to 0.3.268, correct the byte-identical claim about `McpServerStatus`, and either re-run the documented two-server 401 harness (one real turn) or explicitly downgrade the live half to "observed on 0.3.177, unverified on 0.3.224 and 0.3.268." **Effort: moderate.**

### 5. `sdk/sdk-error-mapping.ts` — the CLI abort predicate — **NEW COUPLING, re-verify**

Not in the config's list; it should be. `sdk-error-mapping.ts:57-68` records a binary read of the CLI's own abort predicate — the nine-cause collapse, the two-member suppression set that puts `refusal-fallback-edit` and DorkOS's `interrupt()` in one bucket, and the `result` shapes an abort closes with — extracted from the 0.3.224 bundle and quoted in `research/20260903_claude-cli-aborted-refusal-shapes.md`, which carries a recipe for re-running it after a bump. `isStoppedTurn` (DOR-1320 / DOR-1684) decides whether a red error frame goes into the durable record of a turn a person stopped on purpose. Getting it wrong in either direction is user-visible.

**What in this range could move it**: 0.3.246's `perTaskStopAffordance` changes what an interrupt aborts, and 0.3.257 changed background-task teardown around interrupts twice (final `task_notification` after an interrupt; `-p` giving up on a background subagent). Both touch the abort paths the predicate enumerates.

**Action**: re-run the recipe in that research file against the 0.3.268 bundle. **Effort: moderate.** Like `mcp-revocation.ts`, the tests here are fixture-driven and will not go red on a stale anchor.

### Bonus: seven `sdk.d.ts:LINE` citations are now all wrong

`sdk.d.ts` grew 7429 → 8978 lines. Every line citation in the codebase now points at unrelated text:

| Citation             | Files                                                                 | What is there now           | Where it actually lives at 0.3.268 |
| -------------------- | --------------------------------------------------------------------- | --------------------------- | ---------------------------------- |
| `sdk.d.ts:196-205`   | `config/constants.ts:191`, `messaging/interaction-wait.ts:14`, `:434` | `type: OutputFormatType;`   | (elicitation timeout prose moved)  |
| `sdk.d.ts:4764`      | `sessions/session-pump.ts:384`, `sdk/sdk-utils.ts:59`, `:184`         | `kind: 'peer';`             | `shouldQuery?` at `:5504`, `:5580` |
| `sdk.d.ts:3618`      | `sdk/sdk-utils.ts:146`                                                | `mode?: 'form' \| 'url';`   | `isFoldInFlight` aside at `:4126`  |
| `sdk.d.ts:7069-7075` | `sdk/sdk-utils.ts:154`                                                | marketplace.json path prose | `additionalContext?` at `:2457`+   |

**Action**: re-point or de-line-number them. Given that this is the second bump in a row to invalidate all of them, the right fix is to cite the **symbol** (`SDKUserMessage.shouldQuery`) rather than the line — the same lesson `mcp-revocation.ts` already wrote down for minified symbols. **Effort: trivial.**

---

## Fixes resolving known DorkOS issues

### Auto-resolved by the bump

1. **0.3.261 — `query()` throwing "Object not disposable"** in runtimes without native `Symbol.dispose`, including **vitest `vmThreads`/`vmForks`**. `apps/server/vitest.config.ts` uses `environment: 'node'` with the default pool, so DorkOS is not on the affected path today — but this closes the door on a whole class of test-infra failure if a pool ever changes.
2. **0.3.225 — background subagents in headless/SDK sessions never resuming** when a background shell command or Monitor they left running completed. DorkOS runs headless SDK sessions exclusively and its orchestration patterns use background work; a subagent that never saw its result is a hang with no error.
3. **0.3.257 — a background Bash task still running when a stream-json session ends right after an interrupt never receiving its final `task_notification`.** DorkOS's Stop path (`session-store.ts:844`) is exactly "interrupt, then end the stream." This is the mechanism behind a stuck background-task indicator.
4. **0.3.257 — `-p` giving up on a long-running background subagent without stopping it**, so `background_tasks_changed` kept listing it and events for it arrived _after_ its `stopped` notification. Out-of-order events after a terminal frame are the specific hazard `system-event-mapper.ts`'s edge-derived background-task state cannot defend against.
5. **0.3.238 — SDK hook callbacks silently not applying after a re-sent `initialize`**, now reported via `hooks_applied`. DorkOS registers a `PreToolUse` hook (`messaging/launch-resolver.ts`) and the persistent pump is exactly the shape that can re-send `initialize` to a running CLI. A silently-inactive `PreToolUse` hook is a permission-boundary hole.

### Confirmed NOT an issue (checked, so it need not be re-checked)

- **0.3.239 — `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sent as literal text on Bedrock/Vertex/Foundry/gateway.** DorkOS uses `systemPrompt: { type: 'preset', preset: 'claude_code', append, excludeDynamicSections: true }` (`messaging/launch-resolver.ts:286-293`), not an array form, and does not import the boundary constant. Never exposed.
- **0.3.260 — `managedSettings.disableAutoMode` dropped by the restrictive-only filter.** DorkOS ships no managed settings.
- **0.3.257 — browser SDK bundle never streaming without native `Symbol.dispose`.** DorkOS does not import the `./browser` subpath.
- **0.3.238 — `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` near-limit behavior.** DorkOS does not enable prompt suggestions.
- **0.3.243 — Read tool PDF `document` block relocation.** `message-event-mapper.ts` reads tool_result content generically; there is no "expect a trailing user message" branch to break.
- **0.3.257 — result `usage.output_tokens_details.thinking_tokens` reporting 0.** DorkOS's only `thinking_tokens` reference (`system-event-mapper.ts:270`) is the **system message subtype**, not the usage field. Unexposed; the new `ModelUsage.thinkingTokens` is the field DorkOS would actually want (see MEDIUM adoptions).

### No workarounds to retire

`grep -rn "TODO\|FIXME\|HACK\|WORKAROUND"` across the whole `claude-code/` adapter (non-test) returns **zero hits**. There is no parked workaround in the adapter that this range resolves — consistent with the codebase-excellence standard, and it means the fixes above buy correctness rather than deletions.

---

## ADR conflicts

| ADR                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0089** (SDK import confinement)                  | ✅ No conflict. Every SDK import stays under `services/runtimes/claude-code/`. None of the recommended adoptions surfaces an SDK type outside the boundary — `queued_turn_count`, `user_message_uuids`, `kind` and the rest all travel as DorkOS `StreamEvent` fields through `AgentRuntime`. `services/mesh/mcp-revocation.ts` remains the one file reasoning about SDK internals from outside the dir, and it does so with **no import**, which is why the ADR does not catch it and why it needs the coupling list                                           |
| **0143** (retry depth over circuit breaker)        | ✅ No conflict. Nothing in this range touches retry classification. The 0.3.218/0.3.223 `api_error_status` opening the previous assessment identified is **still open and still unadopted** — worth carrying forward rather than re-deriving                                                                                                                                                                                                                                                                                                                    |
| **0239** (plugin activation via `options.plugins`) | ⚠️ **No conflict; one strong reason to act.** `pluginDelivery: 'initialize'` is the SDK-side fix for the exact failure mode this ADR's design creates on Windows (an argv that grows with plugin count). The ADR's stated positive — "future SDK plugin features come for free" — is borne out again: `skipMcpDiscovery` and `holdOnCacheImpact` both arrive with no DorkOS work. Its stated negative — "the SDK version pin becomes load-bearing for plugin runtime correctness" — is why the validation plan below insists on one real plugin-loading session |
| **0240** (permission-mode passthrough)             | ✅ No conflict, and the previous bump's recommended amendment is **partly relieved**: 0.3.268 softened `setModel()`'s hard refusal of unknown ids. `set_permission_mode` strictness is untouched, so the amendment recommended last time still stands on its own terms. `PermissionMode` is unchanged across 0.3.224 → 0.3.268 — verified, still the same six values as `PermissionModeSchema` (`packages/shared/src/schemas.ts:52`)                                                                                                                            |

---

## Dependency and pin check

- **Peer deps unchanged**: `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`. Verified identical in both tarballs.
- **`engines.node`**: `>=18.0.0`, unchanged.
- **Optional platform binaries**: the same 8 variants, version-locked to the SDK version.
- **`exports` map**: identical — 6 subpaths, nothing added, nothing removed.

**Seven pin sites must move together** — one more than the previous assessment's table:

| File                                                 | Line | Entry                                               |
| ---------------------------------------------------- | ---- | --------------------------------------------------- |
| `package.json`                                       | 73   | `pnpm.overrides` → `@anthropic-ai/claude-agent-sdk` |
| `apps/server/package.json`                           | 29   | `@anthropic-ai/claude-agent-sdk`                    |
| `packages/cli/package.json`                          | 62   | `@anthropic-ai/claude-agent-sdk`                    |
| `apps/desktop/package.json`                          | 29   | `@anthropic-ai/claude-agent-sdk`                    |
| `apps/desktop/package.json`                          | 19   | `@anthropic-ai/claude-agent-sdk-darwin-arm64`       |
| `apps/desktop/package.json`                          | 20   | `@anthropic-ai/claude-agent-sdk-win32-x64`          |
| `services/runtimes/claude-code/tooling/provision.ts` | 50   | `export const CLAUDE_SDK_VERSION = '0.3.224'`       |

The desktop platform pins stay load-bearing for the reason the previous assessment gave: the packaged app hands the server an unpacked binary path via `DORKOS_CLAUDE_CLI_PATH`, and a skew means the app spawns a `claude` that does not match the SDK protocol talking to it. `scripts/__tests__/dependabot-lockstep-families.test.ts` guards the manifest half; `provision.ts`'s own TSDoc says a test goes red if `CLAUDE_SDK_VERSION` drifts.

**`provision.ts` also demands a second re-check on every bump, in its own words**: `mapSdkModelToModelOption` (`messaging/runtime-cache.ts`) **asserts** `supportsToolUse` / `supportsVision` / `supportsImageOutput` for every Claude model rather than reading them, because `ModelInfo` reports nothing capability-shaped. **Re-checked for this bump: `ModelInfo` still reports none of the three at 0.3.268.** The assertion stands, and the warning in that TSDoc — that `supportsVision` is the claim that goes wrong first if Anthropic ships a text-only model — is unchanged.

---

## Validation plan

1. Bump all **seven** pin sites; `pnpm install`.
2. Rebuild `@dorkos/shared` if imports resolve stale (per AGENTS.md), then `pnpm --filter @dorkos/server typecheck`. **Expect clean** — no compile break is predicted, so any type error here is a finding this assessment missed and should be treated as new information, not noise.
3. `pnpm vitest run apps/server/src/services/runtimes/claude-code` — the `runtimeConformance` suite is the universal gate per `contributing/adding-a-runtime.md`. Pay particular attention to `session-turn-windows` tests, which encode the old `user_message_uuid` cadence and the `SDKResultError`-has-no-uuid premise.
4. `pnpm vitest run apps/server/src/services/mesh/__tests__/mcp-revocation.test.ts` — **will pass regardless**; the fixture is static. Re-validate the anchor by hand, not by suite.
5. Apply the in-bump fixes: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, the three new assistant error values, `pluginDelivery: 'initialize'`, `kind`-based context filtering, and the `session-turn-windows.ts` doc correction.
6. Live verification — the real risks are behavioral and invisible to tests:
   - one real turn on the **default model** that produces a todo list, confirming the task/todo surface still populates (this is the one that fails silently if step 5's env var is skipped);
   - one **multi-turn persistent-pump session** where the agent `cd`s in turn 1, confirming where turn 2's commands run;
   - one **plugin-loading session** under `pluginDelivery: 'initialize'` (ADR-0239's pin is load-bearing), ideally with more than a couple of plugins;
   - one **interrupt mid-turn with a background subagent running**, confirming the stop scope and that the error frame is still suppressed for an operator-initiated stop (`isStoppedTurn`);
   - one turn with an **external MCP server**, observing the new `mcpServerStatus()` distribution under 0.3.243's `pending`-while-reconnecting.
7. Re-stamp the version-pinned anchors: `project-slug.ts`, `mcp-revocation.ts`, `sdk-error-mapping.ts`, `sdk-utils.ts`, `launch-fingerprint.ts`, `phantom-cancellation.ts` — and fix the seven `sdk.d.ts:LINE` citations by replacing them with symbol names.
8. Browser-verify a session in the app before calling it done — specifically the todo panel and the Tasks surface.

## Rollback criteria

Revert to 0.3.224 if any of: the conformance suite fails and the cause is not a test-mock update; the todo/task surface stays empty after step 5's env var; sessions fail to resume (would implicate `resumeSessionAt` or the project-slug mapping); the persistent pump strands a turn window open (would implicate the `user_message_uuid` cadence change); MCP servers fail to connect or report a status shape `mcp-revocation.ts` cannot read; plugin activation stops loading commands or skills under `pluginDelivery: 'initialize'`; or the desktop app cannot spawn its bundled binary.
