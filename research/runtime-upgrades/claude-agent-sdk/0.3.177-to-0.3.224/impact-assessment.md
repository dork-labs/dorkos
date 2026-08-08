# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.3.177 → 0.3.224

**Generated**: 2026-08-07
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts`), enforced by ADR-0089 / Hard Rule 2
**Related ADRs**: 0089 (SDK import confinement), 0143 (retry depth over circuit breaker), 0239 (plugin activation via `options.plugins`), 0240 (permission-mode passthrough)
**Companion**: [`changelog.md`](./changelog.md)

## Summary

| Category                           | Count | Action Required                                                             |
| ---------------------------------- | ----- | --------------------------------------------------------------------------- |
| Breaking changes — compile-level   | 0     | None. Verified by type diff against every DorkOS call site                  |
| Breaking changes — behavioral      | 2     | Decide + document (subagent depth cap; background-agent permission prompts) |
| Breaking changes — latent hazard   | 1     | Amend ADR-0240 note (permission-mode strictness)                            |
| Breaking changes — no DorkOS usage | 11    | No action (documented below so the next upgrade need not re-derive)         |
| Deprecations                       | 3     | 0 usages — no action                                                        |
| Features (high)                    | 4     | Adopt or spec separately                                                    |
| Features (medium)                  | 7     | Evaluate; 3 are cheap in-bump wins                                          |
| Features (low/none)                | 35    | No action                                                                   |
| Fixes resolving DorkOS issues      | 6     | Auto-resolved by the bump; 1 fixture needs re-validation                    |

**Overall upgrade risk**: **Low-Medium**. The type surface is additive — zero DorkOS call sites break. The medium comes entirely from two runtime behavior changes that no compiler will catch, plus one committed test fixture whose empirical anchor was captured on 0.3.177.

**Estimated total effort**: **2–4 hours** for the bump itself (version bump across 5 pin sites + re-validate one fixture + conformance suite + a browser-verified turn), plus **1–2 hours** if the two recommended in-bump feature adoptions are included. The high-relevance features are separate-spec scope, not bump scope.

---

## Surface-map drift found

`.claude/config/runtime-deps.json` `sdk_surface_map` has drifted from reality in five places. **Reported, not edited** — per the task brief.

| Config claim                                                 | Reality                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `McpServerConfig` → `context-builder.ts`                     | ❌ `context-builder.ts` imports **nothing** from the SDK. Real sites: `mcp-server-config.ts:15`, `claude-code-runtime.ts:10`, `messaging/message-sender.ts:15`                                                                                         |
| `Options` → `message-sender.ts`, `plugin-activation.ts`      | ⚠️ Half right. `message-sender.ts:13` ✓. `plugin-activation.ts` imports **nothing** from the SDK — it hand-mirrors the plugin entry as a local `ClaudeAgentSdkPlugin` interface (`messaging/plugin-activation.ts:36`)                                  |
| `renameSession()`/`forkSession()` → `claude-code-runtime.ts` | ⚠️ Half right. `renameSession` ✓ (`claude-code-runtime.ts:9`). `forkSession` is in **`sessions/session-store.ts:9`**                                                                                                                                   |
| `getClaudeCliPath()` → `sdk-utils.ts`                        | ❌ No such SDK export, and `sdk-utils.ts` imports **nothing** from the SDK. The function is `resolveClaudeCliPath()` (`sdk/sdk-utils.ts:217`) and it resolves the platform **optional-dependency package** by name via `createRequire`, not an SDK API |
| (missing entries)                                            | The map omits 7 real surfaces — see table below                                                                                                                                                                                                        |

**Surfaces the map does not mention but that DorkOS depends on:**

| SDK surface                                                                       | File                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tool()`, `createSdkMcpServer()`                                                  | `mcp-tools/*.ts` (13 files) — **the single largest SDK surface in the codebase** |
| `getSessionInfo()`                                                                | `sessions/transcript-reader.ts:3`                                                |
| `Query`, `SDKControlGetUsageResponse`                                             | `sdk/subscription-usage.ts:13`                                                   |
| `Query`, `SDKControlGetContextUsageResponse`                                      | `sdk/context-usage.ts:7`                                                         |
| `PermissionResult`, `PermissionUpdate`, `ElicitationRequest`, `ElicitationResult` | `messaging/interactive-handlers.ts:1-6`                                          |
| `EffortLevel`, `ThinkingConfig`                                                   | `messaging/thinking-config.ts:29`                                                |
| `ModelInfo`                                                                       | `messaging/runtime-cache.ts:13`                                                  |
| `McpServerStatus`                                                                 | `messaging/message-sender.ts:16`                                                 |
| `NonNullableUsage`                                                                | `__tests__/sdk-scenarios.ts:3`                                                   |

