# Impact Assessment: @anthropic-ai/claude-agent-sdk 0.2.89 → 0.2.112

**Generated**: 2026-04-16
**Codebase root**: `apps/server/src/services/runtimes/claude-code/`
**Abstraction boundary**: `AgentRuntime` interface (enforced by ADR-0089)
**Related ADRs**: 0089 (SDK import confinement), 0143 (retry over circuit breaker), 0239 (plugin activation), 0240 (permission passthrough)

## Summary

| Category                   | Count | Action                                 |
| -------------------------- | ----- | -------------------------------------- |
| Breaking changes impactful | 0     | —                                      |
| Breaking changes n/a       | 2     | No-op (already-correct or unused APIs) |
| Deprecations               | 0     | —                                      |
| Features high relevance    | 2     | Recommend adopt                        |
| Features medium relevance  | 4     | Consider adopt                         |
| Features low relevance     | 0     | —                                      |
| Bug fixes (auto-resolved)  | 8     | —                                      |
| Security fix               | 1     | Auto-resolved                          |
| Perf fix                   | 1     | Auto-resolved                          |
| Cleanup opportunities      | 2     | Remove workaround comments/casts       |

**Overall upgrade risk**: **Low.** Pre-1.0 version but all breaking changes are n/a to our usage patterns.
**Estimated total effort**: 30 min (bump + 2 cleanups) baseline; +1–4 hrs per adopted feature.

---

## Breaking Changes — Detailed Impact

### 1. `options.env` overlays instead of replaces (0.2.111)

- **Our current usage**: `message-sender.ts:190-194`

  ```ts
  env: {
    ...process.env,                              // explicit spread
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
  },
  ```

- **Impact**: **None.** We already manually spread `process.env` — our behavior matches the new default. The explicit spread becomes redundant post-upgrade.
- **ADR conflicts**: None.
- **Cleanup opportunity** (optional):
  - Remove the `...process.env` spread at `message-sender.ts:192`
  - Remove the `eslint-disable-next-line no-restricted-syntax` comment at `message-sender.ts:191`
  - Effort: **trivial** (3-line diff)
  - Risk: If any nearby code or downstream SDK version reverts this behavior, we lose env inheritance. Leaving the explicit spread is defensively harmless.
  - **Recommendation**: Leave as-is unless we're cleaning up. Belt-and-suspenders is cheap here.

### 2. `sandbox.failIfUnavailable` defaults to `true` (0.2.91)

- **Our current usage**: None — grep for `sandbox` in `services/runtimes/claude-code/` returns zero matches.
- **Impact**: **None.** We do not pass `sandbox` in `Options`.
- **ADR conflicts**: None.

---

## Deprecation Migrations

None in this version range.

---

## Cleanup Opportunities (Enabled by Upgrade)

### Remove `PermissionMode 'auto'` type-assertion workaround (0.2.91 enables)

- **Current code**: `message-sender.ts:223-226`

  ```ts
  // Type assertion: our PermissionMode includes 'auto' which the SDK type doesn't yet define.
  sdkOptions.permissionMode = session.permissionMode as typeof sdkOptions.permissionMode;
  ```

- **Enabled by**: 0.2.91 added `'auto'` to the public `PermissionMode` union.
- **Change**: Drop the `as` cast and the comment. Direct assignment will type-check.
- **Effort**: **trivial**
- **Files**: `message-sender.ts` (1 file, ~3 lines)
- **ADR-0240** (Permission Passthrough): This cleanup _reinforces_ the ADR — no more type-hole assertion needed.
- **Test impact**: None (runtime behavior unchanged).

---

## Recommended Feature Adoptions

### A. Opus 4.7 support (Relevance: High — required)

- **What it enables**: Using `claude-opus-4-7` as the session model through the agent runtime.
- **Current state**: The SDK at 0.2.89 predates Opus 4.7 support. We cannot serve Opus 4.7 to DorkOS sessions until we bump past 0.2.111.
- **Value to DorkOS**: Unblocks offering the newest flagship model. Users are already aware of Opus 4.7 (the CLI model in this session is `claude-opus-4-7[1m]`); the runtime needs to catch up.
- **Adoption effort**: **trivial.** The upgrade alone is sufficient — no code changes. If the model chooser lists Opus 4.7, it will Just Work once the SDK version ships.
- **Dependencies**: None beyond the version bump.
- **ADR-0089**: No boundary impact — model names are opaque strings passed through the interface.
- **Suggested approach**: **Include in the upgrade spec.** This is effectively free once the version bump lands.

