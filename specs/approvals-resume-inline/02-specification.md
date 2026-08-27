# Spec: Approvals — resume-on-approval + inline card (DOR-939 / W4)

Source: the same 2026-08-06 session review. An agent-initiated destructive
capability call (e.g. `mcp.add`) returns `approval_required` immediately and the
turn ends; the operator approves via the dashboard/header approvals surface;
**nothing resumes the held call**, so the human must tell the agent to retry. The
card is not inline in the session.

> Assembled from a design spike against a moving tree — re-verify every file:line
> before relying on it. You executed; the spike remembered.

## Design (recommended: A — hold-and-await, in-session only)

Reuse the **exact** mechanism the SDK tool-permission path already uses:
`handleToolApproval` (`.../claude-code/messaging/interactive-handlers.ts` ~:677-764)
blocks the tool call awaiting the operator decision and pushes an
`approval_required` event onto `session.eventQueue`. Capability approvals simply
lack this. Add it:

- **`ApprovalService.awaitDecision(approvalId, { signal, timeoutMs })`**
  (`services/core/approvals/approval-service.ts`) resolved off the existing
  `broadcastApprovalResolved` emit (`approvals/approval-events.ts` ~:33-39) /
  `eventFanOut`. Resolves `granted|denied|expired`.
- **In-session variant of `invokeCapabilityAsMcpResult`**
  (`core/capabilities/mcp-projection.ts` ~:187-229): when the gate returns
  `approval_required`, HOLD via `awaitDecision`; on `granted`, consume the token
  (`approval-service.ts` `consume` ~~:362) and re-invoke `registry.invoke` with the
  token, returning the **real** result inline; on `denied`/`expired`/timeout,
  return today's `approval_required`/`denied` payload. Thread the live `session`
  in via `capability-mcp-tools.ts` + `mcp-tools/index.ts` (~~:240) — both already
  have the `session` handle with `eventQueue`.

### GATE — verify FIRST (make-or-break)

**(Superseded — see the execution notes below.** The premise here, that a ~60s
SDK request timeout bounds an in-process tool call, was checked twice and is
false; the cap is ten minutes and is a UX choice, not a margin below anything.
The one instruction that survives is the last sentence: never let a destructive
call error where it previously returned a clean `approval_required`.)

The in-session `dorkos` server is an in-process `createSdkMcpServer`
(`mcp-tools/index.ts` ~:231-242). The MCP SDK may enforce a ~60s request timeout
(`DEFAULT_REQUEST_TIMEOUT_MSEC`) on tool calls. **If a hold exceeds it, the tool
call aborts — strictly WORSE than today.** So, as step 1: verify the actual
timeout that applies to in-process SDK-server tool calls in the shipped
`@anthropic-ai/claude-agent-sdk`. Then cap the hold at a safe margin below
`min(that_timeout, INTERACTION_TIMEOUT_MS=10min)` — or raise/disable the timeout
for the capability tool call if the SDK allows it. **Never let a destructive call
error where it previously returned a clean `approval_required`.** The poll flow
stays as the fallback for anything past the cap.

### Inline card (ships WITH the hold — required, not optional)

The hold is only safe if it registers in the projector's pending-interaction set,
so the turn stall watchdog (`TURN_STALL_TIMEOUT_MS`, `services/session/trigger-turn.ts`
~:37-49) pauses and `DetachedTurnLifecycle` keeps the session lock. That
registration IS the inline card:

- Push a session event (`approval_required`, or a new `capability_approval_required`
  carrying `approvalId`, `capabilityId`, `capabilityTitle`, `summary`, `expiresAt`)
  onto `session.eventQueue` from the in-session capability adapter.
- Register it in the shared session-stream schema + `SESSION_EVENT_TYPES`
  (`shared/lib/transport/stream-manager.ts` ~:128).
- Project it into an inline card in
  `features/chat/model/stream/project-session-turn.ts`. The card's approve/deny
  call the SAME capability decision route the dashboard uses —
  `use-approval-decision.ts` → `POST /api/approvals/:id/grant|deny` — **not**
  `approveTool`. One `approvalId`, rendered both inline and in the dashboard,
  resolved by one route; `approval_resolved` retires both cards.

### Sessionless surfaces keep poll

HTTP + external `/mcp` have no `session` (`registry.ts` ~:83-91) → keep the
token/poll flow (`retryChannel: 'mcp-argument' | 'http-header'`). A is an
**in-session-only** enhancement layered over the unchanged poll flow.

## Files to change

- `services/core/approvals/approval-service.ts` — `awaitDecision`.
- `core/capabilities/mcp-projection.ts` — in-session hold variant.
- `runtimes/claude-code/mcp-tools/capability-mcp-tools.ts` + `mcp-tools/index.ts` —
  thread `session` + the hold path; push the session event.
- shared session-stream schema + `shared/lib/transport/stream-manager.ts`
  (`SESSION_EVENT_TYPES`).
- `features/chat/model/stream/project-session-turn.ts` — inline card projection;
  a `CapabilityApproval` card component (reuse `use-approval-decision.ts`).
- `services/session/trigger-turn.ts` / `stall-guard.ts` — ensure the hold lands in
  the pending-interaction set.

## Tests (discriminating — REVIEW.md; this touches the turn lifecycle, a recovery/

## liveness path, so cross the seam)