There is also a **second, undeclared coupling to the SDK that no import statement reveals**: `sessions/project-slug.ts` hand-reimplements the SDK's project-slug algorithm (including the `Di = 200` truncation constant read out of the shipped binary). It has no SDK import, so ESLint, grep-by-import, and the surface map all miss it — yet it breaks silently if the SDK changes its slug scheme. It should be listed in the surface map. See the verification under _Fixes_ below.

---

## Detailed breaking-change impact

### 1. Subagents no longer nest by default (0.3.217) — **behavioral, decide before bumping**

Spawn depth dropped 5 → 1; a new default cap of 20 concurrent subagents.

- **DorkOS exposure**: no type break and no call site to change. The exposure is at the _agent behavior_ layer. DorkOS's documented orchestrator pattern (`messaging/context-builder.ts:83-89`) is already parent-driven — "call `relay_send_async()` in this (parent) session, pass the inboxSubject into the `Task()` prompt, poll `relay_inbox()` after `Task()` returns" — which is depth-1 and therefore **unaffected**. What is affected is any agent prompt or skill that has a subagent dispatch further subagents (the `orchestrating-parallel-work` skill's shape, and `/flow:execute`'s "orchestrating concurrent agents").
- **Note on scope**: DorkOS's headline parallelism is _multi-session_, not multi-subagent — separate sessions each get their own CLI subprocess and their own depth budget. Only within-session `Task`-in-`Task` is capped.
- **Effort**: **trivial (1–5 lines)** if the decision is to restore the old behavior — set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` in the CLI subprocess env that `message-sender.ts` already builds. **Zero** if the decision is to accept the new default.
- **Recommendation**: accept the new default, and verify with one real orchestration turn before closing the bump. A runaway recursive agent tree is a worse failure for an operator than a refused nested spawn, and the cap is exactly the kind of guardrail the cockpit positioning wants. Document the env override in `contributing/adding-a-runtime.md`.
- **ADR conflict**: none.

### 2. Background agents now forward permission prompts to `canUseTool` (0.3.186) — **behavioral**

Previously background agents auto-denied; now they raise prompts through the host callback, and stdin stays open while background tasks run.

- **DorkOS exposure**: `messaging/interactive-handlers.ts` implements `canUseTool` and drives the cockpit's permission UI via `PendingInteraction`. After the bump, prompts can arrive **outside a foreground turn** — from a background agent while the session looks idle.
- **Risk**: the handler auto-denies on abort and on timeout (`interactive-handlers.ts:709-714`), so the failure mode is graceful, not a hang. But an operator may now see permission prompts appear with no active turn, which reads as a bug if the UI does not explain it.
- **Effort**: **trivial-to-moderate**. Zero lines to keep working; ~10–20 lines if the prompt card should label its background origin (the `can_use_tool` request now carries `agent_id`).
- **ADR conflict**: none — ADR-0240 governs mode passthrough, not prompt routing.

### 3. `set_permission_mode` rejects unrecognized modes (0.3.214) — **no impact today, latent hazard**

- **Verified safe**: DorkOS's `PermissionModeSchema` (`packages/shared/src/schemas.ts:47`) is `['default','plan','acceptEdits','dontAsk','bypassPermissions','auto']`. The SDK's `PermissionMode` at both 0.3.177 and 0.3.224 is the **same six values**. Zero drift, so the passthrough at `sessions/session-store.ts:403` cannot send an unknown mode.
- **Additional protection**: `resolveEffectivePermissionMode()` (`messaging/permission-mode-guard.ts:74`) already coerces `'auto'` to `'default'` on models that do not support it.
- **Why it still matters**: ADR-0240's stated negative — "relies on upstream validation being correct — if an invalid value bypasses schema validation, it reaches the SDK directly" — has changed cost. Before 0.3.214 an unknown mode was silently adopted (a quiet wrong-mode bug). After, it is a hard error that **fails the call**. The next time someone adds a mode to `PermissionModeSchema` that the SDK does not have, the symptom is a broken send, not a subtle downgrade.
- **Effort**: **trivial** — add a dated note to ADR-0240 recording the sharpened consequence. No code change.
- **ADR conflict**: no conflict; ADR-0240's decision stands. This is a consequence amendment.

### 4–14. Breaking changes with zero DorkOS exposure — **verified, no action**

Each was checked against real call sites rather than assumed:

| Change                                                                    | Why it does not affect DorkOS                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Query.interrupt()` → `Promise<SDKControlInterruptResponse \| undefined>` | Sole call site `sessions/session-store.ts:508` is `await session.activeQuery.interrupt();` — result discarded. Return-type widening compiles fine                                                                                                                                                                                                           |
| `Query` gained `setMcpPermissionModeOverride()` + `reinitialize()`        | DorkOS never _implements_ `Query`. It only holds one (`agent-types.ts:66-68`, `activeQuery?: Query` / `lastQuery?: Query`). The test double `wrapSdkQuery` (`__tests__/sdk-scenarios.ts:100`) is typed `AsyncGenerator<SDKMessage> & SdkQueryStubs`, **not** `Query`, so added interface members do not break it                                            |
| `applyFlagSettings` mapped-type narrowing                                 | Zero call sites in `apps/server/src`                                                                                                                                                                                                                                                                                                                        |
| `./assistant` subpath export removed                                      | Zero imports repo-wide                                                                                                                                                                                                                                                                                                                                      |
| `ConnectRemoteControl*` / `InboundPrompt` types removed                   | Zero references repo-wide (grep across `apps/server/src` and `packages/` returned empty)                                                                                                                                                                                                                                                                    |
| `setMcpServers({})` no longer removes plugin MCP servers                  | Zero `setMcpServers` call sites. DorkOS passes `mcpServers` at query construction and lets the SDK own plugin MCP loading per ADR-0239                                                                                                                                                                                                                      |
| `skills` option validation tightened                                      | DorkOS does not set `Options.skills`                                                                                                                                                                                                                                                                                                                        |
| `set_model` rejects unrecognized models                                   | Model ids come from the SDK's own `supportedModels()` via `runtime-cache.ts`, never user-typed                                                                                                                                                                                                                                                              |
| `terminal_reason` taxonomy / `command_lifecycle` reclassification         | DorkOS does not consume `command_lifecycle`. `sdk-error-mapping.ts:13` switches on result `subtype` with a `default` fallback, and none of the four mapped subtypes changed                                                                                                                                                                                 |
| Bare-headless `system/permission_denied` events                           | DorkOS always supplies `canUseTool`, so it is never in the bare-headless path. Even if it were, the mapper tolerates it — see below                                                                                                                                                                                                                         |
| New `SDKMessage` union members (6 added)                                  | **The key structural finding.** `sdk/sdk-event-mapper.ts:48-54` ends in a `default:` branch that logs at debug and yields nothing — **not** a `never` exhaustiveness check. New union members are therefore additive and cannot break the build or the stream. (Contrast the Codex adapter, where `never` checks are the _intended_ tripwire per ADR-0309.) |

