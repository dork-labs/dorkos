---
slug: permission-prompt-survives-session-switch
number: 254
created: 2026-06-09
status: ideation
linear-issue: DOR-73
---

# Permission prompts survive session switch & refresh

**Slug:** permission-prompt-survives-session-switch
**Author:** Claude Code
**Date:** 2026-06-09
**Branch:** preflight/permission-prompt-survives-session-switch
**Linear:** DOR-73 (project: Chat Session Reliability)

---

## 1) Intent & Assumptions

- **Task brief:** A chat session blocked on an interactive prompt (tool Approve/Deny, AskUserQuestion, or MCP elicitation) permanently loses that prompt the moment the user switches to another session and back — or when the prompt arrives while the session is backgrounded. The session shows only "Thinking…", the composer returns to idle, and the agent stays blocked server-side (the gated tool never runs; the server auto-denies after ~10 min). A hard refresh does not restore it. Make pending interactions **durable and recoverable** so they reappear after a switch, a refresh, a live SSE reconnect, and on any client that opens the session.

- **Source Brief:** `test-results/session-switch-test/20260609-173746.md` — live browser self-test (2026-06-09, `testing` agent, two concurrent Sonnet sessions "lakes"/"fruit", Default permission mode). Reproduced via `/chat:session-switch-test`. Verbatim evidence preserved: both sessions' last JSONL entry was `assistant TOOL_USE[Bash] mkdir …` with no following `tool_result`; the `…/testing` directory was never created; Session B rendered Approve/Deny while foreground, then lost it after a switch-away-and-back; a hard refresh did not recover it.

- **Assumptions:**
  - The server's per-session `pendingInteractions` map is the authoritative record of every outstanding interaction (it already holds `toolCallId`, `toolName`, `input`, suggestions, the deferred `resolve`/`reject`, and the timeout handle). The client is a stateless replica that must be able to recover from it.
  - The Claude Agent SDK's `canUseTool` is a live deferred Promise; it cannot be serialized/resurrected. Recovery means re-presenting the **existing** server-side pending state, not recreating it.
  - The existing `#138 tool-approval-timeout-visibility` countdown UI (`timeoutMs` / `approvalStartedAt`) is already shipped and is reused as-is.
  - The persistent sync stream `GET /api/sessions/:id/stream` (ADR-0117) is the right live channel to extend; the in-band POST `/messages` SSE stays as-is for the originating turn.

- **Out of scope:**
  - Redesigning permission **modes** (auto/accept/plan/bypass) — covered by `#253 auto-permission-mode`, `#230 permission-mode-management`, `#135 agent-permission-mode`. Adjacent surface, not this work.
  - **Disk/DB persistence across a server restart.** The SDK Promise dies with the process; the active query is unrecoverable and the user must re-send. Researched and explicitly rejected (Solution D) as architecturally infeasible without SDK support; it is an accepted loss boundary (sessions still derive from JSONL).
  - Sibling Chat Session Reliability issues: DOR-74 (URL vs SDK session id), DOR-75 (identical sidebar titles), DOR-76 (task-count flicker). Tracked separately.

## 2) Pre-reading Log

