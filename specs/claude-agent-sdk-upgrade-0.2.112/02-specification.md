---
slug: claude-agent-sdk-upgrade-0.2.112
number: 245
created: 2026-04-16
status: specified
---

# Claude Agent SDK Upgrade to 0.2.112

**Status**: Specified
**Authors**: Claude Code (2026-04-16)
**Related Ideation**: `specs/claude-agent-sdk-upgrade-0.2.112/01-ideation.md`
**Related Research**:

- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/changelog.md`
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/impact-assessment.md`
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/triage-decisions.md`

---

## 1) Overview

Bump `@anthropic-ai/claude-agent-sdk` from `0.2.89` to `0.2.112` across all workspace packages, and adopt the subset of new SDK capabilities whose adoption cost is bounded and whose value is immediate: Opus 4.7 support (required, free), a `PermissionMode 'auto'` cleanup (type-cast removal), and three additive observability features (`terminal_reason`, `system/memory_recall`, richer `SDKStatus`). All changes stay behind the `AgentRuntime` interface per ADR-0089; new data surfaces via `StreamEvent` variants in `@dorkos/shared`.

## 2) Background / Problem Statement

DorkOS depends on `@anthropic-ai/claude-agent-sdk` to drive the Claude Code runtime. We are running `0.2.89` while the latest is `0.2.112` — 23 releases behind in 16 days, including:

- A required dependency bump for Opus 4.7 (we cannot ship Opus 4.7 to users otherwise).
- A security fix (GHSA-5474-4w2j-mq4c) and a transitive `hono` advisory resolution.
- Fixes we are directly affected by: MCP child-process cleanup, multibyte (CJK) text corruption in stream-json, concurrent-query `MaxListenersExceededWarning`, Windows/macOS resume-session temp-dir leaks, and an `unhandledRejection` when the SDK's error-reporter fails to write.
- Four additive capabilities we can cheaply surface: structured `terminal_reason` on result messages, `system/memory_recall` events + `memory_paths` on `system.init`, and a new `SDKStatus: 'requesting'` status value emitted before each API request (when `includePartialMessages` is enabled — which we already set).

The two "breaking changes" in the window (0.2.111 `options.env` overlay default, 0.2.91 `sandbox.failIfUnavailable` default) do not affect us: we already spread `process.env` explicitly at `message-sender.ts:192`, and we don't pass `options.sandbox` anywhere.

## 3) Goals

- Bump the SDK version across `package.json`, `apps/server/package.json`, and `packages/cli/package.json` to `0.2.112`.
- Pick up all auto-applied fixes with zero behavioral regression.
- Remove the `PermissionMode 'auto'` type-assertion workaround (`message-sender.ts:223-226`) now that the SDK exposes the type natively.
- Make Opus 4.7 selectable end-to-end through the runtime.
- Plumb `terminal_reason` from the SDK result message out through `session_status` `StreamEvent` and render a minimal UI indicator for non-`completed` values.
- Handle `system/memory_recall` events in the mapper, emit a new `memory_recall` `StreamEvent` variant, and expose `memory_paths` from `system.init` on session metadata.
- Extend `system_status` `StreamEvent` with optional `status?: string` to carry the richer SDK status value.
- Maintain full test coverage for the new mapper branches.
- Keep all SDK type imports confined inside `apps/server/src/services/runtimes/claude-code/` (ADR-0089).

## 4) Non-Goals

- **`startup()` / `WarmQuery` adoption** — separate spec (`claude-agent-sdk-warmup`, #246), gated on perf measurement.
- **`SDKUserMessage.shouldQuery: false`** — no current DorkOS feature requires it; deferred.
- **Per-tool `permission_policy` on remote MCP servers** — no remote MCP usage; deferred until marketplace adapters (ADR-0239) use remote transports.
- **Full UX treatment for `terminal_reason`** (e.g., a "continue" button on `max_turns`) — scope here is limited to a minimal indicator chip; broader UX belongs in a future spec.
- **Removing the defensive `...process.env` spread** at `message-sender.ts:192` — it's harmless belt-and-suspenders and simplifies nothing meaningfully.
- **Migrating to `unstable_v2_createSession`** — we don't use it; the 0.2.110 fix for `cwd`/`settingSources`/`allowDangerouslySkipPermissions` is irrelevant.
- **Changes to Claude Code CLI packaging** — the SDK bump automatically brings CLI parity updates; we don't separately vendor the CLI.

## 5) Technical Dependencies

### External

- `@anthropic-ai/claude-agent-sdk@0.2.112` — target version.
- Transitive (picked up via SDK bump, not pinned separately):
  - `@anthropic-ai/sdk ^0.81.0` (security fix via 0.2.101)
  - `@modelcontextprotocol/sdk ^1.29.0` (security fix via 0.2.101)

### Internal Abstraction Boundary

- `AgentRuntime` interface in `packages/shared/src/agent-runtime.ts` — must not leak SDK types across the boundary (ADR-0089).
- `StreamEvent` union in `@dorkos/shared` (`packages/shared/src/types/stream-event.ts` or adjacent) — extended with optional fields + one new variant.

### Documentation

- Upstream changelog: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- GitHub releases: https://github.com/anthropics/claude-agent-sdk-typescript/releases
- npm registry: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

## 6) Detailed Design

### 6.1 Version Bump

Three files:

- `package.json`
- `apps/server/package.json`
- `packages/cli/package.json`

All currently declare `"@anthropic-ai/claude-agent-sdk": "0.2.89"`. Bump each to `"0.2.112"`. Run `pnpm install` to refresh `pnpm-lock.yaml`.

**Acceptance**: `pnpm typecheck && pnpm build && pnpm test:run` pass against the new version before any code edits. If they fail, the failure must be mapped to one of the tracked breaking changes (0.2.111 env overlay, 0.2.91 sandbox default) or escalated.

### 6.2 `PermissionMode 'auto'` Cleanup

**Current** (`apps/server/src/services/runtimes/claude-code/message-sender.ts:223-226`):

```ts
// Pass the session's permission mode directly to the SDK.
// The schema validates valid values upstream; no allowlist needed here.
// Type assertion: our PermissionMode includes 'auto' which the SDK type doesn't yet define.
sdkOptions.permissionMode = session.permissionMode as typeof sdkOptions.permissionMode;
```

**Target**:

```ts
// Pass the session's permission mode directly to the SDK.
// The schema validates valid values upstream; no allowlist needed here.
sdkOptions.permissionMode = session.permissionMode;
```

The 0.2.91 `PermissionMode` union now includes `'auto'` natively, so the cast and justifying comment come out.

**Acceptance**: `pnpm typecheck` passes without the cast. No runtime behavior change.

### 6.3 Opus 4.7 Support

**No code changes.** The SDK passes `options.model` through to the CLI, which supports `claude-opus-4-7` from 0.2.111. Validation: open a session, select Opus 4.7 (if the model chooser already lists it) or set it via `session.model` in a test, send a message, observe the `session_status` result message reports `model: 'claude-opus-4-7'`.

If the model chooser does not list Opus 4.7, that's out of scope here (model chooser lives in the client; a separate spec would add it to the list). This spec only unblocks the runtime path.

### 6.4 `terminal_reason` Plumbing

**SDK surface** (0.2.91): result messages now carry optional `terminal_reason: 'completed' | 'aborted_tools' | 'max_turns' | 'blocking_limit' | string`.

**Changes**:

1. **Shared types** — `packages/shared/src/types/stream-event.ts` (or equivalent). Extend the `session_status` data shape:

   ```ts
   {
     type: 'session_status';
     data: {
       sessionId?: string;
       model?: string;
       costUsd?: number;
       contextTokens?: number;
       contextMaxTokens?: number;
       cacheReadTokens?: number;
       cacheCreationTokens?: number;
       terminalReason?: TerminalReason;   // NEW
     };
   }

   export type TerminalReason =
     | 'completed'
     | 'aborted_tools'
     | 'max_turns'
     | 'blocking_limit'
     | (string & {}); // future-proof; SDK may add new values
   ```

2. **Mapper** — `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:482-500`. In the result-message branch, read `result.terminal_reason` and include it in the emitted event:

   ```ts
   const terminalReason = result.terminal_reason as TerminalReason | undefined;
   yield {
     type: 'session_status',
     data: {
       sessionId,
       model: result.model as string | undefined,
       costUsd: result.total_cost_usd as number | undefined,
       contextTokens: usage?.input_tokens as number | undefined,
       contextMaxTokens: firstModelUsage?.contextWindow as number | undefined,
       cacheReadTokens: firstModelUsage?.cacheReadInputTokens as number | undefined,
       cacheCreationTokens: firstModelUsage?.cacheCreationInputTokens as number | undefined,
       ...(terminalReason ? { terminalReason } : {}),
     },
   };
   ```

3. **Session persistence** — if `session_status` fields are persisted (e.g., on the `Session` record), add `terminalReason` to the persisted shape. If they're stream-only, skip.

4. **UI** — render a minimal `<Badge>` on the last assistant message group when `terminalReason` is defined and not `'completed'`. Copy:
   - `aborted_tools` → "Tool aborted"
   - `max_turns` → "Max turns reached"
   - `blocking_limit` → "Blocking limit"
   - Any other string → display the raw value (future-proof)

   Location: wherever the client consumes `session_status` events (likely a chat hook or the session reducer). Keep the render behind a small, isolated component.

**Acceptance**: A unit test in `sdk-event-mapper.test.ts` confirms a result with `terminal_reason: 'max_turns'` yields a `session_status` event with `terminalReason: 'max_turns'`. A client-side render test confirms the badge appears for non-`completed` values and is absent for `'completed'`/`undefined`.

### 6.5 `system/memory_recall` + `memory_paths`

**SDK surface** (0.2.105): new `system/memory_recall` event emitted during recall; `system.init` now carries `memory_paths`.

**Changes**:

1. **Shared types** — add a new `StreamEvent` variant:

   ```ts
   | {
       type: 'memory_recall';
       data: {
         path?: string;
         // SDK shape TBD during implementation — confirm via SDK dist types before finalizing.
         // Other plausible fields: content?, source?, reason?.
       };
     }
   ```

   Extend `session.init`-derived session metadata (wherever `system.init` is currently read — `sdk-event-mapper.ts:50-60`) with optional `memoryPaths?: string[]`. Persist on `AgentSession` type in `agent-types.ts` if helpful for broadcaster access.

2. **Mapper** — add branch in `sdk-event-mapper.ts`:

   ```ts
   if (message.subtype === 'memory_recall') {
     const msg = message as Record<string, unknown>;
     yield {
       type: 'memory_recall',
       data: {
         path: msg.path as string | undefined,
         // forward other fields defensively; narrow as SDK types are confirmed
       },
     };
     return;
   }
   ```

   In the existing `system.init` branch at line 50, read `memory_paths` and persist on `session.memoryPaths` (or equivalent session slot):

   ```ts
   const memoryPaths = (message as Record<string, unknown>).memory_paths as string[] | undefined;
   if (memoryPaths) session.memoryPaths = memoryPaths;
   ```

3. **UI** — initial surface: minimal. Mirror how `api_retry` events are presented (a subtle informational row). Do not build a full memory inspector in this spec.

   If the SDK emits `memory_recall` frequently (unclear without running it), the UI must not be noisy — render as a small inline annotation on the adjacent tool-call or assistant block, not as a toast or modal.

**Acceptance**: Mapper unit tests cover both the new subtype and `memory_paths` propagation from `system.init`. Manual validation: when the agent recalls memory during a turn, the UI shows an unobtrusive indicator.

**Open**: The exact SDK field shape for `memory_recall` is not in the changelog body. First implementation task must grep the SDK `dist/` types in `node_modules` to confirm before finalizing `StreamEvent` fields.

### 6.6 Richer `SDKStatus: 'requesting'`

**SDK surface** (0.2.108): when `includePartialMessages: true` (we set this at `message-sender.ts:178`), a `{type:'system', subtype:'status', status:'requesting'}` message is emitted before each API request.

**Changes**:

1. **Shared types** — extend the existing `system_status` event data:

   ```ts
   {
     type: 'system_status';
     data: {
       message: string;
       status?: string; // NEW — SDK-provided status value (e.g., 'requesting')
     };
   }
   ```

2. **Mapper** — update the `system.status` handler at `sdk-event-mapper.ts:115-125`:

   ```ts
   if (message.subtype === 'status') {
     const msg = message as Record<string, unknown>;
     const status = msg.status as string | undefined;
     const text = (msg.body as string) ?? (msg.message as string) ?? '';
     if (text || status) {
       yield {
         type: 'system_status',
         data: {
           message: text || (status ? `Status: ${status}` : ''),
           ...(status ? { status } : {}),
         },
       };
     }
     return;
   }
   ```

   The fallback message string ensures the event remains backward-compatible for renderers that only look at `message`.

3. **UI** — optional enhancement: when `status === 'requesting'`, show a distinct "Thinking…" spinner variant. Default renderer (checking `message` text) keeps working unchanged.

**Acceptance**: Unit test that a `{subtype:'status', status:'requesting'}` message (with no body) still yields a `system_status` event carrying `status: 'requesting'` and a non-empty fallback message.

### 6.7 Architectural Invariants

- **No SDK types cross the `AgentRuntime` boundary.** All new fields are added to `StreamEvent` / `AgentSession` types in `@dorkos/shared`, which don't import from `@anthropic-ai/claude-agent-sdk`. The `TerminalReason` type lives in shared and is defined as a plain union.
- **ESLint boundary stays intact.** No new imports from `@anthropic-ai/claude-agent-sdk` outside `services/runtimes/claude-code/`.
- **All new mapper branches are additive.** Unknown subtypes still fall through to the catch-all logger.

### 6.8 Data Flow

```
SDK query() ─→ SDKMessage ─→ sdk-event-mapper.ts (inside boundary)
                               │
                               ├── system.init   ──▶ session.sdkSessionId, session.memoryPaths (NEW), session_status event
                               ├── system.status ──▶ system_status event (now with optional status)
                               ├── system.memory_recall (NEW) ──▶ memory_recall event
                               ├── result        ──▶ session_status event (now with optional terminalReason)
                               └── ... (unchanged for other subtypes)
                                             │
                                             ▼
                                     session-broadcaster ──▶ SSE ──▶ client