---

## Deprecation migrations

| Deprecated API                                                                         | Usages in DorkOS | Replacement                                                                                   | Effort |
| -------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- | ------ |
| `team_name` on `TaskCompleted`/`TaskCreated`/`TeammateIdle` hook inputs (new in range) | **0**            | none needed — being removed                                                                   | none   |
| `Options.maxThinkingTokens` (pre-existing)                                             | **0**            | `thinking` / `ThinkingConfig` — DorkOS already uses these (`messaging/thinking-config.ts:29`) | none   |
| `Query.setMaxThinkingTokens()` (pre-existing)                                          | **0**            | same                                                                                          | none   |

DorkOS was already on the modern thinking surface before this range opened. Nothing to migrate.

---

## Recommended feature adoptions

### HIGH — Interrupt that actually stops (0.3.205 + 0.3.219) — _separate spec_

- **What**: `Query.interrupt()` now resolves an `SDKControlInterruptResponse` carrying `still_queued` (uuids of async messages that **will still run**). 0.3.219 adds opt-in `cancel_queued` to the interrupt request, which cancels queued and pending-dispatch messages alongside the abort. Both are feature-detectable via `system/init` `capabilities` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`).
- **Why it matters to DorkOS**: `sessions/session-store.ts:504-513` currently interrupts and, on failure, falls back to `close()`. There is no way today to know that queued work survived a stop. In a cockpit whose whole promise is _control_ over running agents, "I pressed Stop and it kept going" is the single most damaging trust failure. This closes it.
- **Dependencies**: needs a capability check (do not version-sniff), a decision about whether Stop should cancel the queue by default or offer both, and a UI affordance if both.
- **Effort**: **moderate (6–30 lines)** in the runtime; **significant** once the UI question is answered. New user-facing behavior → separate spec per the skill's criteria.

### HIGH — `Query.reinitialize()` after a transport gap (0.3.195) — _separate spec_

- **What**: re-sends `initialize` to a running CLI; the response carries any `can_use_tool` / `request_user_dialog` requests the loop is still blocked on, and the SDK redelivers them to `canUseTool` / `onUserDialog`.
- **Why it matters to DorkOS**: this is the SDK-side twin of a guarantee DorkOS already makes on its own transport. The durable per-session SSE stream does snapshot → gap-free replay via `Last-Event-ID` → live events. But a permission prompt that was pending inside the CLI when the client dropped is _not_ recoverable through the SSE replay — `interactive-handlers.ts`'s `PendingInteraction` map is the only record, and a server restart loses it. `reinitialize()` makes the CLI itself the recovery source. This closes a real hole between DorkOS's durable-stream promise and what the runtime can actually redeliver.
- **Dependencies**: `canUseTool` / dialog callbacks must be **idempotent per `request_id`** (the SDK dedupes in-flight requests but re-dispatches any whose response was lost). `interactive-handlers.ts` would need auditing for that.
- **Effort**: **moderate-to-significant** — the idempotency audit is the real work, not the call.

### HIGH — Non-forgeable peer identity: `SDKMessageOrigin.verifiedPeerPid` (0.3.205/0.3.224) — _separate spec_

- **What**: kernel-verified pid of the process on the cross-session messaging socket, read from the connection (SO*PEERCRED / LOCAL_PEERPID), never from the payload. The SDK's own docs are explicit: *"Key sender identity on this, never on `from`: `from` is sender-authored and kept only for reply routing, so it is forgeable by any same-user process."\_ Also new: peer `name`, `body` (decoded, envelope-stripped, byte-exact with what the model sees), and `fromSession`.
- **Why it matters to DorkOS**: Relay and Mesh are the coordination thesis. `sessions/classify-origin.ts` exists precisely to classify message provenance. Today there is no non-forgeable sender identity on this surface. `body` also removes the need to re-parse envelope text, and `fromSession` gives the cockpit a link target back to the sending session — a concrete "mission control" affordance.
- **Caveats**: `verifiedPeerPid` is absent on Windows and non-UDS ingress (never wrong, just absent), and pids are recyclable — provenance, not an auth token.
- **Effort**: **significant (30+ lines)**, spans runtime + Relay + UI. Definitively separate-spec scope.

### HIGH — `background_tasks_changed` as a level (0.3.203) — _in-bump or small follow-up_

- **What**: a system message carrying the **full set** of live background tasks on every membership change.
- **Why it matters to DorkOS**: `sdk/event-mappers/system-event-mapper.ts:42-81` currently reconstructs background-task state from **edges** — `task_started` (→ `background_task_started`), `task_progress`, `task_notification` (→ `background_task_done`). Edge-derived state is only as good as the edges; one dropped or out-of-order message and the cockpit shows a task that finished, or misses one that started. A level message makes the display self-correcting.
- **Effort**: **moderate (6–30 lines)** — one mapper branch plus a `StreamEvent` for full-set replacement. Borderline in-bump; recommend as an immediate follow-up so the bump stays clean.

### MEDIUM — `SDKAssistantMessage.aborted` (0.3.214) — _adopt in-bump_

Marks an assistant message truncated by interrupt/abort, where `stop_reason` was never received and content may end mid-word. DorkOS renders partial assistant text and today cannot tell a truncated message from a finished one. This is a direct **honest-by-design** win at near-zero cost — one field read in `message-event-mapper.ts`, one flag on the event. **Effort: trivial.**

### MEDIUM — `tool_result_meta` (0.3.216) — _adopt in-bump or immediate follow-up_

`non_execution_kind` and `user_feedback` classify denied / interrupted / cancelled tool calls **without string-matching result prose**. Confirmed DorkOS has no such classification today (grep for denial handling in `message-event-mapper.ts` returned nothing). Adopting it before writing any string-matching is strictly cheaper than adopting it after. **Effort: trivial-to-moderate.**

### MEDIUM — `tool_progress.subagent_type` + `subagent_retry` (0.3.214) — _evaluate_

`subagent_retry` carries `{agent_id, attempt, max_retries, retry_delay_ms, error_status, error_category}`. DorkOS already maps `tool_progress`. Showing "subagent 2 of 5 waiting out a rate limit, retry 3/5 in 20s" instead of an opaque stall is exactly the multi-runtime-cockpit differentiator. **Effort: moderate** (needs a UI surface). Pairs naturally with the 0.3.217 subagent caps — same release theme, same screen.

### MEDIUM — `resumeDropsTurn` (0.3.223) — _evaluate, good fit_

Declares the turn a truncating resume intends to drop; the CLI **refuses the resume** if anything else would be discarded. DorkOS's `resumeSessionAt` anchoring (`messaging/message-sender.ts:513`) is a deliberate, load-bearing mechanism with an existing stale-anchor retry path (`message-sender.ts:939-947`, `isAnchorNotFound` + `MAX_RESUME_RETRIES`, ADR-0143). `resumeDropsTurn` converts "anchor was stale, silently dropped more than intended" into an explicit refusal — it makes an existing safety net tighter rather than adding a feature. **Effort: moderate.** Interacts with ADR-0143's retry model; worth checking that a refusal is classified as a non-retryable condition rather than burning the one retry.

### MEDIUM — `api_error_status` structural overload detection (0.3.218 + 0.3.223) — _evaluate_

Result messages now carry `api_error_status: 529` for repeated overload failures, and mid-stream 429/529 no longer report null. **Directly relevant to ADR-0143**, whose stated negative is "still retries a 529 once before surfacing the error (~4 minutes wasted on the retry)". A structural 529 signal is the missing input for retrying selectively instead of uniformly. **Effort: moderate**, and it would be the first material improvement to ADR-0143's known cost.

### MEDIUM — Plugin manifest `version` at runtime (0.3.214) — _evaluate_

`system/init` `plugins[]` and the `reload_plugins` response now include each plugin's manifest `version`. DorkOS calls `reloadPlugins` (`claude-code-runtime.ts:519`, `:1111`) and owns the marketplace install half per ADR-0239. Runtime-reported versions enable drift detection between what DorkOS installed and what the SDK actually loaded — a genuine gap in the install/runtime split. **Caveat**: plugin-author-controlled and emitted verbatim; validate before displaying. **Effort: moderate.**

### MEDIUM — `ModelInfo.resolvedModel` — _cheap_

Canonical wire id an alias row resolves to (`sonnet` → `claude-sonnet-5`). `messaging/runtime-cache.ts` caches `ModelInfo` to disk with a TTL; a persisted explicit model id currently cannot be matched back to the alias row covering it. **Effort: trivial.**

### LOW / NONE — no action (35 items)

Sandbox credential masking, `strictAllowlist`, `workflowSizeGuideline`, `source:'archive'` plugins, `DirectoryAdded` hook, `rewind_conversation` + `skippedLinks`, `crossSessionInbound`/`dialogExpiry`, Browser SDK `promptSuggestions`, `USAGE_*_PREFIXES` @alpha exports, `SDKRateLimitInfo` credit fields, `tool_use_meta.icon_url`, `SkillToolOutput.background`, `BashToolOutput.timedOutAfterMs`, `NotebookEdit.old_source`, `AgentToolCompletedOutput`, `parent_agent_id`, `SessionStart` fork source, `canUseTool` `requestId`/`null` return, `mcp_set_servers` `request_timeout_ms`, `prompt_id` on hooks, `fast_mode_disabled_reason`, `setMcpPermissionModeOverride`, `thinkingDisplay`, `ReadMcpResourceDirTool`, `workflow_agent.blocked`, `worker_shutting_down`, typed denial reasons, `canonicalModel`/`provider` on modelUsage, `user_message_uuid`/`request_sent_wall_ms`, `resumed_from_incomplete_thinking`, `SDKAssistantMessage.timestamp`, and the remaining new `SDKMessage` union members.

Two worth a sentence each:

- **`crossSessionInbound` / `subkind: 'peer-send-message'` (0.3.224)** — the SDK now ships native cross-session agent messaging with an approval gate. That is adjacent to what `@dorkos/relay` exists to do. No action for this bump, but it is a **strategic overlap worth a deliberate look**: either Relay differentiates above it, or it eventually sits on it.
- **`usage` vs `modelUsage` documentation (0.3.223)** — the SDK now states `modelUsage` is the field for cost accounting. `sdk/event-mappers/result-event-mapper.ts:111-143` **already** reads `modelUsage` and sums across models, with a comment explaining exactly why (`agent-types.ts:83`). The upstream documentation confirms a choice DorkOS already made correctly. No action.

---

## Fixes resolving known DorkOS issues

### Auto-resolved by the bump

1. **0.3.221 — external MCP servers not connected before the first turn** (model emitted tool calls as literal text). DorkOS passes `mcpServers` via `Options` and reads `mcpServerStatus()`. This is a genuine correctness fix on a hot DorkOS path. **See the fixture caveat below.**
2. **0.3.195 — `commands_changed` not emitted for synced skills** when the list resolved before the change-detector subscribed. DorkOS has _documented_ staleness in exactly this area: `sessions/session-store.ts:178` ("cold re-fetch returns the stale init-time list (SDK `commands_changed` doc)"), `claude-code-runtime.ts:440` ("captured ONCE at session init and never reflects…"), and `runtime-cache.ts:357`. The bump narrows the window those comments describe — **re-read them after the bump and update any that are now overstated.**
3. **0.3.208 — abort-listener leak** on streaming queries sharing one `AbortController`. DorkOS runs long-lived sessions with many turns per controller; this was a real slow leak.
4. **0.3.208 — abort during a pending hook callback converted into hook success**, letting PreToolUse-gated tools execute after the abort. DorkOS gates tools through `canUseTool`; this was a genuine permission-boundary bug.
5. **0.3.196 — control-protocol dedup dropping tool-use IDs after 1000 resolutions**, causing duplicate `tool_result` deliveries. DorkOS sessions routinely exceed 1000 tool resolutions.
6. **0.3.224 — long (>200 char) project paths resolving into another project's session directory.** DorkOS is worktree-heavy (`.claude/worktrees/agent-<hash>/…` under an already-deep repo path), so it manufactures exactly the long paths that collided.

Also relevant but lower-impact: **0.3.193** fixed Windows console-window flashes when spawning CLI subprocesses — a real polish win for the Windows desktop alpha; **0.3.178** improved libc-mismatch spawn errors, which pairs with `sdk-utils.ts`'s musl/glibc fallback logic.

### Confirmed NOT an issue (checked, so it need not be re-checked)

- **0.3.207 — `canUseTool` returning `allow` without `updatedInput` rejected as a deny.** DorkOS **always** supplies `updatedInput` at every one of its five allow-return sites (`interactive-handlers.ts:441, 626, 647, 748, 750`). It was never hitting this bug.
- **0.3.203 — `sdk.d.ts` unresolved type refs breaking typecheck with `skipLibCheck` disabled.** `packages/typescript-config/base.json:6` sets `skipLibCheck: true`. Never exposed.
- **0.3.222 — `query({sessionStore, resume})` dropping settings.json.** DorkOS's `SessionStore` is its own class (`claude-code-runtime.ts:83`); it does not pass the SDK's `sessionStore` option. Not exposed.
- **0.3.212 / 0.3.208 — dash-leading argv values.** DorkOS's `resumeSessionAt` values are message uuids and its `sessionId`s are uuids; neither can lead with a dash. Latent robustness only.
- **0.3.178 — server-level `disallowedTools` specs (`mcp__server`) silently ignored.** `tooling/tool-filter.ts` deliberately does not centralize on `disallowedTools` (see its module doc, lines 22-59). Not exposed.

### ⚠️ Requires re-validation after the bump — the one real action item

`apps/server/src/services/mesh/mcp-revocation.ts` carries an **empirical anchor explicitly dated to this SDK version**:

> "Observed 2026-08-07 against `@anthropic-ai/claude-agent-sdk` **0.3.177**: one real turn, two MCP servers pointed at the same always-401 endpoint…"

with the verbatim `query.mcpServerStatus()` array committed at `apps/server/src/services/mesh/__tests__/fixtures/mcp-server-status-401.observed.json` and asserted in `mcp-revocation.test.ts:536`.

**0.3.221 changed exactly the timing that anchor describes.** The module reasons about servers reporting `pending` because they are "still connecting" when the snapshot is taken; 0.3.221 fixed external `mcpServers` not being connected before the first turn. The observed status distribution can legitimately differ on 0.3.224.

Three points, in decreasing severity:

- The module's own point 3 is flagged as **"Binary reading only"** — the `needs-auth` / 15-minute-TTL behavior rests on reading `Uc8`/`eo7`/`YE3 = 900000` out of the 0.3.177 binary, not on observation. Those minified symbols **will** have been renamed by 0.3.224 (confirmed pattern: the slug hash went `My` → `Zb` across this range for exactly this reason). The claim may still hold; the citation no longer resolves.
- The committed fixture will still pass its assertions (it is a static file), so **the test suite will not tell you the anchor went stale.** This is the failure mode to watch.
- The module is architecturally well-defended against this: it uses the status report only to decide _whether to look_, and makes a live probe the arbiter. That design choice is what keeps this a documentation-accuracy problem rather than a correctness one.

**Action**: after bumping, update the version stamp and either re-run the documented harness or explicitly downgrade the binary-reading claims to "observed on 0.3.177, unverified on 0.3.224". **Effort: moderate** (re-running the harness costs one real turn).

---

## Verified non-issue: the undeclared project-slug coupling

`sessions/project-slug.ts` reimplements the SDK's `cwd → ~/.claude/projects/{slug}/` mapping, including `PROJECT_SLUG_MAX_LENGTH = 200` documented as mirroring the SDK's internal `Di = 200`. **0.3.224's headline fix is about >200-char project paths**, so this was the highest-risk item in the entire upgrade: a changed slug scheme would silently point DorkOS's transcript reads at the wrong directory, with no type error and no failing test.

**It was checked directly against both shipped bundles, and the algorithm is unchanged:**

|            | 0.3.177 (`sdk.mjs`)                                                                                 | 0.3.224 (`sdk.mjs`)                                              |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Max length | `var Di=200`                                                                                        | `var ro=200`                                                     |
| Hash       | `function My(e){let t=0;for(let r=0;r<e.length;r++)t=(t<<5)-t+e.charCodeAt(r)\|0;return t}`         | `function Zb(e){…}` — **character-for-character identical body** |
| Slug       | `t=e.replace(/[^a-zA-Z0-9]/g,"-"); if(t.length<=Di) return t; return \`${t.slice(0,Di)}-${a6(e)}\`` | same, via `vE`/`jo`                                              |

