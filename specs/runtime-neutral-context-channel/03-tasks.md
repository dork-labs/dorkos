# Task Breakdown — runtime-neutral-context-channel

Spec: `specs/runtime-neutral-context-channel/02-specification.md` · Governing ADR: `decisions/0273-runtime-neutral-context-injection.md` (proposed, amended 2026-06-16) · Mode: full

## Overview

Replace DorkOS's current per-message context injection (which mutates the user's `content`) with a **runtime-neutral context channel**: `content` stays pristine; context flows as **structured data** down the existing layers; the server assembles **one canonical bag** per turn; each runtime adapter materializes it through a uniform **tagged prepend + render-strip**; and the strip is driven by a single source-of-truth `CONTEXT_TAG` map so it cannot drift. Git de-dup uses `excludeDynamicSections: true` (ADR-0273 decision A2) so DorkOS's git block is the single source of truth.

Phases follow the spec's own 6 Implementation Phases. **Phase 1 (git de-dup, DOR-132) is independently shippable** and lands ahead of the rest.

Binding ADR constraints respected throughout:

- (a) Claude materialization is a **structured tagged prepend + adapter strip**, NOT the `UserPromptSubmit` hook (deferred).
- (b) Git de-dup is A2: `excludeDynamicSections: true` on the Claude `sdkOptions.systemPrompt`, forward DorkOS's canonical git block.
- (c) SDK imports are confined to `apps/server/src/services/runtimes/claude-code/`; the neutral `AgentRuntime` interface must NOT reference `UserPromptSubmit` or any SDK type.
- (d) The DOR-107 command-skip guard is RETAINED under prepend.

---

## Phase 1 — Git de-dup (DOR-132, independently shippable)

### Task 1.1: Add excludeDynamicSections to Claude system prompt

- **Size**: small
- **Priority**: high
- **Dependencies**: none
- **Can run parallel with**: none

**Technical Requirements**

- Touch `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` only. No interface changes, no new files.
- Set `excludeDynamicSections: true` on `sdkOptions.systemPrompt` (currently `{ type: 'preset', preset: 'claude_code', append: systemPromptAppend }`, ~line 265) so the preset stops injecting native working-directory/auto-memory/git. DorkOS's own `<git_status>` block becomes the single source of truth.
- Maps to Linear DOR-132.

**Implementation Steps**