### B. `terminal_reason` on result messages (Relevance: High)

- **What it enables**: The SDK now reports _why_ a turn ended — `completed | aborted_tools | max_turns | blocking_limit | ...` — as `terminal_reason` on the result message.
- **Current state**: `sdk-event-mapper.ts:482-523` handles result messages but does not read `terminal_reason`. The `session_status` stream event has no field for it.
- **Value to DorkOS**:
  - Better error surfacing: distinguish "Claude decided to stop" from "we hit max turns" from "aborted mid-tool"
  - Unlocks UI affordances: e.g., a "continue" button when `terminal_reason === 'max_turns'`
  - Supports ADR-0143 (retry depth semantics) by giving the retry path a structured termination reason
- **Adoption effort**: **moderate** (~1–2 hrs)
  - Add `terminalReason` to `StreamEvent`'s `session_status` variant in `packages/shared/types`
  - Read `result.terminal_reason` in `sdk-event-mapper.ts:488-500`, include in emitted event
  - Optionally: surface in session persistence and UI chip
- **Dependencies**: None.
- **ADR-0089**: Clean — new field flows out through `AgentRuntime` boundary via existing `StreamEvent`.
- **Suggested approach**: **Separate spec** if UI surfacing is included; **include in upgrade spec** if limited to adding the field passthrough (pure plumbing).

---

## Feature Adoption Opportunities (Consider)

### C. `system/memory_recall` event + `memory_paths` on `system/init` (Relevance: Medium)

- **What it enables**: UI can show when memory is being recalled mid-turn and which memory files are loaded at session start.
- **Current state**: `sdk-event-mapper.ts` handles `system.init` at line 50 but only reads `session_id` and `model`. Unknown subtypes fall through to the catch-all logger at line 527.
- **Value to DorkOS**:
  - Observability into memory operations (relevant if we expose memory to end-users in the chat UI)
  - Debugging: memory recalls are currently invisible
- **Adoption effort**: **moderate** (~2–3 hrs)
  - Add `memory_recall` `StreamEvent` variant
  - Handle `system.memory_recall` subtype in mapper
  - Optionally read `memory_paths` from `system.init` and expose via session-broadcaster or session metadata
- **Dependencies**: Product decision on whether memory is a surfaced feature for DorkOS or an invisible SDK primitive.
- **ADR-0089**: Clean — new event via existing `StreamEvent` path.
- **Suggested approach**: **Separate spec**, deferred until product decides to surface memory.

### D. `SDKStatus = 'requesting'` + partial status emissions (Relevance: Medium)

- **What it enables**: When `includePartialMessages: true` (which we set at `message-sender.ts:178`), the SDK now emits `{type:'system', subtype:'status', status:'requesting'}` before each API request.
- **Current state**: `sdk-event-mapper.ts:115-125` handles `system.status` messages generically, emitting `system_status` events from `body`/`message` text. The new `status: 'requesting'` field would flow through but without semantic distinction.
- **Value to DorkOS**:
  - Richer loading states: distinguish "LLM is about to be called" from "compacting context" from "hook running"
  - More accurate spinners and typing indicators
- **Adoption effort**: **moderate** (~1–2 hrs)
  - Read `msg.status` in the status handler; add to emitted event
  - Add `status` field to `system_status` StreamEvent type
  - UI consumes optional `status` for richer affordance
- **Dependencies**: UI work to take advantage.
- **ADR-0089**: Clean.
- **Suggested approach**: **Separate spec**, coupled with the loading-state UX work.

### E. `SDKUserMessage.shouldQuery: false` (Relevance: Medium)

- **What it enables**: Append a user message to the conversation without triggering an assistant turn (and without firing `UserPromptSubmit` hooks or auto-title generation).
- **Current state**: Not used. Every message we send triggers an assistant response.
- **Value to DorkOS**:
  - Supports "inject system context" patterns (e.g., a tool result recorded as a user note)
  - Enables multi-message batching before an explicit query
  - Could power scheduled/quiet context injection features
