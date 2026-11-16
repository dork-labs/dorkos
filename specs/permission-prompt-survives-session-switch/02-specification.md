---
slug: permission-prompt-survives-session-switch
number: 254
created: 2026-06-09
status: specification
authors: [Claude Code]
linear-issue: DOR-73
---

# Permission prompts survive session switch & refresh

## Status

Specification

## Overview

Pending interactive prompts in the DorkOS web chat — tool approvals (Approve/Deny), AskUserQuestion prompts, and MCP elicitation prompts — are currently delivered as transient SSE control events with no durable representation. When the user switches to another session and back, hard-refreshes, or the prompt arrives while the session is backgrounded, the prompt disappears from the UI while the agent remains blocked server-side, leaving the session permanently stuck. This spec makes pending interactions **recoverable** by re-presenting the authoritative server-side pending state to any client on (re)entry, via a hybrid pull + SSE-replay mechanism.

## Background / Problem Statement

Reproduced via `/chat:session-switch-test` (report: `test-results/session-switch-test/20260609-173746.md`; Linear DOR-73, project Chat Session Reliability). Under Default permission mode, an agent's first tool call emits `approval_required` and the SDK's `canUseTool` blocks awaiting a decision. The Approve/Deny card renders only during the live, foreground streaming turn. On session switch the client `ChatPanel` remounts against the new `?session=` id; `session-chat-store.ts` `initSession()` resets `currentParts` to `[]`, orphaning the pending card. The server keeps the interaction only in the in-memory `eventQueue` / `pendingInteractions` map; it is never written to JSONL and never replayed on reconnect (`GET /api/sessions/:id/stream` sends only `sync_connected` + transcript `sync_update`). A hard refresh therefore cannot recover it either. Evidence: both test sessions' last JSONL entry was an `assistant TOOL_USE[Bash] mkdir …` with no following `tool_result`; the directory was never created; the agent auto-denies after the ~10-minute interaction timeout.

The same gap affects all three interaction types because they share the `pendingInteractions` map and the same SSE-delivery path.

## Goals

- A pending interaction (approval, question, or elicitation) re-appears whenever and wherever its session is viewed: after a session switch, a hard page refresh, a live SSE reconnect, and on a session whose prompt arrived while it was backgrounded.
- Answering a recovered prompt resolves the **original** blocked server-side interaction and unblocks the agent.
- The server's `pendingInteractions` map remains the single source of truth; recovery re-presents existing state rather than creating a new authority.
- Recovery is idempotent: when both recovery paths fire, no duplicate cards appear; already-expired interactions are never shown; a card resolves when its result/answer arrives.
- The `#138` countdown UI continues to render correctly, seeded from a server-authoritative remaining time so it does not reset on reconnect.

## Non-Goals