```

No SDK type escapes the mapper.

## 7) User Experience

- **Opus 4.7**: users select the model (if the chooser already lists it) and it works. No new UX surface in this spec.
- **Terminal reason chip**: when an assistant turn ends non-normally, users see a small badge. Reduces confusion about why the response stopped.
- **Memory recall indicator**: users gain a subtle signal that memory was consulted. Helps with trust and debugging.
- **Richer status**: slightly better loading-state fidelity (optional adoption by renderers).

No destructive UX changes. All additions are opt-in visually (optional fields rendered conditionally).

## 8) Testing Strategy

### Unit (mapper)

- `sdk-event-mapper.test.ts`:
  - Result message with `terminal_reason: 'max_turns'` produces `session_status.data.terminalReason === 'max_turns'`.
  - Result message without `terminal_reason` produces a `session_status` without the field (exact-match object shape).
  - `system.memory_recall` message with `path: '/foo'` produces a `memory_recall` event with that path.
  - `system.init` with `memory_paths: ['/a', '/b']` sets `session.memoryPaths`.
  - `system.status` with `status: 'requesting'` and no body produces a `system_status` event with `status: 'requesting'` and a non-empty fallback `message`.
  - `system.status` with body text but no `status` remains backward compatible.

Each test includes a one-line purpose comment stating which SDK release introduced the behavior and what invariant it verifies.

### Integration (SSE)

- Reuse `collectSseEvents` pattern from `@dorkos/test-utils` to run a scenario where the `FakeAgentRuntime` emits a result with `terminal_reason`. Assert the client-facing SSE stream carries `terminalReason`.

### Type tests

- `pnpm typecheck` confirms:
  - `PermissionMode 'auto'` cast is removed and still compiles.
  - `StreamEvent` variant additions don't break existing consumers (compile-time check suffices).

### Manual smoke

- Fresh session with Opus 4.7 model selected (if available); send a message; verify response.
- Trigger a tool-use that aborts mid-turn (e.g., deny a permission prompt); verify `terminal_reason: 'aborted_tools'` surfaces in UI.
- Trigger context recall (if available) and observe the `memory_recall` indicator.

### Mocking

- Use `FakeAgentRuntime` from `@dorkos/test-utils` to drive server-side tests.
- Use `wrapSdkQuery` + `sdkSimpleText` / `sdkToolCall` builders from `sdk-scenarios.ts` for SDK-level tests; add a `sdkResultWithTerminalReason` helper if one doesn't exist.

## 9) Performance

- Version bump includes fixes that _improve_ perf under concurrent queries (0.2.101 MaxListeners fix).
- The added mapper branches do one extra property read per message — negligible.
- No new allocations in hot paths beyond the optional field additions.

## 10) Security

- **GHSA-5474-4w2j-mq4c** and transitive `hono` advisories resolved automatically by the transitive bump to `@anthropic-ai/sdk ^0.81.0` and `@modelcontextprotocol/sdk ^1.29.0` (via 0.2.101).
- No new permission surface introduced by this spec. The `PermissionMode 'auto'` cleanup is a type-only change.
- Sandbox behavior unchanged (we don't use it).

## 11) Documentation

- Update `CHANGELOG.md` (user-facing, via `/changelog:backfill` or manual) with: Opus 4.7 support, terminal reason surfacing, memory recall visibility, SDK 0.2.112 upgrade.
- No developer-guide changes strictly required; spec + research docs are sufficient.
- If `contributing/runtime-integration.md` (or similar) exists and references the `PermissionMode 'auto'` cast, update it.

## 12) Implementation Phases

### Phase 1 — Bump & Validate

1. Bump SDK version in 3 workspace manifests.
2. `pnpm install`.
3. Run `pnpm lint && pnpm typecheck && pnpm build && pnpm test:run` — all must pass with no code changes (auto-benefits applied).

### Phase 2 — Cleanup & Free Wins

1. Remove `PermissionMode 'auto'` cast at `message-sender.ts:223-226`.
2. Confirm Opus 4.7 works end-to-end via manual smoke test.

### Phase 3 — `terminal_reason`

1. Extend `StreamEvent.session_status` type with `terminalReason?` and export `TerminalReason`.
2. Read `result.terminal_reason` in mapper, emit on event.
3. Render UI chip.
4. Mapper unit tests.

### Phase 4 — `memory_recall` + `memory_paths`

1. Grep SDK dist types to confirm `memory_recall` payload shape.
2. Add `memory_recall` `StreamEvent` variant.
3. Extend `AgentSession` type with `memoryPaths?: string[]`.
4. Mapper branches + session.init field read.
5. Minimal UI surface.
6. Mapper unit tests.

### Phase 5 — Richer `SDKStatus`

1. Extend `StreamEvent.system_status` type with `status?`.
2. Mapper status-handler update.
3. Optional UI polish.
4. Mapper unit test.

### Phase 6 — Validation & Hand-off

1. Full pipeline green: `pnpm lint && pnpm typecheck && pnpm build && pnpm test:run`.
2. Manual smoke checklist.
3. Update spec manifest to `implemented`.
4. Commit per phase.

## 13) Open Questions

1. **SDK payload shape for `memory_recall`** — changelog describes intent, not field names. Phase 4 opens with reading `node_modules/@anthropic-ai/claude-agent-sdk/dist/...` types to confirm.
2. **Session persistence for `terminalReason`** — are `session_status` fields currently persisted on the `Session` record, or is it stream-only? Confirm during Phase 3 when editing the session store.
3. **UI chip placement** — does the chat message group component already have a metadata slot, or do we need to add one? Investigate during Phase 3; prefer reusing existing affordance.

## 14) Related ADRs

- **ADR-0089** (SDK Import Confinement) — This spec rigorously respects the boundary; all SDK type usage remains inside `services/runtimes/claude-code/`.
- **ADR-0143** (Retry over Circuit Breaker) — `terminal_reason` complements this model: a `max_turns` or `blocking_limit` termination is structurally distinct from an error, which reinforces the ADR's retry-depth stance.
- **ADR-0239** (Plugin Activation) — Unchanged in this spec. The deferred "per-tool MCP `permission_policy`" feature would touch this ADR when adopted later.
- **ADR-0240** (Permission Passthrough) — The `PermissionMode 'auto'` cleanup _strengthens_ this ADR: we no longer need a type-hole cast to pass modes through.

## 15) References

- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/changelog.md`
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/impact-assessment.md`
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/triage-decisions.md`
- Upstream: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- `.claude/rules/testing.md` — FakeAgentRuntime / SDK scenario patterns
- `.claude/rules/code-quality.md` — complexity/size limits for new helpers
- Related prior specs: `agent-permission-mode`, `agent-runtime-abstraction`, `error-categorization-retry`, `sdk-error-observability`, `sdk-command-discovery`
