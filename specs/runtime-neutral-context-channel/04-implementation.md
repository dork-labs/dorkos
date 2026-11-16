# Implementation Summary: Runtime-Neutral Additional-Context Channel

**Created:** 2026-06-16
**Last Updated:** 2026-06-16
**Spec:** specs/runtime-neutral-context-channel/02-specification.md

## Worktree

- **Path:** `/Users/doriancollier/.dork/workspaces/core/spec-runtime-neutral-context-channel`
- **Branch:** `spec-runtime-neutral-context-channel` (forked from `main@ca3378bd`)
- **Ports:** DORKOS_PORT=4368 / VITE_PORT=4518 / SITE_PORT=4668
- **Cleanup after merge:** `/worktree:remove spec-runtime-neutral-context-channel --delete-branch`

## Progress

**Status:** Complete
**Tasks Completed:** 12 / 12

## Tasks Completed

### Session 1 - 2026-06-16

- Task #10: [P1] Add `excludeDynamicSections: true` to Claude system prompt (DOR-132) — git de-dup; preset native git/cwd/memory suppressed, DorkOS `<git_status>` is now the sole source.
- Task #11: [P2] Created `packages/shared/src/additional-context.ts` — neutral model (`ContextKind`, `ContextScope`, `GitStatusData`/`EnvData`/`RelayContextData`, `AdditionalContextEntry` union, `AdditionalContext`, `ClientContext`), `CONTEXT_TAG` single-source map (`satisfies Record<ContextKind,string>`), and Zod schemas; subpath added to `package.json` exports.
- Task #12: [P2] `SendMessageRequestSchema` now carries `context: ClientContextSchema` (top-level `uiState` removed); route `sessions.ts` threads `context`.
- Task #13: [P3] `MessageOpts.additionalContext` added + `uiState` removed; `RuntimeCapabilities.nativeContext: ContextKind[]` added (`[]` for claude-code + test-mode). No `contextDelivery` (deferred).
- Task #14: [P3] Created `apps/server/src/services/session/context-assembler.ts` — server-side git derivation + merge of client signals into the bag, with `nativeContext` omission. Env NOT emitted (G2: stays on `systemPrompt.append`).
- Task #15: [P3] Threaded `context` → `assembleAdditionalContext(nativeContext from getCapabilities())` → `sendMessage(content, { cwd, additionalContext })` in `trigger-turn.ts` + `embedded-turn-trigger.ts`. `content` passed pristine.
- Task #16: [P4] `Transport.postMessage` options now `{ clientMessageId?, context? }` (no `uiState`); HTTP + Direct transports both carry `context`.
- Task #17: [P4] Queue auto-flush now sends PRISTINE `item.content` + `{ queued: true }` via the extended `onFlush`; submit path forwards `context: { queued: true }`. The `[Note: …]` prose is gone.
- Task #18: [P5] Added `renderContextEntry` (CONTEXT_TAG-driven) in `context-builder.ts`; `message-sender.ts` consumes `additionalContext` (prepend), retains the DOR-107 command-skip guard, removed `buildPerMessageContext`/`buildGitBlock` formatting. `session.uiState` lifted from the bag in the runtime for the `get_ui_state` MCP tool.
- Task #19: [P5] Rewrote `stripSystemTags` to iterate `Object.values(CONTEXT_TAG)` (+ `<system-reminder>`); reconciled `stripRelayContext` to the same tag name; added the parametrized strip-guard test (AC5).
- Task #20: [P6] Integration coverage (pristine content, clean transcript, command dispatch) — satisfied by existing + new tests; see the AC coverage map below. No redundant HTTP-timing test added (the HTTP-path core `triggerTurn` is already integration-tested via `embedded-turn-trigger.test.ts`, which delegates to it with the real assembler).
- Task #21: [P6] Added `context-roundtrip.test.ts` — `renderContextEntry` ↔ `stripSystemTags` round-trip per `ContextKind` (formatter↔stripper agreement). Cache gate G3 documented below (manual/empirical, not CI-automatable).

## Files Modified/Created

**Source files:**