Only the minified identifiers changed. `slugForCanonicalPath()` (`project-slug.ts:99`) — dash-replace, 200-char cut, base36 hash **of the original path, not the replaced string** — remains an exact mirror. 0.3.224's fix was on the _lookup_ side (disambiguating two paths sharing a sanitized prefix), which DorkOS gets for free.

**No action. But this coupling belongs in the surface map** so the next upgrade does not have to rediscover that it exists.

---

## ADR conflicts

| ADR                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0089** (SDK import confinement)                  | ✅ No conflict. Every SDK import remains under `services/runtimes/claude-code/`. No recommended adoption requires surfacing SDK types outside the boundary; anything that reaches the client (e.g. `aborted`, background-task levels) travels as a DorkOS `StreamEvent` through `AgentRuntime`, as the ADR requires                                                                                                                                                               |
| **0143** (retry depth over circuit breaker)        | ✅ No conflict; **two improvement openings**. Structural `api_error_status: 529` addresses the ADR's own stated cost ("~4 minutes wasted on the retry"). `resumeDropsTurn` interacts with the `MAX_RESUME_RETRIES = 1` path in `message-sender.ts:939-947` and should be classified as non-retryable if adopted                                                                                                                                                                   |
| **0239** (plugin activation via `options.plugins`) | ✅ No conflict. `{type:'local', path}` is unchanged; `source:'archive'` is purely additive and DorkOS owns its own install half. The ADR's positive — "future SDK plugin features come for free when the SDK is upgraded" — is borne out: plugin manifest `version` now arrives at runtime with no DorkOS work. Its negative — "the SDK version pin becomes load-bearing for plugin runtime correctness" — is why this bump should be verified with a real plugin-loading session |
| **0240** (permission-mode passthrough)             | ⚠️ **Amendment recommended, decision stands.** See breaking change 3. The passthrough is safe today (schemas are identical), but 0.3.214 changed the failure mode from silent-downgrade to hard-error. Add a dated consequence note, mirroring the existing 2026-08-06 audit note                                                                                                                                                                                                 |

