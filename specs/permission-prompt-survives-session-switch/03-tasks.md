# Tasks — Permission prompts survive session switch & refresh

**Spec:** `specs/permission-prompt-survives-session-switch/02-specification.md`
**Slug:** `permission-prompt-survives-session-switch`
**Mode:** full
**Generated:** 2026-06-09

Make pending interactive prompts (tool approval, AskUserQuestion, MCP elicitation) durable/recoverable so they survive session switch, hard refresh, and live SSE reconnect. The server `pendingInteractions` map stays the single source of truth. Hybrid recovery: **Path A** = `GET /api/sessions/:id/pending-interactions` pulled on mount; **Path B** = re-emit non-expired interactions on the ADR-0117 `GET /:id/stream` connect. Both feed ONE idempotent client renderer keyed by interaction id, carrying server-authoritative `remainingMs`, excluding expired (`remainingMs <= 0`). No cross-restart persistence.

---

## Phase 1 — Foundation (shared plumbing + Path A pull)

### 1.1 Add `startedAt` + `snapshot` to `PendingInteraction` and populate in interactive-handlers

- **Size:** small · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.4
- **Technical requirements**
  - `apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts` — extend `PendingApproval`/`PendingQuestion`/`PendingElicitation` (~52-78) with `startedAt: number` + a per-type serializable `snapshot` (equal to the original SSE event `data` minus the id).
  - No change to in-band `eventQueue.push`, resolve/reject closures, or timeout/abort logic — purely additive metadata.
- **Implementation steps**
  1. Define `ApprovalSnapshot` / `QuestionSnapshot` / `ElicitationSnapshot` interfaces.
  2. In `handleToolApproval` (~261-334) reuse the existing `startedAt` (line 268); copy `toolName`, `JSON.stringify(input)`, title/displayName/description/blockedPath/decisionReason, `hasSuggestions` into `snapshot`.
  3. In `handleAskUserQuestion` (~88-132) add `startedAt = Date.now()`, `snapshot: { questions }`.
  4. In `handleElicitation` (~141-198) add `startedAt = Date.now()`, `snapshot` from the request fields.
- **Acceptance criteria**
  - Registering each interaction stores `startedAt` (numeric) + a deep-equal `snapshot` (tests in `messaging/__tests__/interactive-handlers.test.ts`, plain `InteractiveSession` literal, no SDK mock).

### 1.2 Add `listPendingInteractions` selector with `remainingMs` and expiry exclusion

- **Size:** small · **Priority:** high · **Dependencies:** 1.1 · **Parallel with:** —
- **Technical requirements**
  - New file `apps/server/src/services/runtimes/claude-code/messaging/pending-interactions.ts` exporting `PendingInteractionDTO` + pure `listPendingInteractions(session, now)`.
  - `remainingMs = max(0, INTERACTION_TIMEOUT_MS - (now - startedAt))`; exclude `remainingMs <= 0`. `now` injected (deterministic).
- **Implementation steps**
  1. Iterate `session.pendingInteractions`, compute `remainingMs`, skip expired, flatten `id` + `type` + `startedAt` + `remainingMs` + snapshot fields into the DTO.
- **Acceptance criteria**
  - `remainingMs` math correct; boundary `now - startedAt === INTERACTION_TIMEOUT_MS` EXCLUDED; over-timeout excluded; empty → `[]`; all three types map to correct DTO shape (`messaging/__tests__/pending-interactions.test.ts`).

### 1.3 Surface `getPendingInteractions` on `AgentRuntime`, session-store, and runtime

- **Size:** medium · **Priority:** high · **Dependencies:** 1.2, 1.4 · **Parallel with:** —
- **Technical requirements**
  - `packages/shared/src/agent-runtime.ts` — add `getPendingInteractions(sessionId): PendingInteractionDTO[]` to the interface (using the shared DTO type from 1.4 — no SDK types leak).
  - `session-store.ts` (~248) — `getPendingInteractions` delegating to `listPendingInteractions(session, Date.now())`, `[]` for unknown session.
  - `claude-code-runtime.ts` (~302) — one-line delegation to the store.
  - `packages/test-utils/src/fake-agent-runtime.ts` + `mock-factories.ts` — add the method so the interface-growth fail-compile guard holds.
- **Acceptance criteria**
  - Unknown session → `[]` (no throw); registered interaction surfaces a DTO; `FakeAgentRuntime`/`createMockTransport` still type-check.

### 1.4 Add `remainingMs` to shared event schemas and a `PendingInteractionDTO` schema