- `awaitDecision` resolves on grant; falls back on deny/timeout.
- in-session hold: a destructive capability call blocks; an operator **grant**
  resumes it and returns the **real** result (assert the real result, not "some
  result"); a **deny** returns denied; a **timeout** returns the exact
  `approval_required` fallback.
- the emitted inline card carries the real hold cap (superseded by DOR-987: this
  read "the hold cap is below the verified MCP request timeout", which pinned a
  number nothing in the path reads — see the execution notes below).
- the session event is emitted and projects to an inline card; approving via the
  card resolves the SAME `approvalId` and retires the dashboard card too.
- revert-reddens each; and confirm a hold that would exceed the cap degrades to the
  poll payload rather than erroring.
- e2e (or a server integration test if full Playwright is too heavy): a
  TestModeRuntime scenario emitting the capability approval session event + honoring
  resume; drive add→inline card→approve→agent resumes in the same turn. The
  capability HTTP surface is already API-drivable: `POST /api/agents/:id/mcp-servers`
  (202 `approval_required`) → `POST /api/approvals/:id/grant` → re-call with token.
  Name anything deferred.

## Acceptance

An agent destructive call surfaces an inline card in the session; approving it
advances the agent **in the same turn** without the human prompting it; and it is
**never worse than today** on timeout or on the sessionless HTTP/`/mcp` surfaces.

## Not in scope

Reworking the SDK tool-permission (`canUseTool`) path; the HTTP/external-`/mcp`
poll flow (stays as the fallback); threading an originating-session id onto every
approval row unless the resume proves to need it (note it if you add it).

## Execution notes (DOR-939, corrections to the spike)

Verified against the shipped tree while executing; the spike's file:line claims
were re-checked and several were off:

- **CAP / MCP timeout (corrected again in DOR-987).** The SDK-side in-process
  dispatch (`handleMcpControlRequest` in `claude-agent-sdk@0.3.177` `sdk.mjs`)
  awaits a bare promise with NO timer, and the whole CLI↔SDK control channel is
  timerless in the shipped JS — which is how the existing 10-minute
  `can_use_tool` and MCP `elicitation` holds already ride it. DOR-939 shipped a
  45s cap on the belief that `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`
  (`@modelcontextprotocol/sdk@1.29.0`, `shared/protocol.js`) was a ceiling on the
  `mcp_message` round trip. **It is not**: that default applies only when a
  caller passes no explicit timeout, and the claude binary passes one on every
  MCP tool call (default in the hours; `MCP_TOOL_TIMEOUT` overrides it). A 45s
  cap also made the feature nearly useless against a two-hour approval window.
  `CAPABILITY_APPROVAL_HOLD_CAP_MS` is therefore **ten minutes**, chosen as a
  UX/turn-budget limit (a held call keeps the session locked) rather than an SDK
  ceiling, with the poll payload as the fallback past the cap.
- **`stream-manager.ts` / `SESSION_EVENT_TYPES` do not exist.** There is no
  `shared/lib/transport/stream-manager.ts` and no `SESSION_EVENT_TYPES` constant.
  The real seams are `packages/shared/src/session-stream.ts` (`SessionEventSchema`)
  and `packages/shared/src/schemas.ts` (`StreamEventSchema` +
  `StreamEventTypeSchema`, since the in-session event queue is `StreamEvent[]`),
  plus `apps/server/src/services/session/session-event-normalizer.ts`.
- **Design refinement: a dedicated hold set, not a fourth blocking interaction.**
  The hold is registered in the projector via a dedicated `capabilityHolds` set
  (`session-state-projector.ts`) consulted by `hasPendingInteractions()`, NOT by
  adding a fourth member to `BLOCKING_INTERACTION_EVENT_TYPES` + the
  `PendingInteractionDTO` recovery machinery. The hold is short-lived (bounded by
  the cap) and its inline card recovers from the in-progress-turn replay, so the
  heavier DTO/telegram/room surface is not needed. `hasPendingInteractions()` is
  the probe `trigger-turn.ts` reads for BOTH the stall watchdog pause and the
  session-lock liveness, so this satisfies the load-bearing invariant.
- **Two session events, not one.** `capability_approval_required` (inline card +
  pending hold) and `capability_approval_resolved` (retire + drop the hold) — the
  latter keeps the capability lifecycle self-contained rather than overloading
  `interaction_resolved`.
- **Inline card reuses the dashboard card.** The client folds the event into a
  `capability_approval` `MessagePart` rendered by the approvals feature's
  `ApprovalCard` (UI composition), which already calls `use-approval-decision.ts`
  → `POST /api/approvals/:id/grant|deny`. No `approveTool`.
- **HTTP integration test already exists.** `routes/__tests__/capabilities-invoke.test.ts`
  already drives the real capability HTTP surface end-to-end (202 `approval_required`
  → `grant` → re-call with the `X-DorkOS-Approval` header → real result). The
  in-session hold/resume happens only on the in-session MCP surface (a live
  session), so it is covered by `capability-approval-hold.test.ts` against the real
  gate + registry + `ApprovalService`; a new route test would re-verify the
  unchanged poll flow.
- **Deferred:** a Playwright inline-card e2e (`approvals-resume-inline`) — the
  inline card is covered by the client projection unit test plus the reused
  dashboard `ApprovalCard`; a browser test is deferred as heavier than this slice
  warrants.