---

## Dependency and pin check

- **Peer deps unchanged**: `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`. Verified identical in both tarballs. Existing root overrides remain valid.
- **`engines.node`**: `>=18.0.0`, unchanged.
- **Optional platform binaries**: same 8 variants, version-locked to the SDK version.
- **`exports` map**: lost `./assistant` only (unused).

**Six pin sites must move together** — the two desktop platform packages are easy to miss:

| File                        | Line | Entry                                               |
| --------------------------- | ---- | --------------------------------------------------- |
| `package.json`              | 63   | `pnpm.overrides` → `@anthropic-ai/claude-agent-sdk` |
| `apps/server/package.json`  | 26   | `@anthropic-ai/claude-agent-sdk`                    |
| `packages/cli/package.json` | 61   | `@anthropic-ai/claude-agent-sdk`                    |
| `apps/desktop/package.json` | 23   | `@anthropic-ai/claude-agent-sdk`                    |
| `apps/desktop/package.json` | 19   | `@anthropic-ai/claude-agent-sdk-darwin-arm64`       |
| `apps/desktop/package.json` | 20   | `@anthropic-ai/claude-agent-sdk-win32-x64`          |

The desktop platform pins are load-bearing: `sdk/sdk-utils.ts:140-160` resolves `${SDK_PKG}-${platform}-${arch}` by package name, and the packaged app hands the server an unpacked binary path via `DORKOS_CLAUDE_CLI_PATH`. A version skew between the SDK and its platform packages means the desktop app spawns a `claude` binary that does not match the SDK protocol it is speaking.