- **Adoption effort**: **moderate** (~2–3 hrs, depending on how it's exposed)
  - SDK-layer: pass `shouldQuery: false` on certain `SDKUserMessage` payloads
  - API-layer: new route or flag on `sendMessage` to indicate "context-only"
  - Transport type update for the optional flag
- **Dependencies**: Product decision on _where_ this is exposed. No concrete feature yet requires it.
- **ADR-0089**: Clean.
- **Suggested approach**: **Defer.** No current spec asks for this; revisit when the need surfaces.

### F. `startup()` / `WarmQuery` public API (Relevance: Medium)

- **What it enables**: Pre-warm the SDK subprocess at server boot so the first user query has lower latency.
- **Current state**: Cold-start on first message pays the subprocess spawn cost every time the server starts.
- **Value to DorkOS**:
  - Tangible perceived latency improvement on first message after server launch (Electron app cold-start is especially user-visible)
  - May also benefit Desktop app "new session" flows
- **Adoption effort**: **moderate** (~2–4 hrs)
  - Call `startup()` / create a `WarmQuery` during `ClaudeCodeRuntime` construction or at a post-boot hook
  - Handle failure cases gracefully (don't block server boot on warm-up)
  - Needs measurement before/after to validate the win
- **Dependencies**: None.
- **ADR-0089**: Clean — the warm-up stays inside the runtime module.
- **Suggested approach**: **Separate spec**, gated on perf measurement showing a meaningful improvement.

### G. Per-tool `permission_policy` on remote MCP servers (Relevance: Low for now)

- **What it enables**: Remote (http/sse) MCP servers can specify `permission_policy` per tool via `mcp_set_servers` control request.
- **Current state**: Our MCP tools in `mcp-tools/*.ts` are primarily local stdio servers. We expose MCP servers via `mcpServerFactory` at `message-sender.ts:251`. Remote MCP servers would benefit, but we have few (if any) today.
- **Value to DorkOS**:
  - Finer-grained permission control if/when marketplace MCP adapters (ADR-0239) use remote transports
- **Adoption effort**: **trivial** when the need arises.
- **Dependencies**: Waiting on remote MCP adoption / marketplace adapter work.
- **ADR-0239** (Plugin Activation): Relevant — if marketplace plugins start using remote MCP, this feature becomes useful.
- **Suggested approach**: **Defer.** No current remote MCP usage.

---

## Bug Fixes Resolving Known Issues (Auto-Applied)

The following fixes are automatic benefits of the upgrade — no action needed:

| Version | Fix                                                                                             | DorkOS relevance                                                           |
| ------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0.2.94  | `getContextUsage()` now includes `options.agents` in breakdown                                  | We call `session.activeQuery.getContextUsage()` at `message-sender.ts:442` |
| 0.2.94  | CJK / multibyte text corruption (U+FFFD) on UTF-8 boundary splits                               | Any non-ASCII transcripts — real fix for real users                        |
| 0.2.94  | MCP server child processes not cleaned up on `query()` session end                              | We use MCP heavily (15+ tool files)                                        |
| 0.2.94  | `unhandledRejection` from failed error-report write                                             | Process stability on disk-full or sandbox restrictions                     |
| 0.2.101 | Resume-session temp-dir leak on Windows; `await using` disposal race on macOS/APFS              | We call `resume: session.sdkSessionId` every message after the first       |
| 0.2.101 | `MaxListenersExceededWarning` at 11+ concurrent `query()` calls                                 | Relevant if multiple sessions stream at once                               |
| 0.2.105 | `error_max_structured_output_retries` wrongly emitted when final retry succeeded                | Correctness — applies if/when we use structured outputs                    |
| 0.2.110 | `unstable_v2_createSession` respects `cwd`, `settingSources`, `allowDangerouslySkipPermissions` | Non-issue — we don't use `unstable_v2_createSession`                       |

## Security Fix (Auto-Applied)

- **0.2.101**: Transitive bumps to `@anthropic-ai/sdk ^0.81.0` and `@modelcontextprotocol/sdk ^1.29.0` resolve **GHSA-5474-4w2j-mq4c** and `hono` advisories. Free CVE coverage by upgrading.

---

## No Action Required

- 14 internal/parity-only versions (underlying Claude Code CLI benefits flow through transparently)