- **Size:** small · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.1
- **Technical requirements**
  - `packages/shared/src/schemas.ts` — add optional `remainingMs` to `ApprovalEventSchema` (~307), `QuestionPromptEventSchema` (~326, also add optional `startedAt`), `ElicitationPromptEventSchema` (~752, also optional `startedAt`).
  - Define `PendingInteractionDTOSchema` (discriminated union by `type`) + `PendingInteractionsResponseSchema` ({ interactions }), re-exported via the `@dorkos/shared` barrels.
- **Implementation steps**
  1. Make `remainingMs` optional so the originating in-band emit still validates.
  2. Reuse existing `QuestionItemSchema` / `ElicitationModeSchema`.
  3. Keep the server selector's return type assignable to the shared DTO.
- **Acceptance criteria**
  - All three DTO branches parse; `ApprovalEventSchema` parses with AND without `remainingMs` (back-compat) — `packages/shared/src/__tests__`.

### 1.5 Add `GET /api/sessions/:id/pending-interactions` endpoint (Path A) + transport method

- **Size:** medium · **Priority:** high · **Dependencies:** 1.3, 1.4 · **Parallel with:** —
- **Technical requirements**
  - `apps/server/src/routes/sessions.ts` — GET handler: `404 SESSION_NOT_FOUND` for unknown session; `{ interactions: [] }` when none; read-only; register in OpenAPI with `PendingInteractionsResponseSchema`.
  - `packages/shared/src/transport.ts` — add `getPendingInteractions(sessionId, cwd?)` to the interface.
  - HTTP transport `transport/session-methods.ts` (mirror `getMessages` ~101; 404 → `{ interactions: [] }`); `direct-transport.ts` in-process delegation (~203); `mock-factories.ts` resolves `{ interactions: [] }`.
- **Acceptance criteria** (`routes/__tests__/sessions-interactive.test.ts`, supertest + FakeAgentRuntime)
  - 200 with approval DTO incl. `remainingMs`; expired excluded; unknown → 404; known-but-empty → 200 `{ interactions: [] }`.

### 1.6 Make client interaction renderers idempotent (upsert by interaction id)

- **Size:** medium · **Priority:** high · **Dependencies:** 1.4 · **Parallel with:** 1.5
- **Technical requirements**
  - `apps/client/src/layers/features/chat/model/stream/stream-tool-handlers.ts`:
    - `handleApprovalRequired` (~136) already upserts — keep; seed countdown from `approval.remainingMs` when present.
    - `handleQuestionPrompt` (~171) already upserts — keep; seed `remainingMs`/`startedAt` when present.
    - `handleElicitationPrompt` (~197) currently ALWAYS pushes — **fix to upsert by `interactionId`** (add `findElicitationPart` helper to `stream-event-types.ts`).
  - `ToolApproval.tsx` (+ question/elicitation renderers): when `remainingMs` present, derive deadline as `Date.now() + remainingMs` (resume offset, never reset); keep the `approvalStartedAt + timeoutMs` path otherwise. Add `approvalRemainingMs?: number` to the part types.
- **Acceptance criteria** (`stream-event-handler-pending-recovery.test.ts`)
  - Double `handleApprovalRequired` (same id) → one part; double `handleElicitationPrompt` (same `interactionId`) → one part; re-fire with `remainingMs` updates countdown seed in place.

### 1.7 Add `usePendingInteractions` fetch-on-mount and wire into use-session-history

- **Size:** medium · **Priority:** high · **Dependencies:** 1.5, 1.6 · **Parallel with:** —
- **Technical requirements**
  - New hook `apps/client/src/layers/features/chat/model/use-pending-interactions.ts` (TanStack Query, key `['pending-interactions', sessionId, cwd]`, `enabled` when sessionId set and not streaming). On data, route each interaction through the SAME idempotent handlers (synthesize the native event per `type`), seeding countdown from `remainingMs`.
  - Wire into `use-session-history.ts` so it runs AFTER `initSession()` resets `currentParts` (the drop point, `session-chat-store.ts` ~193-197). Ordering: subscribe to the sync stream first, then let the pull resolve (dedup by id makes order non-load-bearing).
- **Acceptance criteria** (`use-chat-session-sync.test.tsx` / `use-pending-interactions.test.tsx`, mock Transport)
  - Mount hydrates one card from a returned DTO; countdown seeded from `remainingMs`; concurrent live event for the same id → one card.

### 1.8 Verify single-resolve guard returns benign no-op on stale approve/deny/respond

