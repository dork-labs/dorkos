---
slug: agent-teams-seat-asides
number: 261115-194346
created: 2026-11-15
status: specified
---

# Private messages into room seats

**Status:** Approved and frozen — implementation authorized by root
**Author:** Codex `/root/trust_reconciliation`, gpt-6.1-sol workhorse fallback
**Date:** 2026-11-15
**Current integration baseline:** `1d34333f113d25cbc8a24197857dc6b6acc93e89` (Code integrated #3824 before functional fixes). Earlier head-specific proof remains historical; current fix validation is recorded separately.

## Overview

Allow registered local agents to address room seat chat ids through private room asides. A valid answer to a seat's earlier DM needs no public trace. Unsolicited writes require an unbridged room; one body-free notice covers each pending sending-actor/seat-generation exchange. No body is posted on the sender's behalf and no ordinary dispatch enters a seat.

## Background / Problem Statement

At base a23056f0a528393a9f3eea312c516ed8660f77b6, agent-id DMs already work from seats. Chat-id answers back into a seat fail roomBound. Security specified D1-D4 and M2-M9; Dorian chose D1 and D2 yes, D3 no switch, D4 unchanged. The earlier general chat-origin proposal is superseded. Existing RoomSeatReports supports same-agent auto-reports as asides, but uses unbounded process-local chains and cannot simply become a peer-message service.

Prerequisites: DOR-3817 Part A opens/reviews first, then DOR-4468; this branch must use their integrated shared predicate/prompt removal without reimplementing them. Root authorized implementation after Part A PR#3809 and DOR-4468 PR#3810 were independently reviewed, opened in order and required-green. Neither prerequisite source change is required for this independent route; do not duplicate their predicate or prompt edits.

## Goals

- D1 answers and D2 unsolicited messages in unbridged rooms arrive as queue-only seat asides, with authoritative identity validation.
- Preserve all immutable sender bounds/marks/outside words and add current sender/room restrictions at launch.
- Outside provenance remains a stamp and never creates a new whole-level cap; actual existing permission bounds still constrain the turn.
- New text is fenced and defused, including @file references and leading commands, with untrustedText carried through every runtime's room input.
- Bound pending work, batch it deterministically and charge automatic room/global turn budgets.
- Keep meaningful receipts and honest terminal failures across movement, queue expiry, shutdown and restart.
- CHAT_SENDABLE_ORIGINS, bridge direct-chat refusal, unattended redirect and chat_stop authority remain unchanged.

## Non-Goals

No origin config, bridge switch, bridge initiate-consent exception, new schedule/heartbeat write path, ordinary seat dispatch, seat steering/interruption, new sender room membership requirement, auto-report rewrite, project-lead prompts, DOR-4148 durability work, tool-read provenance expansion, client redesign or paid/live validation.

## Technical Dependencies

Existing Hono/capability authenticated callers, Mesh registered agent identity, chat_messages receipts/ceilingJson, RoomSessionLedger and member generation, RoomTurnBudget, room freshness/aside claim, shared untrusted-text and fence helpers. Existing Db/Drizzle migration conventions; no added package or service. DOR-3817 shared isChatSendable remains the ordinary-chat predicate and cannot treat a seat as ordinary sendable.

## Detailed Design

### 1. Boundary and target classification (M3/M6)

Add a narrow seat delivery port to chat-message composition, with separate resolve/admit and enqueue/settle operations. Implement a dedicated rooms collaborator under `rooms/handoff/seat-messages*.ts`; do not weaken RoomSeatReports's existing same-agent auto-report guard.

Ordinary `to=<agent id>` resolution remains its current DM behavior. Only an explicit chat-id target is considered for the new seat route. Verified SessionFacts must establish that it is a room seat, and authoritative ledger/member/agent records must resolve it; a roomBound flag alone is not enough. Unknown/unavailable seat lookup refuses without plain-dispatch fallback. Existing SELF/canonical-self guards remain.

Capture `{ roomId, authorId, joinedAt, targetSessionId, agentPath/registered identity }` server-side at admission. Check live room, non-archived state, current membership and identity. A historical session is eligible only if it still identifies this exact seat membership in this room; never follow an author into another room. Revalidate the captured scope immediately before every launch/retry and after awaited placement if identity can change there. Leaving/rejoining refuses even when a fake clock produces an identical joinedAt. Pin the original session ledger identity and require bindingForSession(originalSessionId) to still resolve to the current same room/author binding: removeMember deletes room_sessions, whereas genuine runtime rekeys retain authoritative retirement links. A fresh rejoined seat cannot be accepted on timestamp equality alone. Persist this original scope session id separately from the mutable receipt destination id. Same-room native rekey can resolve the current session after fresh validation. A moved-room/replaced member target returns NOT_ALLOWED (or an already accepted row settles failed with stable reason NOT_ALLOWED), never DM fallback or silent retarget.

Reply classification is separate from reach. An explicit replyTo must name a server row whose fromSessionId identifies this target seat (canonical aliases validated) and whose toSessionId identifies the verified caller. Unknown/deleted/unrelated/mismatched replyTo is NOT_ALLOWED, even though D2 permits unsolicited sends. Without explicit replyTo, use only the newest valid unanswered seat→caller row; if none, classify unsolicited. No source text, summary, caller-supplied author or room field supplies authority. Mark an original ask replied only after the new delivery is accepted, never on rejected admission.

CHAT_SENDABLE_ORIGINS is byte-for-byte unchanged. assertChatSendable/isChatSendable still reject room seats for ordinary dispatch and stop. Relay-binding, outside-sender, connector-event, heartbeat, schedule, null and harness behavior remains as before, including scheduled/beat reply redirect. No person or agent bridge-enable switch is introduced.

### 2. Persisted receipt and route ownership

Use existing chat_messages for per-message sender/body/nonce/ceilingJson/status, adding explicit internal route metadata: `delivery_route` (`chat` default, `seat`), `seat_room_id`, `seat_author_id`, `seat_joined_at` and immutable `seat_session_id`. Default/migrate old rows to chat. Scope fields are mandatory for route seat; add migration/schema invariant or equivalent validated decoder so a malformed seat row is failed, never treated as ordinary chat. No public request may select these fields.

Each seat row retains a non-null unique queueMessageId; do not use null because that already means normal launch-cap holding. All normal cap retry, plain queue batching and lifecycle/recovery readers must either select route chat or explicitly ignore route seat. A queued seat row must never be offered to dispatchSessionMessage through ordinary retry, including after boot.

Admission revalidates active ask state and reserves at most one pending answer per ask using queued/working seat receipts in the same consolidated DB transaction. Only message/start asks in working/delivered/steered state qualify. The transaction’s actual row classification drives every bridge and trace guard. An authentic stale/reserved ask is unsolicited; forged identity never falls back. Before accepting an unsolicited send into an unbridged room, persist its row and, unless the same verified actor/current seat generation already has pending unsolicited work, one local body-free notice. A bridged duplicate refuses even if coalescing would otherwise skip a notice. If trace or row persistence fails, neither effect commits and admission fails. Publish trace/receipt events only after commit through existing room audience rules. Reserve queue capacity synchronously before acceptance, release reservation on rollback, and avoid a race where receipt exists but no bounded queue slot owns it. Valid reserved answers persist only the row; no trace. A winning delivered receipt CAS and active ask→replied update are atomic; thrown ask writes roll delivery back into bounded terminal retry. Failed/recovered CAS losers never mark an ask. Original ask-sender activity is preserved across native aliases.

No automatic restart replay. On boot, explicitly fail leftover queued/working seat-route rows with an interruption reason and emit receipt activity when listeners are ready. Keep the durable row and trace as audit evidence. On orderly stop, settle pending rows failed, stop timers/listeners and release references; do not falsely mark a running aside delivered before terminal outcome. Recovery uses the route metadata, not guesswork over missing ordinary queue rows.

### 2a. Frozen internal API contract

Root-approved origin amendment: canonical runtime ownership, current ledger membership and registered agent identity must all agree. A seat accepts `room` or the unchanged ordinary `CHAT_SENDABLE_ORIGINS`. Historical `relay-binding` or null origin is accepted for genuine active answers only, with the exact current server-owned active bridge tuple (bindingId, adapterId, chatId) correlated with that ledger seat; capture and revalidate the tuple through placement/native rekeys. Schedule, heartbeat, outside-sender, connector-event, harness and unknown origins stay closed even under inconsistent ledger/bridge rows. Unsolicited sends into any bridged seat, including inactive bridges, are NOT_ALLOWED. Revalidate this policy immediately before the aside starts so a bridge attached while queued cannot extend reach. The authoritative bridged-policy fact is separate from active bridge tuple authority. Existing unbridged person Direct-room interactive/session-relay ownership stays eligible.

The compatibility exception follows real bridge adoption: the adopter takes the router's exact binding/chat candidate and probes its transcript, while persisted launch origin is immutable. Current bridge plus ledger is server authority, not cryptographic proof an adopter invocation ran; arbitrary database writes are outside this threat model. A metadata-free adoption still cannot send until real runtime/agent ownership is recorded. No new adoption schema, caller-supplied flag, broad switch or ordinary-origin change.

New `RoomSeatMessages` exposes this internal port (names fixed for implementation/review; no HTTP or MCP request fields):

```ts
interface SeatMessageTarget {
  roomId: string;
  authorId: string;
  joinedAt: string;
  sessionId: string;
  agentPath: string;
  bridged: boolean; // server-owned policy, including inactive bridges
  bridgeOwnership?: { bindingId: string; adapterId: string; chatId: string };
}
interface SeatMessageAdmission {
  target: SeatMessageTarget;
  row: NewChatMessage; // constructed by ChatMessageService from its verified caller
  rendered: string; // per-message fenced/defused text, immutable after admission
  carried: AsideCarry; // immutable snapshot including persisted row bounds/words
}
interface RoomSeatMessagesPort {
  resolveSeatTarget(sessionId: string): SeatMessageTarget | null;
  admit(input: SeatMessageAdmission): ChatSendReceipt;
  recoverInterrupted(): number;
  stop(): void;
  idle(): Promise<void>; // deterministic test drain only
}
```

`resolveSeatTarget` reads only authoritative ledger/member/registered-agent state, returning null when the id is not a live seat; a known stale/malformed room-bound target yields NOT_ALLOWED at the service boundary. Admission synchronously revalidates, checks budget remaining and reserves capacity, writes `row` with forced server route/scope plus optional notice in one transaction, then schedules bounded asynchronous delivery and returns queued. A thrown admission error commits no row/notice, marks no ask replied and releases its capacity reservation.

The rooms collaborator owns status updates through a narrow injected receipt-store port (insert/update/pending seat rows) and injected `emitActivity` callback; imports of chat service classes are type-only. Existing ChatMessageService retains normal send handling and routes to this port before ordinary deliver. Ordinary retry/dispatcher receives no seat route. Row `delivery` retains what the sender requested for audit; the receipt note states when effective queue differs.

`recoverInterrupted` executes once after Db/rooms/chat composition and before any seat queue may accept sends. It updates only seat-route queued/working rows to failed, clears their internal pending ownership, stores the short interruption reason and schedules activity emission after listeners are ready. It does not read/replay body text or call resolve/askAside. Missing/invalid expected scope fails with NOT_ALLOWED. Repeated recovery is idempotent. `stop` disallows further admission and fails pending rows, cancels all owned waits/listeners and leaves already-running aside termination to existing room shutdown while preserving an honest receipt outcome.

Scope and carry must be validated from the committed row again if admission awaits any work. No publicly supplied object can call this port outside verified ChatMessageService composition. `idle` resolves only once all current batch ownership settles and must not create retry work.

### 3. Queue, batch and receipts (M9)

One FIFO pending inbox per pinned seat scope, at most one active batch. Defaults are 25 pending message rows per seat and 1,000 globally (root-approved resource bounds, not empirically optimal values); active rows also count toward the global bound and cannot make memory unbounded. Use existing constants/resource-limit conventions, named constants and deterministic synchronous admission. Reject overflow with existing UNAVAILABLE code and a short reason; no dropping older rows. No public queue-limit setting in this slice.

Wait at most the existing SEAT_REPORT_WAIT_MAX_MS (one hour) per admitted row. Reuse nextRelease and bounded recheck (30 seconds) rather than one busy loop/timer per message. Expiry settles the row failed and notifies sender. Shutdown clears every timer. Each inbox also owns one independent earliest-pending-deadline timer: pending messages expire and settle while an earlier aside is still executing. Expiry removes only never-launched rows, never active work, and late completion cannot resurrect those terminal receipts. Do not wait an hour inside a chat_send tool call: return an accepted queued receipt promptly, with terminal updates later.

When a seat becomes free, take the longest FIFO prefix fitting the batch limit. Final rendered, defused and fenced prompt length—including metadata, fences and separators—must be at most `5 * CHAT_MESSAGE_MAX` (100,000 under the current 20,000 constant). Do not enforce this on raw words before adding wrapper/defusing. Never mutate a batch once handed to askAside. A single maximum-sized source message must fit after wrapper overhead or be rejected clearly before acceptance; do not truncate away sender data or split a message into unsafe partial fence fragments. Later messages start the next bounded batch.

All requested delivery kinds into a seat become queue. Steer/interrupt requests return an honest note and must never invoke steerInto, interruptTurn, moveToHead or ordinary dispatch for that target. A busy seat gets no extra turn beside its current claim.

At admission, if current budget.remaining reports room/global zero, refuse with internal reason budget and existing NOT_ALLOWED code, with no accepted row or trace. This is only an early check. Charge once per batch admitted to the existing runner attempt, after placement, current-target/disposal validation and the authoritative known-pause guard. These known pre-run refusals consume nothing. Later runtime/protected-dispatch refusal may consume that existing attempt reservation; this change introduces no SDK launch hook or refund. Use remaining only as preflight and tryReserve once immediately before the runner attempt, never twice. Budget may change while queued: askAside refusal with why budget settles that batch failed with reason budget; no retry until budget refresh behind a standing promise and no normal-dispatch fallback. Under existing disabled limits, behavior remains the existing unlimited budget semantics; do not rewrite turn-count policy.

Rows become working only once the aside claim is held/launch accepted; all rows in the batch receive the same truthful terminal classification. Refused/gone/budget/session/expired/halted/failed are not delivered. Quiet/answered completed asides mean the messages were delivered to the seat; do not auto-generate a room body reply from text returned by the aside. Emit sender/recipient activity for status changes. Expose precise failure reason through existing receipt shape without inventing a public status enum.

### 4. Carry and permission semantics (M2/M4)

Snapshot sender carry at admission from the verified caller and its server-only marksAtTurnEnd plus the persisted row's ceilingJson. The JSON already stores teammate bounds, carriedOutsider and carriedWords; decode with existing conservative parsers. Immutable queued rows must not become clean because their sender later has a clean turn.

At launch, union every batch member's immutable carry with current carryFrom(sender, marksAtTurnEnd) and then withRoomMarks for the pinned target room/current room window. Preserve every bound; flatten/concatenate actual bound lists rather than choosing one sender or overwriting the first. Flags externalAuthor/outsider/outsideWords/teammate OR across all contributors. Teammate chains stay in their existing bound representation. Room carry is computed at launch, not placement/admission, so a newly exposed stranger post cannot be omitted.

Outside words and Wi-Fi marks do not independently lower the receiving seat's whole permission level. Keep the receiver's own configured room level, apply only existing explicit/teammate bounds, and carry sensitive-action raise/destructive gates. Do not turn outsideWords into permissionCeiling=runtime-default. Existing true permission bounds are never dropped merely to preserve receiver level. Tests distinguish those two requirements.

This work does not fix DOR-4148's process-local provenance loss or the standing tool-read gap. It must not claim that it does. It retains immutable row carry while pending; complete restart provenance and delegation prompt rollout still require the separate DOR-4148 work under the user-approved sequence.

### 5. Aside launch and untrusted text (M2/M5/M7)

Every new path calls askAside, retains aside:true and its no-inherited-cascade-root invariant, uses normal room placement/session locking/budgets, and passes the current room/member snapshot. No direct session dispatch is reachable from the new route. Add optional untrustedText and an internal expectedSeat scope to AsideInput. Revalidate expectedSeat in askAside before claim and again after awaited placement before the runner is called; failure returns gone internally and settles the original message NOT_ALLOWED without dispatch. Explicitly pass untrustedText true into RoomTurnRequest for seat messages; the existing roomTurnMarksOf plumbing carries it to runtimes without adding a permission cap.

Render each individual sender row with its genuine sender metadata and fence nonce. Defuse untrusted payload with defuseUntrustedPrompt before wrapping/concatenating so a source leading /cmd is neutralized even though the final wrapper starts with another line. Defuse @file expansion in payload and untrusted sender labels; retain server-only ids as data. Set untrustedText independently as runtime defense in depth. Reuse defuseMarkers/fence helpers for control markers; no hand-written pseudo-fence escaping.

The private turn is not answering the latest room entry: that entry anchors placement/context only. A post_to_room that the seat later chooses to make inherits no room-message reply root from this aside. In a bridged room, canInitiate:false therefore refuses that post rather than accepting it through agent:* reply exemption. Test via actual relay initiate-consent path, not only an aside flag assertion. No body/private summary appears in the room automatically. Existing stale-post check still governs explicit post_to_room.

### 6. Body-free trace (M8)

The first accepted unsolicited message for a verified sending actor and immutable current seat generation writes one local system notice: “A messaged B's chat in this room.” A/B are bounded sanitized server-derived agent names/handles; no body, caller summary, title, reply excerpt, nonce, filesystem path or private metadata is interpolated. Use sanitizeIdentity plus marker defusing and bounded one-line labels; canonical handles or a generic agent label are safe fallback. Keep the block within app-copy limits (name bounds must not create unbounded word count).

Further unsolicited messages from the same actor fold while its receipts remain pending/active; other registered actors get distinct notices even when names match. After durable terminal ownership ends, the next exchange gets a new notice. Actor identity uses verified agent id, falling back conservatively to its server-owned path, never a name or drafting chat. Trace is a system notice, not an agent post. It wakes no agent, inherits no answered entry/root, and is never forwarded through a bridge as an exempt reply or initiate. Publish only to existing room audience. A valid reply has no trace. A forged explicit replyTo cannot suppress the trace by being reclassified. Tests inspect durable room rows and outbound bridge deliveries, not only the prompt string.

### 7. File ownership and architecture

- New bounded rooms collaborator modules: `rooms/handoff/seat-messages.ts`, `seat-message-queue.ts`, `seat-message-prompt.ts` as needed; one owner for admission/queue/settlement.
- Routing/ports: `session/chat-messages/chat-target.ts`, a new `chat-seat-target.ts` helper, ChatMessageService early route branch and `chat-message-current.ts`/`chat-message-wiring.ts` composition. Extract oversized service methods rather than grow files over500 lines.
- Existing aside/carry: `rooms/room-trigger/aside.ts`, `rooms/handoff/seat-carry.ts` minimal typed joins, rooms factory/facade. Keep auto-report behavior and tests separate.
- Persistence: `packages/db/src/schema/session/chat-messages.ts`, generated migration `20261116110632_seat_chat_delivery_route.sql`, current journal idx202 after Code’s #3824 integration, with generated snapshot/journal, a matching down migration and migration tests; store helpers for route-scoped pending/settlement. Real regeneration against 1f86 preserves canvas opened-by197, task-permission198, due-history199 and wake-and-confirm200. Drizzle originally assigned this timestamp at idx201; Code’s integrated1d34333 then preserves main through201 and adjusts seat lineage to202. No author regeneration occurs in this functional-fix phase; parked DOR-4148/outbox migrations are not integrated here.
- Proof: dedicated seat-message service/target tests, shared chat service tests, room power/downstream and relay initiate-consent integration. No new generic config, no broad runtime edits, no client UI redesign.

## User Experience

Caller gets a normal Sent receipt. A seat always queues, and requested steer/interrupt explains that it will wait. A person in the room sees only the body-free trace for an unsolicited write. The seat reads private text as untrusted data, decides its response, and uses chat_send/post_to_room explicitly. If the seat moved, storage failed, budget is exhausted or pending work expires, sender sees an honest failed/refused receipt. No silent alternate destination.

## Testing Strategy

Use made-up identities and real chat/room stores, fake runtime runner only where needed. Tests before production implementation. Preserve red/green output per Security Must under own `.dork/flow/`; tests must fail for the missing behavior or deliberate unsafe mutant, not missing imports. Existing baseline seat-refusal tests establish the old behavior, while new acceptance proofs must be red before the new route exists.

| Must | Discriminating proof                                                                                                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2   | Valid answer/unsolicited accepted only through askAside; ordinary dispatch/steer/interrupt spies stay untouched. Stranger, Wi-Fi, relay-binding and mini-app sender carry plus newly exposed room marks survive to runner.                                                                                                               |
| M3   | Explicit unrelated/missing/wrong-sender/wrong-recipient replyTo returns NOT_ALLOWED; implicit valid ask is reply, no ask is unsolicited; move/leave-rejoin/replaced agent while queued fails NOT_ALLOWED, with no DM fallback.                                                                                                           |
| M4   | Marked sender to Full seat preserves configured level and mark gates raises/destruction; true preexisting sender/teammate bounds and all batched contributors still hold. Later clean sender cannot erase immutable carry.                                                                                                               |
| M5   | Real bridged-room aside plus explicit post_to_room is an initiate; canInitiate:false produces no outbound delivery, even anchored near stranger input. Removing aside/no-root must make proof red.                                                                                                                                       |
| M6   | Exact origin allowlist snapshot unchanged from Part A; direct relay/outside/event/unattended/null/harness refusals and unattended-reply redirect unchanged; no public config/tool bridge switch; chat_stop still rejects seats.                                                                                                          |
| M7   | Source /cmd and @~/.ssh/id_rsa, marker strings and hostile labels are neutralized in actual runner input across supported runtimes; untrustedText is true without a fabricated level cap.                                                                                                                                                |
| M8   | One accepted unsolicited send creates exactly one local body-free notice; valid reply zero; body/summary/title sentinel never occurs in any room/bridge artifact; fence-like name neutralized; transaction failure leaves neither row nor notice.                                                                                        |
| M9   | N queued to busy seat become one fitting batch, larger prefix starts next; final defused prompt incl separators <=100000. Per-seat/global boundary exact, timers bounded, 1h expiry and shutdown/restart receipts honest. One budget charge/batch; zero remaining refuses reason budget; exhausted-at-launch rows fail without dispatch. |

Additional regressions: concurrent admission cannot exceed caps, one active aside per seat, same-room canonical rekey, unknown stale ledger, capability caller spoofing, recovery route isolation, auto-report same-agent restriction unchanged, raw content never automatically posted, existing freshness checks unchanged. No browser/live desktop/ports/paid paths. Check uptime before heavier commands and hold when load exceeds16. Targeted Vitest paths only under new coordination rule; no broad test suite. Package-scoped typecheck/lint and required affected verification must respect the same load gate and root coordination.

## Performance Considerations

Named hard resource bounds cap receipt references/batch memory and timers. One release listener/recheck per active seat queue, not per message. FIFO prefix preparation uses final rendered text once; no repeated full-room transcripts in queue. Existing indexed receipt/room identity reads; new route recovery index only if query shape requires it. No model call for admission, batching or reply classification.

## Security Considerations

Authenticated server caller, authoritative seat scope and explicit-reply validation prevent identity/reply spoofing. Narrow route isolation preserves bridged/unattended restrictions. Immutable sender carry and current room join avoid queued laundering; untrusted text never changes instruction level. Local trace discloses prompting without leaking private content. Existing login-off local-shell trust and tool-read provenance gaps remain documented, not claimed fixed. Changed permission/fanout paths require Security exact-range review; PR has hold+review:deep and Code owns reviewer labels/arming/releases.

## Documentation

Update spin-off chat specification §4 and tool description only for the factual seat-aside behavior; keep project-lead/prompt rollout in assigned later tickets. Record red/green evidence and QA needs. User-facing error/notice copy follows writing-for-humans plus writing-app-copy. No savings/performance claim or claim that private words reach a room publicly.

## Implementation Phases

1. Freeze reviewed spec and acquire root implementation authorization after Parts A/4468 review/open gates.
2. Tests-first route/scope/carry/text/budget/bridge/trace/resource proofs and DB route metadata.
3. Dedicated bounded inbox, aside launch, trace transaction and receipt/recovery composition.
4. Targeted verification; independent exact-base/head spec review then quality/security review. Fix on same branch. Root opens PR hold+review:deep under agreed handoff; Code handles external review routing and merge timing.

## Open Questions

- ~~(RESOLVED) Does D2 remove reply validation?~~ No. It permits the no-reply unsolicited branch; an explicit false reply claim remains NOT_ALLOWED.
- ~~(RESOLVED) Origin switches or attendance changes?~~ No switch; bridge direct chats remain closed and schedules/beats keep current behavior.
- ~~(RESOLVED) Queue defaults?~~ Parent approves25/seat,1000 global,1h wait as resource defaults. Batch bound applies to final rendered/defused text including separators.
- ~~(RESOLVED) Sender carry timing?~~ Immutable admission snapshot plus current sender/room restriction union at launch; no outside flag transformed into whole-level cap.
- ~~(RESOLVED) Durable delivery route/scope and atomic trace?~~ Parent approves server-only route plus expected seat identity in existing chat_messages, visible interruption failure after restart and atomic no-body notice. Migration regenerated as `20261116110632_seat_chat_delivery_route.sql`, originally idx201 after 1f86 reconciliation, then integrated at idx202 by Code on the current1d34333 baseline. Full API/queue/recovery contract is frozen and root authorized implementation after prerequisite PRs3809 and3810 were independently reviewed/opened/required-green.

## Related ADRs

Draft extracted `261115-194346` for isolated seat-aside delivery with bounded receipts. Existing room membership/stream ADR260726-170125, runtime-neutral context ADR-0273, trusted-default identity/outsider split ADR261006-225605, spin-off reports ADR261009-171114 and current chat specification apply. No origin-policy ADR is created.

## References

DOR-4472 Parts B+C; prerequisites DOR-3817 Part A and DOR-4468; copied coordination README/security-design-dor-4472.md final decisions and M2-M9; plan2026-11-15-agent-teams-seat-asides.md. Baseline a23056f0a528393a9f3eea312c516ed8660f77b6. DOR-4148 remains separately parked, not included in this branch.