1. Add `excludeDynamicSections: true` to the `systemPrompt` preset object with an explaining comment (ADR-0273 A2; ends per-turn double git injection).
2. Resolve **G1** (re-injection under per-resume): observe whether the SDK re-injects stripped sections into every resumed turn's first message vs only at true session start; document tolerate-vs-compensate.
3. Resolve **G2** (env duplication): observe whether `excludeDynamicSections` suppresses the preset `<env>` block or only cwd/memory/git; document (feeds Phase 5's env-entry decision). DorkOS's own env comes from `buildEnvBlock` via `systemPrompt.append`.

**Acceptance Criteria**

- [ ] Satisfies **AC3**: git status injected exactly once per turn (no preset + body duplicate), server-derived, identical format — verified on a real multi-turn session.
- [ ] G1 and G2 findings documented in the PR/Linear comment.
- [ ] Test asserts the built `sdkOptions.systemPrompt` carries `excludeDynamicSections: true`.
- [ ] Tests written and passing; `pnpm typecheck` / `pnpm lint` clean.

---

## Phase 2 — Shared model

### Task 2.1: Create shared additional-context module (types, CONTEXT_TAG, Zod schemas)

- **Size**: medium
- **Priority**: high
- **Dependencies**: none
- **Can run parallel with**: none

**Technical Requirements**

- New module `packages/shared/src/additional-context.ts`, exported via `@dorkos/shared/additional-context` subpath (add to `package.json` `exports`, mirroring `@dorkos/shared/agent-runtime`).
- Define `ContextKind`, `ContextScope`, `AdditionalContextEntry` (discriminated union), `AdditionalContext`, `ClientContext`, `GitStatusData`, `EnvData`, `RelayContextData` (verbatim union from the spec — see JSON description for the exact code).
- `CONTEXT_TAG: Record<ContextKind, string>` — single source of truth for tag names, read by BOTH the formatter and the stripper.
- Zod schemas mirroring `UiStateSchema`: `ClientContextSchema`, per-entry validators, discriminated `AdditionalContextEntrySchema`. Keep import graph acyclic.
- TSDoc on every export (lint rule 4). Entries carry structured `data`, NEVER pre-formatted text.

**Implementation Steps**

1. Write the module with types + `CONTEXT_TAG` (`satisfies Record<ContextKind, string>`).
2. Add Zod schemas (co-located or in `schemas.ts`, whichever keeps imports acyclic).
3. Add the subpath export to `packages/shared/package.json`.
4. `pnpm --filter @dorkos/shared build`.

**Acceptance Criteria**

- [ ] `@dorkos/shared/additional-context` resolves and exports all named symbols + schemas.
- [ ] `CONTEXT_TAG` has exactly one entry per `ContextKind` (compile `satisfies` + runtime key-count test).
- [ ] `ClientContextSchema` accepts `{ uiState, queued: true }`.
- [ ] Tests written and passing; `pnpm typecheck` / `pnpm lint` clean.

### Task 2.2: Wire ClientContextSchema into SendMessageRequestSchema (drop standalone uiState)

- **Size**: small
- **Priority**: high
- **Dependencies**: 2.1
- **Can run parallel with**: —

**Technical Requirements**

- Touch `packages/shared/src/schemas.ts`: add `context: ClientContextSchema.optional()` to `SendMessageRequestSchema`, REMOVE the standalone `uiState` field (no legacy parallel field — repo standard).
- Update `apps/server/src/routes/sessions.ts` (~line 344 destructure, ~line 377 `triggerTurn` call) to use `context`. Coordinate field name `context` with task 3.3.

**Implementation Steps**

1. Edit the schema (add `context`, drop `uiState`); keep `SendMessageRequest` type export.
2. Update the route destructure/forward to `context`.
3. `pnpm --filter @dorkos/shared build`.

**Acceptance Criteria**

- [ ] Schema accepts `{ content, context: { uiState, queued: true } }` and rejects a top-level `uiState`.
- [ ] Route forwards `context`.
- [ ] Tests (`sessions-multi-runtime.test.ts`, schema tests) updated to `context`.
- [ ] Tests written and passing; lint/typecheck clean.

---

## Phase 3 — Server assembler + neutral interface

### Task 3.1: Add MessageOpts.additionalContext + RuntimeCapabilities.nativeContext, drop MessageOpts.uiState

- **Size**: small
- **Priority**: high
- **Dependencies**: 2.1
- **Can run parallel with**: 2.2

**Technical Requirements**

- Touch `packages/shared/src/agent-runtime.ts`. Interface must NOT reference `UserPromptSubmit` or any SDK type (constraint c).
- `MessageOpts`: add `additionalContext?: AdditionalContext` with the out-of-band contract TSDoc (must not mutate `content`; must never render as user-authored text); REMOVE `uiState?`.
- `RuntimeCapabilities`: add `nativeContext: ContextKind[]` with TSDoc. Do NOT add `contextDelivery` (deferred, G4).
- Update producers: `CLAUDE_CODE_CAPABILITIES.nativeContext = []` and `TEST_MODE_CAPABILITIES.nativeContext = []` in their `runtime-constants.ts`.

**Implementation Steps**

1. Edit `MessageOpts` and `RuntimeCapabilities`; import `AdditionalContext`/`ContextKind`; drop unused `UiState` import if dead.
2. Add `nativeContext: []` to both capability constants.
3. `pnpm --filter @dorkos/shared build`; let `pnpm typecheck` flag remaining `uiState` readers (fixed by 3.2/3.3/5.x in the same batch).

**Acceptance Criteria**

- [ ] Satisfies **AC6**: `MessageOpts.uiState` gone; `additionalContext` carries ui_state; both runtimes compile.
- [ ] Satisfies **AC7** (interface half): `RuntimeCapabilities.nativeContext` exists.
- [ ] Capability tests assert `nativeContext === []`.
- [ ] Tests written and passing; lint/typecheck clean (after batch lands).

### Task 3.2: Move git derivation to a neutral server service + build context-assembler

- **Size**: medium
- **Priority**: high
- **Dependencies**: 2.1, 3.1
- **Can run parallel with**: —

**Technical Requirements**

- New `apps/server/src/services/session/context-assembler.ts` exporting `assembleAdditionalContext(opts)` (single options object: `{ cwd, clientContext?, nativeContext }`).
- Git derivation MOVES here: `deriveGitStatus(cwd)` calls neutral `getGitStatus` (from `services/core/git-status.ts`) and returns structured `GitStatusData` (NOT formatted text — formatting moves to the adapter's `renderContextEntry`, task 5.1).
- Merge rules: always derive `git_status` unless in `nativeContext`; `ui_state` from `clientContext.uiState`; `queue_note` from `clientContext.queued === true`; env per G2 decision (default: env stays via `systemPrompt.append`, no `env` entry); `relay_context` carried but unchanged here (reconciled in 5.2). Never push a kind present in `nativeContext`.
- File < 300 lines.

**Implementation Steps**

1. Implement `deriveGitStatus` mapping `GitStatusResponse | GitStatusError` → `GitStatusData`.
2. Implement `assembleAdditionalContext` honoring the omission rule.
3. Unit-test in isolation (not yet threaded into triggers).

**Acceptance Criteria**

- [ ] Satisfies **AC3** / **AC7** (assembler half): git data is server-derived and identical regardless of caller; `nativeContext` omission honored.
- [ ] Tests: merge (git + ui_state + queue_note), omission (`nativeContext: ['git_status']` drops git), git error → `{ isRepo: false }`.
- [ ] Tests written and passing; lint/typecheck clean.

### Task 3.3: Thread context through trigger-turn + embedded-turn-trigger to the assembler

- **Size**: medium
- **Priority**: high
- **Dependencies**: 2.2, 3.1, 3.2
- **Can run parallel with**: —

**Technical Requirements**

- `apps/server/src/services/session/trigger-turn.ts`: `TriggerTurnOpts.uiState` → `context?: ClientContext`; add a `getCapabilities()`/`nativeContext` dep; replace `sendMessage(sessionId, content, { cwd, uiState })` (~line 192) with assembler-produced `{ cwd, additionalContext }`.
- `apps/server/src/services/session/embedded-turn-trigger.ts`: same swap (`uiState` → `context`, run through assembler, forward `additionalContext`).
- `apps/server/src/routes/sessions.ts`: pass parsed `context` + the runtime's `nativeContext` dep into `triggerTurn`.
- Ensure the embedded `trigger` accepts `context` so the client (task 4.x) can pass it.

**Implementation Steps**

1. Update `TriggerTurnOpts`/deps; assemble then call `sendMessage` with `additionalContext` and pristine `content`.
2. Mirror in `embedded-turn-trigger.ts`.
3. Wire the route's `context` + capabilities dep.

**Acceptance Criteria**

- [ ] Satisfies **AC1** (content pristine through trigger), **AC6**, **AC7** (omission end-to-end).
- [ ] `sendMessage` receives `{ cwd, additionalContext }`, no `uiState`; `content` equals input bytes.
- [ ] Tests: `trigger-turn` (and embedded) assert bag delivery + pristine content.
- [ ] Tests written and passing; lint/typecheck clean.

---

## Phase 4 — Client

### Task 4.1: Generalize Transport.postMessage with context bag (both transports), drop standalone uiState

- **Size**: medium
- **Priority**: high
- **Dependencies**: 2.1
- **Can run parallel with**: 2.2, 3.1, 3.2, 3.3

**Technical Requirements**

- `packages/shared/src/transport.ts`: `postMessage` options bag `{ clientMessageId?; uiState? }` → `{ clientMessageId?; context?: ClientContext }`; update TSDoc; drop unused `UiState` import if dead.
- `apps/client/src/layers/shared/lib/transport/session-methods.ts` (HttpTransport): signature → `context`; body `if (options?.context) body.context = options.context;` (drop `uiState`).
- `apps/client/src/layers/shared/lib/direct/session-methods.ts` (DirectTransport): signature → `context`; forward `context: options?.context`; update `direct/services.ts` arg type if declared there.
- Both transports carry `context` identically.

**Implementation Steps**

1. Edit shared `Transport.postMessage` signature; `pnpm --filter @dorkos/shared build`.
2. Update HttpTransport body assembly.
3. Update DirectTransport forwarding.

**Acceptance Criteria**

- [ ] Satisfies **AC1**, **AC6**: `postMessage` takes `{ context }`, not `uiState`; `content` never mutated.
- [ ] Tests: `direct-transport-streams.test.ts` updated to `context`; assert body/forward carries `context`, content unchanged.
- [ ] Tests written and passing; client vitest green (rebuild `@dorkos/shared` first); lint/typecheck clean.

### Task 4.2: Replace queued-note prose with context.queued signal in use-message-queue + submit path

- **Size**: medium
- **Priority**: high
- **Dependencies**: 2.1, 4.1
- **Can run parallel with**: —

**Technical Requirements**

- `apps/client/src/layers/features/chat/model/use-message-queue.ts`: stop building the `[Note: …]` string (~line 106); flush pristine `item.content`. Extend `onFlush` to `(content, originSessionId, { queued })`.
- `apps/client/src/layers/features/chat/model/use-chat-queue.ts`: update the `onFlush` type to match.
- `apps/client/src/layers/features/chat/model/use-session-submit.ts`: thread the `queued` flag into `transport.postMessage(..., { clientMessageId, context: queued ? { queued: true } : undefined })` (~line 157). Never prepend a note to `finalContent`.
- The model's `<queue_note>` block is produced server-side (signal → assembler entry → adapter render); this task only sends the signal.

**Implementation Steps**

1. Replace the annotated flush with a pristine-content flush + `{ queued: true }`.
2. Update `onFlush` types in queue + facade.
3. Thread `queued` into the submit `postMessage` `context`.
4. Confirm the prose string is gone from the client (grep `composed while the agent was responding`).

**Acceptance Criteria**

- [ ] Satisfies **AC1**, **AC2**: flushed content equals typed bytes (no `[Note: …]`); queue origin rides as `context.queued = true`.
- [ ] Tests: `use-message-queue.test.ts`, `use-message-queue-origin.test.tsx`, `queue-integration.test.ts` assert pristine flush + `{ queued: true }` + submit forwards `context.queued`.
- [ ] Tests written and passing; client vitest green (rebuild `@dorkos/shared` first); lint/typecheck clean.

---

## Phase 5 — Claude adapter

### Task 5.1: Consume the bag via renderContextEntry + CONTEXT_TAG; respect command guard; remove buildPerMessageContext

- **Size**: large
- **Priority**: high
- **Dependencies**: 2.1, 3.1, 3.2
- **Can run parallel with**: —

**Technical Requirements**

- New `renderContextEntry(entry)` in `context-builder.ts` formatting each entry into a tagged block using `CONTEXT_TAG[entry.kind]` (NOT hardcoded tag strings). `git_status` reproduces the existing `<git_status>` line format from structured `GitStatusData` (formatting moved from `buildGitBlock`); `ui_state` JSON; `queue_note` → `<queue_note>composed while the agent was responding to the previous message</queue_note>`; `env`/`relay_context` as applicable.
- `message-sender.ts`: read `messageOpts.additionalContext`; render + join + prepend, RETAINING the DOR-107 guard exactly (command-dispatch turns prepend nothing and trim bare). `isCommandDispatch` detection unchanged.
- Remove `buildPerMessageContext` import + export and `buildGitBlock` formatting; keep `buildEnvBlock`/`buildSystemPromptAppend`. Remove now-dead `getGitStatus`/`GitStatusResponse` imports and `session.uiState` if dead (no half-migration).
- `excludeDynamicSections: true` already set by task 1.1 — do not re-add.

**Implementation Steps**

1. Add `renderContextEntry` driven by `CONTEXT_TAG`.
2. Rewire `message-sender.ts` prepend (lines ~235-253) to render the bag; keep the guard branch trimming bare on command turns.
3. Delete `buildPerMessageContext`/`buildGitBlock` formatting and dead imports/fields; `pnpm typecheck` to confirm.

**Acceptance Criteria**

- [ ] Satisfies **AC1**, **AC2**, **AC3**, **AC4**: bag rendered + prepended; command turns prepend nothing and trim; `content` pristine for plain turns; `buildPerMessageContext` gone.
- [ ] Tests: ui_state + queue_note render expected tags; git_status renders expected lines; `/compact` (known) prepends nothing + trims.
- [ ] Tests written and passing; lint/typecheck clean.

### Task 5.2: Rewrite stripSystemTags to be CONTEXT_TAG-driven + reconcile stripRelayContext

- **Size**: medium
- **Priority**: high
- **Dependencies**: 2.1
- **Can run parallel with**: 5.1

**Technical Requirements**

- `apps/server/src/services/runtimes/claude-code/sessions/transcript-parser.ts`: rewrite `stripSystemTags` (lines 142-149) to strip `<system-reminder>` + every `CONTEXT_TAG` value via a loop over `Object.values(CONTEXT_TAG)`.
- Reconcile `stripRelayContext` (lines 158-165, position-sensitive — returns content after `</relay_context>`) so both reference `CONTEXT_TAG.relay_context`; keep the boundary-split mechanism for the pipeline use (lines ~331-333) and document the two-mechanism rationale.
- Add a parametrized render-leak guard test over `CONTEXT_TAG` (also AC5 / feeds Phase 6): each tag strips from `before<tag>x</tag>after` → `beforeafter`.

**Implementation Steps**

1. Rewrite `stripSystemTags` to be map-driven.
2. Reconcile `stripRelayContext` tag name with `CONTEXT_TAG.relay_context`; comment why two mechanisms.
3. Add the parametrized guard test.

**Acceptance Criteria**

- [ ] Satisfies **AC5**: strips every `CONTEXT_TAG` value; guard proves no injected tag survives; new `ContextKind` needs no separate strip edit (map-driven).
- [ ] `stripRelayContext` and `stripSystemTags` share the tag name.
- [ ] Tests written and passing; lint/typecheck clean.

---

## Phase 6 — Tests

### Task 6.1: Integration tests — pristine content over SSE + clean rendered transcript + command dispatch unaffected

- **Size**: medium
- **Priority**: high
- **Dependencies**: 3.3, 5.1, 5.2
- **Can run parallel with**: 6.2

**Technical Requirements**

- supertest + `collectSseEvents` + `FakeAgentRuntime`/`testScenarios` per `.claude/rules/testing.md`. Rebuild `@dorkos/shared` first.
- Scenarios: (1) plain message → `sendMessage` receives byte-identical `content`, ui_state rides the bag (AC1); (2) queued message → bag has `queue_note`, rendered transcript shows pristine text with no `<queue_note>`/no `[Note: …]` (AC2); (3) `/compact` (known command) → nothing prepended, bare trimmed prompt, dispatch works (AC4); (4) clean rendered transcript (no `CONTEXT_TAG` blocks).

**Implementation Steps**

1. Capture `sendMessage(content, opts)` via a `FakeAgentRuntime` spy for content-arg assertions.
2. Drive durable stream end-to-end with `collectSseEvents` where appropriate.
3. Assert each scenario.

**Acceptance Criteria**

- [ ] Satisfies **AC1** (plain + queued + command content unmutated), **AC2**, **AC4**.
- [ ] Rendered transcript carries no injected tags.
- [ ] Tests written and passing; `pnpm test -- --run` green (not bare `pnpm vitest run` — DEV-env gotcha); lint/typecheck clean.

### Task 6.2: Unit round-trip + cache validation gate (G3)

- **Size**: medium
- **Priority**: high
- **Dependencies**: 5.1, 5.2
- **Can run parallel with**: 6.1

**Technical Requirements**

- `renderContextEntry` ↔ `stripSystemTags` round-trip per `ContextKind`; `CONTEXT_TAG` exhaustiveness; `ClientContextSchema` validation; queue signal → `queue_note` entry; `SendMessageRequestSchema` rejects top-level `uiState`.
- **G3 cache validation (AC8)**: measure prompt-cache hit-rate before/after on a multi-turn session (`usage.cache_read_input_tokens` vs `cache_creation_input_tokens`); document numbers. System prompt is now fully static + per-turn context after the cache breakpoint → hits preserved/improved.
- Re-confirm/record G1, G2; G4 stays deferred.

**Implementation Steps**

1. Write round-trip tests over every `ContextKind`.
2. Write schema + queue-signal unit tests.
3. Measure and document cache hit-rate before/after (or document manual steps + observed numbers + add a cache-correctness invariant test).

**Acceptance Criteria**

- [ ] Satisfies **AC5** (round-trip) and **AC8** (no cache-hit regression, measured + documented).
- [ ] G1/G2 findings recorded; G4 noted out of scope.
- [ ] Tests written and passing; `pnpm test -- --run` green; lint/typecheck clean.

---

## Critical Path

`1.1` (independent, ships first) — then the channel: `2.1 → 3.1 → 3.2 → 3.3` and `2.1 → 2.2 → 3.3`, converging into the adapter `5.1` (needs `2.1, 3.1, 3.2`) and `5.2` (needs `2.1`), then the test phase `6.1` (needs `3.3, 5.1, 5.2`).

Longest chain: **2.1 → 3.2 → 3.3 → 5.1 → 6.1** (with `2.2`/`3.1` feeding 3.3 in parallel).

## Parallel Opportunities

- **1.1** runs anytime, independently (separate Linear issue DOR-132) — ship it first.
- After **2.1** lands: **2.2**, **3.1**, **4.1**, and **5.2** are all unblocked and largely independent.
  - `4.1` (client transport generalization) ∥ `2.2`, `3.1`, `3.2`, `3.3` (server assembler + interface).
  - `5.2` (strip rewrite, only needs `2.1`) ∥ `5.1` (adapter materialization).
  - `3.1` ∥ `2.2` (both shared-package edits, different surfaces).
- Test phase: **6.1** ∥ **6.2**.