- **Size:** small · **Priority:** medium · **Dependencies:** 1.5 · **Parallel with:** 1.6, 1.7
- **Technical requirements**
  - Confirm POST `/approve` (~391), `/deny` (~411), `/submit-answers` (~466), `/submit-elicitation` (~487) already return `409 INTERACTION_ALREADY_RESOLVED` / `404 NO_PENDING_*` (they do — delete-on-resolve in the handler closures). Fix minimally only if a gap is found.
  - Ensure the client treats a 409 as "already handled" (no error toast) — `transport/session-methods.ts` + `ToolApproval.tsx`.
- **Acceptance criteria**
  - Second `/approve` for a resolved id → 409, underlying resolve invoked exactly once; `/deny`-then-`/approve` inert; unknown session → 404; client 409 raises no user-facing error.

---

## Phase 2 — Core: Path B (re-emit on connect)

### 2.1 Re-emit pending interactions on `GET /:id/stream` connect

- **Size:** medium · **Priority:** high · **Dependencies:** 1.3, 1.4 · **Parallel with:** —
- **Technical requirements**
  - `apps/server/src/routes/sessions.ts` GET `/:id/stream` (~548-598): immediately after `sync_connected` (~567), iterate `runtime.getPendingInteractions(sessionId)` and `res.write` each as its native event (`approval_required`/`question_prompt`/`elicitation_prompt`) with the original `data` shape PLUS `remainingMs`. Wrap writes in try/catch like the heartbeat. Reuse the already-imported `SESSIONS` constant.
  - Runs on every (re)subscribe → covers EventSource auto-reconnect and background→foreground with no new client trigger. Expired already excluded by the selector.
- **Acceptance criteria** (`sessions-interactive.test.ts`, `collectSseEvents`)
  - `sync_connected` then `approval_required` (with `remainingMs`, original shape); expired NOT re-emitted; no spurious events when none pending; question/elicitation re-emit as their native types.

### 2.2 Route re-emitted interaction events through the idempotent renderer in `syncEventHandlers`

- **Size:** medium · **Priority:** high · **Dependencies:** 2.1, 1.6, 1.7 · **Parallel with:** —
- **Technical requirements**
  - `apps/client/src/layers/features/chat/model/use-session-history.ts` `syncEventHandlers` (~158-187): add `approval_required` / `question_prompt` / `elicitation_prompt` keys (the SSE dispatcher routes by event name), each feeding the SAME idempotent handlers. Keep `sync_update`/`presence_update` unchanged.
  - Wire the chat stream renderer entrypoint into the hook via params / an `applyRecoveredInteraction(event)` callback (stay within features/chat — FSD).
- **Acceptance criteria** (`use-chat-session-sync.test.tsx`)
  - Sync-stream `approval_required` renders a card; same id via Path A + Path B → one card; duplicate `elicitation_prompt` → one card.

### 2.3 Resolve recovered cards on `tool_result` and on countdown-zero timeout

- **Size:** medium · **Priority:** medium · **Dependencies:** 2.2 · **Parallel with:** —
- **Technical requirements**
  - `stream-tool-handlers.ts` `handleToolResult` (~110) already completes a matching `tool_call` part (recovered approval/question share `toolCallId`). Ensure the elicitation completion path resolves the recovered elicitation part by `interactionId`.
  - `ToolApproval.tsx` (+ question/elicitation renderers): when the #138 countdown (now seeded from server `remainingMs`) hits zero with no resolving event, transition to a local timed-out state (disable buttons, timed-out copy). Client presentation only — no server changes.
- **Acceptance criteria**
  - Recovered approval resolves on its `tool_result`; recovered elicitation resolves on its completion (`interactionId`); a near-zero `remainingMs` card times out with disabled buttons (fake timers, no arbitrary `setTimeout`).

---

## Phase 3 — Testing & Docs

### 3.1 Server cross-cutting tests: endpoint, re-emit, selector boundary, single-resolve

- **Size:** medium · **Priority:** high · **Dependencies:** 1.5, 2.1, 1.8 · **Parallel with:** 3.2
- **Technical requirements** — `routes/__tests__/sessions-interactive.test.ts` + selector unit test; supertest + FakeAgentRuntime + `collectSseEvents`; purpose comment per test; real failure modes only.
- **Implementation steps / Acceptance criteria**
  1. Path A: active interactions with `remainingMs`; expired excluded; 404 unknown; `[]` none.
  2. Path B: re-emit native events after `sync_connected` with `remainingMs`; expired not re-emitted; no spurious events.
  3. Selector boundary: `remainingMs` math; `now - startedAt === INTERACTION_TIMEOUT_MS` excluded.
  4. Single-resolve: second `/approve` → 409, resolve called once; `/deny`-then-`/approve` inert; unknown → 404.