- `packages/shared/src/additional-context.ts` (new) — neutral context model + `CONTEXT_TAG` + Zod schemas.
- `packages/shared/src/agent-runtime.ts` — `MessageOpts.additionalContext`, `RuntimeCapabilities.nativeContext`; `uiState` removed.
- `packages/shared/src/schemas.ts` — `SendMessageRequestSchema.context` (removed top-level `uiState`).
- `packages/shared/src/transport.ts` — `postMessage` options carry `context` (removed `uiState`).
- `packages/shared/package.json` — `@dorkos/shared/additional-context` export subpath.
- `apps/server/src/services/session/context-assembler.ts` (new) — server-side assembler + git derivation.
- `apps/server/src/services/session/trigger-turn.ts`, `embedded-turn-trigger.ts` — thread `context` → assembler → `additionalContext`.
- `apps/server/src/routes/sessions.ts` — parse/pass `context`; provide `getCapabilities` dep.
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` — `excludeDynamicSections: true` (Slice 1); consume `additionalContext`, retain DOR-107 guard, remove `buildPerMessageContext`.
- `apps/server/src/services/runtimes/claude-code/messaging/context-builder.ts` — `renderContextEntry` (CONTEXT_TAG-driven); removed `buildPerMessageContext`/`buildGitBlock` formatting.
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-parser.ts` — `stripSystemTags` CONTEXT_TAG-driven; `stripRelayContext` reconciled.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — lift `ui_state` from the bag onto `session.uiState` for the `get_ui_state` MCP tool.
- `apps/server/src/services/runtimes/{claude-code,test-mode}/runtime-constants.ts` — `nativeContext: []`.
- `apps/client/src/layers/shared/lib/transport/session-methods.ts`, `direct/session-methods.ts`, `direct/services.ts` — carry `context`.
- `apps/client/src/layers/features/chat/model/use-message-queue.ts`, `use-chat-queue.ts`, `use-session-submit.ts`, `ui/input/ChatInputContainer.tsx` — pristine flush + `context.queued` signal.
- `packages/test-utils/src/fake-agent-runtime.ts` — `nativeContext` capability.

**Test files:** (new) `packages/shared/src/__tests__/additional-context.test.ts`, `apps/server/src/services/session/__tests__/context-assembler.test.ts`, `apps/server/.../messaging/__tests__/message-sender-system-prompt.test.ts`, `apps/server/.../messaging/__tests__/context-roundtrip.test.ts`; (updated) `transcript-parser.test.ts` (strip-guard parametrized over CONTEXT_TAG, AC5), `context-builder.test.ts`, `claude-code-runtime*.test.ts`, `capabilities.test.ts` (×2), `test-mode-runtime.test.ts`, `embedded-turn-trigger.test.ts`, `agent-runtime.test.ts`, client `use-message-queue*.test.ts`, `queue-integration.test.ts`, `direct-transport-streams.test.ts`, `PermissionModeItem.test.tsx`.

## Known Issues

- **G1 (re-injection):** SDK re-injects stripped sections into the first user message (sdk.d.ts 1943-1944); under DorkOS resume-per-message a session-start git/cwd snapshot may briefly coexist with the fresh per-turn `<git_status>`. Tolerated per ADR-0273 A2 (stale-tolerant). No compensation.
- **G2 (env overlap):** `excludeDynamicSections` strips the preset's working-dir/auto-memory/git dynamic sections (not a tagged `<env>`), so there is no full `<env>` duplication — but the re-injected first-user-message snapshot restates `cwd`, overlapping DorkOS's `buildEnvBlock` `Working directory:` line. Flagged for Task #14 (assembler env-entry decision): drop the `Working directory:` line from `buildEnvBlock` or keep it authoritative.

## Implementation Notes

### Session 1

- **Execution shape:** the `uiState → context` migration (Phases 2–5) is a tightly-coupled type-level refactor across `@dorkos/shared` + server + client — the tree only compiles green once the whole thing lands. It was executed as one coherent slice (not parallel per-task agents, which would thrash a red tree) with a holistic batch gate, per the repo's batch-gate convention.
- **500-recovery audit:** the Slice 2 implementer agent and a follow-up code-reviewer agent both hit transient API 500s (at report/mid-review time, not during code production). The slice was therefore audited directly: repo-wide `pnpm typecheck` GREEN (21/21) — proving the coupled migration is type-complete; `pnpm lint` 0 errors (8 pre-existing warnings, none in changed files); full `pnpm test -- --run` passing (client 4218; server suites green); hand-review of every critical region (prepend + DOR-107 guard keeps `content` pristine; `renderContextEntry`/`stripSystemTags` both CONTEXT_TAG-driven; assembler; `ui_state`→MCP lift; trigger threading); and a test-integrity scan (no `.skip/.only/.todo`, no weakened/tautological assertions; new tests assert real behavior incl. edge cases).
- **G2 resolved:** env stays on `systemPrompt.append`; the assembler emits no `env` entry (no full `<env>` duplication). The `env` kind/type/tag are retained for a future runtime that can't suppress its preset env.
- **No half-migration:** `uiState` fully removed from `MessageOpts`/`SendMessageRequestSchema`/`Transport`/trigger paths. Remaining `session.uiState` is solely the `get_ui_state` MCP tool path, now populated from the bag. `buildPerMessageContext` removed. No SDK hook wired (structured prepend is the mechanism, ADR-0273).