- Durable persistence of pending interactions across a **server restart**. The SDK `canUseTool` deferred promise cannot be serialized or recreated; on restart the active query is lost and the user must re-send. Accepted loss boundary (sessions still derive from JSONL).
- Any redesign of permission **modes** (auto/accept/plan/bypass) — owned by specs `auto-permission-mode` (#253), `permission-mode-management` (#230), `agent-permission-mode` (#135).
- Sibling Chat Session Reliability issues: DOR-74 (URL vs SDK session id), DOR-75 (identical sidebar titles), DOR-76 (task-count flicker).
- Changing the approval/deny **request** path, the timeout duration, or the countdown visual design (#138).

## Technical Dependencies

- Internal only — no new external libraries. Express (server routes), the Claude Agent SDK `canUseTool` callback (behind `services/runtimes/claude-code/`), `@dorkos/shared` Zod event schemas, React 19 + TanStack Query + Zustand (client), the persistent EventSource sync channel (ADR-0117).
- Reuses existing infrastructure: the `#145 slack-tool-approval` single-resolve pipeline, the `#138` countdown UI, and the ADR-0117 sync stream.

## Detailed Design

### Data flow (target)

```
                          ┌──────────────── server (source of truth) ────────────────┐
SDK canUseTool ─► handleToolApproval/Question/Elicitation
                   └─ push event to eventQueue (in-band, unchanged)
                   └─ register PendingInteraction { id, type, startedAt, snapshot, resolve, timeout }
                                                   │
   recovery path A (PULL)                          │   recovery path B (PUSH/REPLAY)
   GET /:id/pending-interactions ◄─────────────────┤   GET /:id/stream connect
     → [non-expired snapshots + remainingMs]       │     → re-emit each non-expired interaction
                                                    │       as approval_required/question_prompt/elicitation_prompt (+ remainingMs)
                          └───────────────────────────────────────────────────────────┘
                                                    │
client mount ─► fetch A ─┐                          ▼
EventSource open ────────┴─► ONE idempotent renderer keyed by interaction id ─► ToolApproval / Question / Elicitation card
answer ─► POST /approve|/deny|/respond ─► resolve PendingInteraction (single-resolve; 404 if already gone) ─► tool_result clears card
```

### Server changes

1. **`PendingInteraction` carries a serializable snapshot + `startedAt`.**
   In `agent-types.ts`, extend the `PendingInteraction` union so every entry stores the data needed to rebuild its client event without the live closure: a stable `id` (the existing `toolUseId` / interaction id), `type` (`approval | question | elicitation`), `startedAt: number` (server epoch, already present in the emitted `approval_required` payload — mirror it onto the map entry), and a `snapshot` object equal to the original event `data` (toolName, input, title, displayName, description, blockedPath, decisionReason, hasSuggestions for approvals; questions array for questions; elicitation schema for elicitations). `interactive-handlers.ts` populates `startedAt` + `snapshot` when it registers the interaction (~261-334) — no change to the in-band emit or the resolve/timeout logic.

2. **Shared selector: non-expired snapshots with `remainingMs`.**
   Add a pure helper (server `services/runtimes/claude-code/`) `listPendingInteractions(session, now)` that maps `session.pendingInteractions.values()` → `{ id, type, ...snapshot, startedAt, remainingMs }`, computing `remainingMs = max(0, INTERACTION_TIMEOUT_MS - (now - startedAt))` and **excluding** entries with `remainingMs <= 0`. Reused by both recovery paths so the exclusion/`remainingMs` rule lives in one place. Surface it on the runtime/session-store as `getPendingInteractions(sessionId)`.

3. **Path A — `GET /api/sessions/:id/pending-interactions`** (`routes/sessions.ts`).
   Returns `{ interactions: PendingInteractionDTO[] }` from `getPendingInteractions`. `404` if the session is unknown; `{ interactions: [] }` if none (also the correct post-restart answer). Documented in `/api/docs`.

4. **Path B — re-emit on persistent stream connect** (`routes/sessions.ts` `GET /:id/stream`, ~548-598, and/or `session-broadcaster.ts`).
   Immediately after the existing `sync_connected` frame, iterate `getPendingInteractions(sessionId)` and write each as its native event type (`approval_required` / `question_prompt` / `elicitation_prompt`) with the same `data` shape as the original emit plus `remainingMs`. This runs on every (re)subscribe, so it covers EventSource auto-reconnect and background→foreground without new client logic. No change to the file-watcher `sync_update` path.

5. **Resolve path unchanged, guard verified.**
   POST `/approve` & `/deny` (and the question/elicitation `/respond`) continue to call the runtime resolve which looks up the interaction id and resolves once, then deletes it. Verify the HTTP route returns a benign result (404/`{resolved:false}`) when the id is already gone (matches the `#145` Slack stale-click guard) so a duplicate/stale answer from any surface is a safe no-op — never a double tool-execution.

### Shared schema changes

In `@dorkos/shared` event schemas, add an optional `remainingMs: number` to the approval/question/elicitation event schemas (alongside the existing `timeoutMs` / `startedAt`). The new DTO for path A reuses the same per-type fields. `remainingMs` is server-authoritative so countdowns resume at the correct offset and never reset on reconnect.

### Client changes

1. **Idempotent renderer keyed by interaction id.**
   `stream-tool-handlers.ts` `handleApprovalRequired` (and the question/elicitation handlers) must **upsert** by id: if a `currentParts`/message part already exists for that interaction id, update it in place rather than appending a duplicate. This is the linchpin that makes the two recovery paths safe to both fire.

2. **Pull on mount.**
   Add `usePendingInteractions(sessionId)` (TanStack Query) that fetches `GET /:id/pending-interactions` on session mount and feeds each result through the same idempotent handler, seeding the `#138` countdown from `remainingMs`. Wire it where `use-session-history.ts` hydrates a session so it runs after `initSession()` resets state. Sequence: subscribe to the sync stream, then fetch — so a live event arriving during fetch is deduped, not missed.

3. **Process re-emitted events.**
   No new handler needed for path B: the re-emitted `approval_required` / `question_prompt` / `elicitation_prompt` events flow through `use-session-history.ts` `syncEventHandlers` into the same idempotent renderer. Add the event types to `syncEventHandlers` if the sync handler currently ignores them.

4. **Resolve-on-result + proactive timeout.**
   When a `tool_result` (or answer) arrives for an interaction id, transition its card to resolved. When a card's countdown reaches zero with no result event (clock skew vs. server auto-deny), mark it timed-out locally (already the #138 direction) so stale prompts never linger.

### Why this shape

The server already holds authoritative pending state; the only missing pieces are a way to read it (path A) and a way to be told about it on (re)connect (path B). Reusing the ADR-0117 sync stream avoids a bespoke channel and automatically covers every surface that opens it (web today, Obsidian/others later). Mirroring Temporal's Query (pull) + Signal (push), the GET endpoint is a side-effect-free read and the resolve routes remain the single mutation.

## User Experience

- Operator running concurrent sessions switches between them freely; a session waiting on Approve/Deny (or a question/elicitation) shows its prompt the moment it is viewed, with an accurate countdown — never a dead "Thinking…".
- Hard refresh restores any pending prompt.
- Approving a recovered prompt runs the previously-gated tool and the agent continues; denying cancels it. No duplicate cards, no double execution.

## Testing Strategy

- **Server unit/integration** (`apps/server/.../routes/__tests__/sessions-interactive.test.ts`, runtime interactive tests):
  - `GET /:id/pending-interactions` returns active interactions with `remainingMs`, excludes expired, `404`s unknown session, `[]` when none. _(Validates path A and the exclusion rule.)_
  - On `GET /:id/stream` connect, pending interactions are re-emitted as their native events with `remainingMs` after `sync_connected`; expired ones are not. _(Validates path B.)_
  - `listPendingInteractions` selector: `remainingMs` math and expiry boundary. _(Edge: `now - startedAt == timeout`.)_
  - Resolve guard: a second `/approve` for an already-resolved id is a safe no-op (no second `resolve`/execution). _(Validates double-resolution safety.)_
- **Client** (`use-chat-session-sync.test.tsx`, `session-chat-store.test.ts`, `stream-manager.test.ts`):
  - Idempotent upsert: handling the same `approval_required` id twice yields one card. _(Core dedup guarantee.)_
  - `usePendingInteractions` hydrates cards on mount and seeds countdown from `remainingMs`.
  - `tool_result` for a pending id resolves the card; countdown-to-zero marks timed-out.
- **Browser acceptance** — `/chat:session-switch-test perm:default` check #6 PASSES (switch-away-and-back + hard refresh both restore Approve/Deny; approving runs the tool). `perm:bypassPermissions` (DOR-77) regression-covers downstream behavior unblocked by the fix.
- Each test carries a purpose comment; tests target real failure modes (expiry boundary, duplicate delivery, stale resolve), not always-pass assertions.

## Performance Considerations

- Path A adds one small GET per session mount (reads an in-memory map; negligible). Optional low-frequency TanStack Query refetch is available but not required.
- Path B adds a bounded loop over `pendingInteractions` (typically 0–1 entries) on each stream connect. No file or DB I/O.

## Security Considerations

- The resolve gate remains single-shot and id-keyed; recovery only ever _reads_ pending state, so exposing it cannot cause a tool to run. The mutation stays on the existing authenticated approve/deny/respond routes.
- `remainingMs`/expiry exclusion prevents acting on an interaction the server has already auto-denied.
- `startedAt` is server-assigned, so a reconnecting client cannot extend an interaction's deadline.

## Documentation

- `/api/docs` entry for `GET /api/sessions/:id/pending-interactions`.
- Note the re-emit-on-connect behavior in `contributing/` SSE/streaming notes and reference ADR-0117.
- Update the `/chat:session-switch-test` harness expectation: check #6 should pass post-fix (flip the "known regression" note).

## Implementation Phases

- **Phase 1 — shared plumbing + Path A (pull):** `startedAt`+`snapshot` on `PendingInteraction`; `listPendingInteractions` selector; `remainingMs` in shared schemas; `GET /:id/pending-interactions`; client idempotent upsert + `usePendingInteractions` on mount; resolve-guard verification. Fixes the literal DOR-73 acceptance (every switch/refresh/open-backgrounded is a mount).
- **Phase 2 — Path B (re-emit on connect):** emit pending interactions on `GET /:id/stream` connect; ensure `syncEventHandlers` routes them through the same renderer. Adds live-reconnect / background-tab / multi-surface resilience. Ships in the same spec.
- **Phase 3 — acceptance + docs:** run `/chat:session-switch-test` both variants; flip the harness known-regression note; `/api/docs` + contributing notes.

## Open Questions

None — scope and approach were resolved during ideation (see `01-ideation.md` §6: all interaction types; hybrid pull + re-emit; no restart durability; idempotency + expiry guards; acceptance via `/chat:session-switch-test`).

## Related ADRs

- ADR-0117 — Direct SSE as sole web client transport (the persistent sync stream extended by Path B).
- Candidate new ADR (auto-extract): "Recover pending interactions via hybrid pull + SSE re-emit; keep `pendingInteractions` in-memory authoritative (no cross-restart persistence)."

## References

- Linear: DOR-73 (project: Chat Session Reliability).
- Ideation: `specs/permission-prompt-survives-session-switch/01-ideation.md`.
- Source brief / repro: `test-results/session-switch-test/20260609-173746.md`; harness: `.claude/commands/chat/session-switch-test.md`.
- Prior art: `specs/tool-approval-timeout-visibility` (#138), `specs/slack-tool-approval` (#145), `specs/chat-streaming-session-reliability` (#93), `specs/cross-client-session-sync` (#25), `specs/session-state-manager` (#190).
- Research: `research/20260324_sse_resilience_production_patterns.md`, `research/20260316_tool_approval_timeout_visibility_ux.md`, `research/20260315_agent_runtime_permission_modes.md`, `research/20260317_slack_tool_approval_block_kit.md`, `research/20260316_multi_client_session_indicator.md`.