### 3.2 Client cross-cutting tests: idempotent upsert, hydrate+countdown, resolve-on-result

- **Size:** medium · **Priority:** high · **Dependencies:** 1.7, 2.2, 2.3 · **Parallel with:** 3.1
- **Technical requirements** — `use-chat-session-sync.test.tsx`, `session-chat-store.test.ts`, `stream-event-handler-*.test.ts`; mock Transport via `TransportProvider`; verify via `pnpm test -- --run` (DEV-env gotcha).
- **Acceptance criteria**
  1. Idempotent upsert (all three types, elicitation by `interactionId`) → one card.
  2. `usePendingInteractions` hydrate-on-mount + countdown seeded from `remainingMs`.
  3. Cross-path dedup (Path A pull + Path B sync, same id) → one card.
  4. `tool_result` resolves the recovered card; countdown-to-zero marks timed-out (fake timers).
  5. After `initSession()` reset, recovery hydrate re-populates the pending part.

### 3.3 Browser acceptance via `/chat:session-switch-test` and flip the harness known-regression note

- **Size:** medium · **Priority:** high · **Dependencies:** 3.1, 3.2 · **Parallel with:** —
- **Technical requirements / steps**
  1. Run `/chat:session-switch-test perm:default` — CHECK #6 must PASS (prompt restores after switch-away-and-back AND hard refresh; approving runs the gated tool; JSONL gains the `tool_result`). Save the evidence report under `test-results/session-switch-test/`.
  2. Run `/chat:session-switch-test perm:bypassPermissions` (DOR-77) to regression-cover downstream checks.
  3. Edit `.claude/commands/chat/session-switch-test.md` — flip check #6 from known-regression to expected PASS; update the `project_permission_prompt_lost_on_switch.md` memory note status.
  4. On failure, file the gap back against the implementation task — do not weaken the check.
- **Acceptance criteria** — both variants green; check #6 reads as a pass expectation; evidence report saved.

### 3.4 Document the endpoint in `/api/docs` and re-emit-on-connect in contributing SSE notes

- **Size:** small · **Priority:** medium · **Dependencies:** 1.5, 2.1 · **Parallel with:** 3.3
- **Technical requirements / steps**
  1. Verify the OpenAPI registration (from 1.5) renders a complete `/api/docs` entry: path, `:id` param, `cwd` query, 200 `PendingInteractionsResponseSchema`, 404 `SESSION_NOT_FOUND`; describe as a read-only recovery pull with server-authoritative `remainingMs`.
  2. Add a `contributing/` SSE/streaming note: on every `GET /:id/stream` (re)connect the server replays non-expired pending interactions as native events (with `remainingMs`) after `sync_connected`; client renderer is idempotent by id; reference ADR-0117; state the hybrid Path A + Path B model and the no-cross-restart-durability boundary.
  3. Reconcile/reference the drafted `decisions/0262-recover-pending-interactions-hybrid-pull-sse-reemit.md` for `/adr:from-spec` follow-up.
- **Acceptance criteria** — `/api/docs` shows the endpoint with correct schema; a contributing guide documents re-emit-on-connect + ADR-0117; cross-restart boundary stated.

---

## Dependency graph & parallelism

- **Critical path:** 1.1 → 1.2 → 1.3 → 1.5 → 1.7 → 2.2 → 2.3 → 3.2 → 3.3 (browser acceptance is the terminal gate).
  - 1.3 also waits on 1.4 (shared DTO type); 1.5 also waits on 1.4.
- **Parallel opportunities:**
  - **Foundation kickoff:** 1.1 (server snapshot) ∥ 1.4 (shared schemas) — both depend on nothing.
  - 1.5 (endpoint) ∥ 1.6 (client idempotent renderer) once their inputs land; 1.8 (resolve-guard verify) ∥ 1.6 ∥ 1.7.
  - **Path B server** 2.1 depends only on 1.3 + 1.4, so it can proceed alongside the client-side 1.6/1.7 work.
  - **Phase 3:** 3.1 (server tests) ∥ 3.2 (client tests); 3.4 (docs) ∥ 3.3 (browser acceptance).
- **Counts:** Phase 1 = 8 tasks, Phase 2 = 3 tasks, Phase 3 = 4 tasks (15 total).