- `decisions/0117-direct-sse-as-sole-web-client-transport.md` — web client uses direct SSE (POST `/messages` streams inline); the persistent `GET /:id/stream` EventSource handles cross-client sync. The fix extends the latter.
- `apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts` — `handleToolApproval` (~261-334) pushes `approval_required` to `eventQueue`, registers a `PendingApproval` in `pendingInteractions`, and arms a ~10-min auto-deny. Source of truth; transient.
- `apps/server/src/services/runtimes/claude-code/agent-types.ts` — `AgentSession.pendingInteractions: Map<string, PendingInteraction>` + `eventQueue: StreamEvent[]`; both in-memory only, never persisted, never replayed.
- `apps/server/src/routes/sessions.ts` — POST `/messages` (~287-388) streams events once; POST `/approve` & `/deny` (~391-430) resolve the deferred promise via `runtime.approveTool`; GET `/:id/stream` (~548-598) sends `sync_connected` + file-watcher `sync_update`, but **no pending-interaction bootstrap**.
- `apps/client/.../chat/model/stream/stream-tool-handlers.ts` — `handleApprovalRequired` (~136-168) builds the `interactiveType:'approval'`, `status:'pending'` tool_call part; no persistence.
- `apps/client/.../entities/session/model/session-chat-store.ts` — `initSession()` (~193-197) resets `currentParts: []` and bumps `mountGeneration` on every session mount → the pending part is dropped on switch.
- `apps/client/.../chat/model/stream/stream-manager.ts` — per-session `ActiveStream`; `abort()` on switch clears the stream; the orphaned pending part is never re-hydrated.
- `apps/client/.../chat/ui/tools/ToolApproval.tsx` — Approve/Deny card; countdown already driven by `timeoutMs`/`approvalStartedAt` (#138). Calls `transport.approveTool/denyTool`.
- `apps/client/.../chat/model/use-session-history.ts` — `syncEventHandlers` handle `sync_update` (invalidate queries) only; no pending-interaction replay.
- Prior specs mined: `#145 slack-tool-approval` (out-of-band approval routing into the same resolve pipeline — confirms multi-surface answering already converges on `pendingInteractions`), `#138 tool-approval-timeout-visibility`, `#93 chat-streaming-session-reliability`, `#25 cross-client-session-sync`, `#190 session-state-manager`, ADR-0260 session-store port pattern.
- Research cache: `research/20260324_sse_resilience_production_patterns.md`, `…20260306_sse_relay_delivery_race_conditions.md`, `…20260316_tool_approval_timeout_visibility_ux.md`, `…20260315_agent_runtime_permission_modes.md`, `…20260317_slack_tool_approval_block_kit.md`, `…20260316_multi_client_session_indicator.md`, `…20260328_session_state_manager_architecture.md`.

## 3) Codebase Map

- **Primary modules:**
  - Server pending state: `interactive-handlers.ts` (`handleToolApproval`/question/elicitation), `agent-types.ts` (`pendingInteractions`, `eventQueue`), session store (`approveTool` resolves the deferred promise; ~248-265).
  - Server transport: `routes/sessions.ts` — POST `/messages` (in-band stream), POST `/approve`+`/deny` (resolve), GET `/:id/stream` (persistent sync), `session-broadcaster.ts` (file-watcher → `sync_update`).
  - Client receive/render: `stream-tool-handlers.ts` → `session-chat-store.ts` (`currentParts`) → `ToolApproval.tsx` (+ the question/elicitation renderers).
  - Client lifecycle: `use-session-id.ts` (`?session=` → mount/unmount), `stream-manager.ts` (abort on switch), `use-session-history.ts` (`syncEventHandlers`).
- **Data flow (today):** SDK `canUseTool` → `handleToolApproval` pushes `approval_required` to `eventQueue` + registers `PendingApproval` → drains into the in-band POST `/messages` SSE → client renders a `pending` tool_call part → user clicks → POST `/approve` → `resolve(approved)` → SDK proceeds → `tool_result` streams.
- **Cross-client sync:** `GET /:id/stream` → `watchSession()` → broadcaster emits `sync_connected` + transcript `sync_update`. **Pending interactions are never sent here.**
- **Potential blast radius:**
  - Server: `interactive-handlers.ts` (mirror `startedAt` onto the map entry; keep a serializable snapshot per interaction), `agent-types.ts` (interaction snapshot shape), `routes/sessions.ts` (new GET `/:id/pending-interactions`; re-emit block in GET `/:id/stream`), `session-broadcaster.ts`/session-store (`getPendingInteractions(sessionId)`), shared schema (`@dorkos/shared` event schemas: add `remainingMs`).
  - Client: a `usePendingInteractions` fetch on session mount, a `pending_interactions` (or per-type re-emit) handler in `use-session-history.ts`/`stream-event-handler.ts`, idempotent render guard keyed by interaction id, and `ToolApproval`/question/elicitation seeding countdown from `remainingMs`.
  - Tests: `apps/server/.../routes/__tests__/sessions-interactive.test.ts`, `claude-code-runtime-interactive.test.ts`, client `use-chat-session-sync.test.tsx`, `session-chat-store.test.ts`, `stream-manager.test.ts`, plus the `/chat:session-switch-test` acceptance harness.

## 4) Root Cause Analysis

- **Repro steps:** (1) Two concurrent sessions, Default permission mode. (2) Each agent issues a tool call → server emits `approval_required` and blocks on the deferred promise. (3) Switch away from a session that has (or is about to get) a pending prompt, then back; or hard-refresh. (4) Approve/Deny is gone; "Thinking…" persists; the tool never runs.
- **Observed vs Expected:** Observed — pending prompt vanishes, session stuck, agent blocked server-side, refresh does not recover. Expected — the prompt re-appears wherever/whenever the session is viewed, and answering it resolves the original blocked interaction.
- **Evidence:** trailing `assistant TOOL_USE[Bash] mkdir` with no `tool_result`; `…/testing` never created; B lost its prompt after switch+refresh. Full trace in the Source Brief.
- **Root-cause hypotheses (confidence):**
  - **(High)** The interaction is a transient SSE control event with no durable representation: server keeps it only in the in-memory `eventQueue`/`pendingInteractions`; it is never written to JSONL and never replayed on reconnect (`interactive-handlers.ts`, `routes/sessions.ts`).
  - **(High)** The client holds the pending part only in the live streaming turn's `currentParts`; `initSession()` resets `currentParts` (and bumps `mountGeneration`) on every session mount, orphaning it on switch/refresh (`session-chat-store.ts`, `use-session-id.ts`).
- **Decision:** Both are real and complementary. The fix re-presents the authoritative server-side pending state to the client on every (re)entry. **No new source of truth is created** — `pendingInteractions` remains canonical.

## 5) Research

- **A — Pull-on-mount** (`GET /:id/pending-interactions`, client fetches on mount). Pros: trivial, idempotent, covers cold nav/refresh/switch; `remainingMs` gives accurate countdown. Cons: extra request per nav; doesn't help an already-open client that isn't refetching.
- **B — Re-emit on SSE connect** (replay pending interactions on `GET /:id/stream` subscribe). Pros: no new endpoint; covers reconnect, background→foreground, and all sync-stream surfaces; client reuses its existing `approval_required` handler. Cons: requires idempotent client render; must skip expired interactions.
- **C — Hybrid (A + B).** Pull gives the fastest first paint; re-emit covers reconnect/multi-surface. Both feed one idempotent renderer keyed by interaction id. Mirrors Temporal's Query (pull) + Signal (push). **Recommended.**
- **D — Durable checkpointing across server restart.** Rejected: the SDK's `canUseTool` Promise cannot be serialized/resurrected; restart is an accepted loss boundary.
- **Recommendation:** **Solution C (Hybrid).** Sequence the build (GET endpoint first, then re-emit) but ship together. Reuses the ADR-0117 sync stream and the `#145` single-resolve pipeline.
- **Security/correctness:** single resolve gate keyed by interaction id — a second/stale answer finds nothing and no-ops (verify the HTTP `approveTool` route 404s on missing id, matching the `#145` Slack guard); client render must be idempotent by id and must resolve a card when `tool_result`/answer arrives; the GET response and the re-emit both **exclude expired** interactions (`remainingMs <= 0`); `startedAt` is server-assigned so countdowns don't reset on reconnect.

## 6) Decisions

| #   | Decision                         | Choice                                                                                | Rationale                                                                                                                                                                                                                                            |
| --- | -------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which blocked prompts to recover | **All pending interaction types** (tool approval + AskUserQuestion + MCP elicitation) | Same `pendingInteractions` durability gap for all three; the originating self-test exercised AskUserQuestion too. Fix the class, not the instance.                                                                                                   |
| 2   | Recovery mechanism scope         | **Hybrid: pull-on-mount + SSE re-emit on connect**                                    | Shared plumbing (store `startedAt`, add `remainingMs`, idempotent render) serves both; adds reconnect/background/multi-client resilience and Obsidian coverage for ~60 extra server lines; aligns ADR-0117 sync stream as the live-recovery channel. |
| 3   | Restart durability               | **Out of scope** (in-memory + replay only)                                            | SDK Promise is unrecoverable across restart; persisting metadata can't resurrect the await (Research Solution D). Accepted loss boundary.                                                                                                            |
| 4   | Correctness prerequisite         | **Idempotent render keyed by interaction id + resolve-on-result + expired-guard**     | Prevents duplicate cards and double-resolution across pull/re-emit/multi-surface; ensures stale/expired prompts don't linger. Verify the existing single-resolve 404 guard on the approve/deny route.                                                |
| 5   | Acceptance gate                  | **`/chat:session-switch-test` matrix green**                                          | `perm:default` must pass check #6 (Approve/Deny survives switch-away-and-back and hard refresh; approving runs the previously-gated tool). `perm:bypassPermissions` (DOR-77) covers the downstream checks this bug currently blocks.                 |

---

**Next:** `/ideate-to-spec specs/permission-prompt-survives-session-switch/01-ideation.md`