> Aside, unrelated to this upgrade: `sdk-utils.ts:148` has a candidate branch for `platform === 'android'` resolving `${SDK_PKG}-linux-${arch}-android`. **No such optional dependency exists** in 0.3.177 or 0.3.224 (the 8 published variants are linux/darwin/win32 × x64/arm64 plus two linux musl). That branch can never resolve. Harmless, but it is dead code by the codebase-excellence standard.

---

## Validation plan

1. Bump all six pin sites; `pnpm install`.
2. Rebuild `@dorkos/shared` if imports resolve stale (per AGENTS.md), then `pnpm --filter @dorkos/server typecheck`. Expect clean — **no compile break is predicted**, so any type error here is a finding this assessment missed and should be treated as new information, not noise.
3. `pnpm vitest run apps/server/src/services/runtimes/claude-code` — the `runtimeConformance` suite is the universal gate per `contributing/adding-a-runtime.md`.
4. `pnpm vitest run apps/server/src/services/mesh/__tests__/mcp-revocation.test.ts` — **will pass regardless**; the fixture is static. Re-validate the anchor by hand, not by suite (see above).
5. Live verification, since the two real risks are behavioral and invisible to tests:
   - one real turn with a **nested** `Task()` to observe the 0.3.217 depth cap;
   - one turn with an **external MCP server** to confirm the 0.3.221 connect-before-first-turn fix and observe the new `mcpServerStatus()` distribution;
   - one **plugin-loading** session (ADR-0239's pin is load-bearing);
   - one **interrupt** mid-turn to confirm `interrupt()`'s widened return does not disturb the existing stop path.
6. Browser-verify a session in the cockpit before calling it done.

## Rollback criteria

Revert to 0.3.177 if any of: the conformance suite fails and the cause is not a test-mock update; sessions fail to resume (would implicate `resumeSessionAt` or the project-slug mapping); MCP servers fail to connect or report a status shape `mcp-revocation.ts` cannot read; plugin activation stops loading commands or skills; or the desktop app cannot spawn its bundled binary.