## Acceptance Criteria coverage

| AC  | What                                                                                    | Covered by                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | content never mutated (plain/queued/command); post-strip JSONL == typed bytes           | `embedded-turn-trigger.test.ts` ("pristine content" → `triggerTurn` → `sendMessage`), `message-sender-command-dispatch.test.ts` ("leaves content pristine"), `context-roundtrip.test.ts` (render→`stripSystemTags` == user text) |
| AC2 | queued → model gets `<queue_note>`; transcript shows pristine text, no `[Note:]`        | `context-assembler.test.ts` (queue_note entry), client `queue-integration.test.ts`/`use-message-queue.test.ts` (pristine + `{queued:true}`, no `[Note:]`), `context-roundtrip.test.ts` (queue_note stripped)                     |
| AC3 | git injected once, server-derived                                                       | Slice 1 `message-sender-system-prompt.test.ts` (`excludeDynamicSections`), `context-assembler.test.ts` (single server-side derivation)                                                                                           |
| AC4 | slash commands still dispatch; guard holds, no prepend on command turns                 | `message-sender-command-dispatch.test.ts` (8 cases)                                                                                                                                                                              |
| AC5 | `stripSystemTags` strips every `CONTEXT_TAG`; new kind needs no strip edit              | `transcript-parser.test.ts` (parametrized strip guard), `context-roundtrip.test.ts` (render↔strip per kind)                                                                                                                      |
| AC6 | `Transport.postMessage`/`MessageOpts` carry `context`/`additionalContext`, no `uiState` | `additional-context.test.ts` (schema), `direct-transport-streams.test.ts` (wire carries `context`), repo-wide typecheck                                                                                                          |
| AC7 | `RuntimeCapabilities.nativeContext`; omission honored                                   | `capabilities.test.ts` ×2 (`nativeContext: []`), `context-assembler.test.ts` + `embedded-turn-trigger.test.ts` (omission honored)                                                                                                |
| AC8 | no prompt-cache regression (multi-turn)                                                 | **G3 — manual/empirical** (see below)                                                                                                                                                                                            |

**#20 integration note:** no standalone HTTP-route test was added because the HTTP-path core (`triggerTurn`) is already integration-tested through `embedded-turn-trigger.test.ts`, which delegates to `triggerTurn` with the **real** `assembleAdditionalContext` and a spied runtime `sendMessage`/`getCapabilities`. The only HTTP-route delta is the Zod-validated `context` forward (covered by `additional-context.test.ts`). A full POST→SSE test would need detached-turn timing waits (flaky) for redundant coverage — deliberately omitted.

## Verification gates

- **G1 (excludeDynamicSections re-injection):** SDK re-injects stripped sections into the first user message (sdk.d.ts 1943-1944); under resume-per-message a session-start git/cwd snapshot may briefly coexist with the fresh per-turn `<git_status>`. **Tolerated** per ADR-0273 A2 (stale-tolerant). No compensation.
- **G2 (env duplication):** `excludeDynamicSections` strips the preset's working-dir/auto-memory/git dynamic sections — NOT a tagged `<env>` — so no full `<env>` duplication. Env stays on `systemPrompt.append` (`buildEnvBlock`); the assembler emits no `env` entry. Minor cwd restatement tolerated. **Resolved.**
- **G3 (prompt cache, AC8) — manual gate:** No regression expected; likely a small improvement. Rationale: (1) `excludeDynamicSections` made the `claude_code` system prompt **fully static** (the preset's dynamic git/cwd/memory no longer vary per turn; DorkOS env rides the stable `append`), enlarging and stabilizing the cacheable prefix; (2) per-turn context (the bag) sits in the **user message after the cache breakpoint**, exactly as the prior body-prepend did, so it never invalidates the cached prefix. Manual measurement: on a multi-turn session, compare `usage.cache_read_input_tokens` vs `usage.cache_creation_input_tokens` across turns in the SDK JSONL before/after; expect read-heavy (high hit rate), no increase in creation churn. Not CI-automatable (requires a live multi-turn SDK session). See MEMORY `project_token_burn_diagnosis`.
- **G4 (future hook path):** deferred / out of scope (ADR-0273) — structured prepend remains the mechanism.
