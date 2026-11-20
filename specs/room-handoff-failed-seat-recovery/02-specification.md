---
slug: room-handoff-failed-seat-recovery
number: 261115-200450
created: 2026-11-15
status: specified
---

# Own spin-off room posts and failed-seat recovery

**Status:** Implementation authored on checked parent `47674f1`; integrated-parent reconciliation remains pending. Required identity native18, canonical1, projection1, scheduler2, cold6 and actual production runner2 have scoped GREEN evidence, with later affected-fixture/compiler corrections requiring selective reruns. A concrete wrong-owner launch bug has historical normal/persistent RED4 and GREEN4 evidence, with owner-read/erased-capability/replaced-storage GREEN3 and existing private-Registry settings GREEN11. The current owner fixture corrects its account folder/hint; these changed hashes require a fresh discriminating RED/restored GREEN before current-proof claims. Warm-stage local refused/corrupt authority bypass has historical RED2; the reviewed exact-query live-process correction and fifteen owner/stage/control cases are authored but current-hash execution is pending. Two bounded host-controller queue attempts refused without executing tests; their mutations restored byte exactly. Current package checks, guard mutations, final independent review, actual merged-parent migration regeneration and Code incident QA remain open. No shipped, verified or Done claim.
**Author:** Codex, workhorse gpt-6.1-sol
**Date:** 2026-11-15

## Overview

DOR-4328 includes redundant spin-off posting approval and failed-room-seat hand-offs. DOR-3556 adds explicit failure/exception reasons, correlated session logging and one fresh-seat recovery. This design proposes a concrete narrow recovery classifier for a prior failed Claude room turn **with intact transcript**, reusing the existing guarded seat mover. It does not claim all generic historical failed states are solved.

## Background / Problem Statement

The tickets report Code/QA failed room chats Nov14 and marketing/PM Oct31. Neither ticket supplies structured failure records. Current aside loses runner failure details and declineReason lacks failed/exception branches. Source confirms those defects. The previous design's native-transcript-deletion case changed the symptom and did not prove the reported failure; independent review required this revision. Preserve findings in 06-independent-review-revision.md. Earlier 05 audit is historical research, not the implementation plan.

Implementation preparation is stacked on checked DOR-4472 commit `47674f1ed6efe86e71526dd4bcb10b262ba2a70b`; planning seed `068ce3374bef614b4905d0cc06f09a4cad753852` is historical. Reconcile the actual parent merge/base before PR and final verification. Root authorized independent source authoring without copying/cherry-picking4472 after its contract was authored/static-reviewed. Root handles tracker/PR coordination; Code owns Security routing/reviewer labels/arming/releases/Done.

## Goals

- Verified own-child can ask the current room seat to post without an unnecessary card; same identity/membership/outside bounds remain.
- A qualifying prior failed Claude room dispatch with intact transcript gets one fresh-seat attempt for the **new hand-off**, preserving actual runtime/account/inference/settings/marks.
- Every decline includes true actionable reason and logs handoff/attempt/session/cause.
- Retain one current public seat and deterministic claim/budget/pause/Stop protections.

## Non-Goals

No direct child room posts, no general allowlist, no four-runtime continuation inspection API, no OpenCode source expansion, no transcript deletion/missing-native equivalence, no usage/account failover, no current-work replay, no retry after adapter recovery exhaustion, no bridge switch, no heartbeat/schedule change, no live agent files, no completion notices/measurement.

## Technical Dependencies

Existing room store/ledger/RoomSeatMover, Claude SDK mapper, runtime-neutral room runner/projector/event store, existing current guard readers and upstream4472 aside/carry/defusing contracts. No new packages, model calls or live database access. Follow server domain placement, SDK confinement, max-lines ratchet and real-edge testing.

## Detailed Design

### 1. Own-child identity/card regression

Use actual session_start path with verified agent A and home/linked-worktree cwd; assert durable agent ownership/forAgent, tool server caller and SDK approval resolver agree on A. post_to_room is already identity-scoped and area:null. Ordinary permitted conversation emits no redundant approval; child submits hand-off and the current seat posts. Anonymous/unregistered/spoofed-server/other-agent identity and revoked membership must not gain access. Same-agent lineage never clears outside marks or real holds. If integrated upstream is already green, preserve source and record characterization; fix only a demonstrated identity seam, not blanket policy.

### 2. Positive prior-failure classifier

**Most recent complete prior Claude room dispatch** must carry an actual structured SDK assistant error code **server_error**, failed terminal, no unknown/protected/mixed diagnostic, no requested Stop, and no later session turn. Its native transcript remains intact/readable under the known actual account and bound cwd. This starts a fresh seat for a **new different hand-off draft**; it never resends old turn_start.userMessage or repeats prior work.

Producer sources: Claude `message-event-mapper.ts:165-184` emits the structured assistant code; result mapper `:387-415` emits terminal subtype/category and stop facts. `api-error-record.ts:4-26` documents server_error in actual persisted CLI records. Generic error_during_execution is not a cause: existing SDK mapper test `:724-731` uses it for API rate limit. Output format/turn/budget caps, invalid_request/safeguard, model/account/auth/usage and unknown codes do not qualify.

Use complete server-owned turn evidence, not getStatus.lastError (only last frame). `projector-persistence.ts:85-98` records boundaries/errors/holds; `trigger-turn.ts:1085-1091` stamps room provenance. Add a narrow strict latest-complete-room-turn fold/reader, returning qualifying/blocked/unknown with exact old session, room, start/end watermark and typed diagnostic provenance. Current readAll skips malformed rows and is not sufficient. Missing/trimmed boundary, malformed row, absent room provenance, later open/completed/successful turn or any unclassified diagnostic returns unknown/nonqualifying. Record-mode seq gaps are normal; do not demand numerical continuity.

A result error_during_execution may only be a terminal wrapper when a producer-side typed fold proves it closes that same server_error with no new cause. It never qualifies alone; without that correlation mixed wrapper is unknown. Preserve code/category/refusal/start/terminal facts in internal RoomTurnReply/AsideResult rather than raw text or client-writable safeToRetry.

The producer correlation is exact: within one SDK turn, retain the typed assistant server_error witness and its raw notice fingerprint; veto any other assistant error/refusal or protected result. A final result wrapper may be marked `reason: claude-server-error-terminal` only when subtype is error_during_execution, it was not stopped, every result.errors entry is either absent/empty or an exact echo of a witnessed server_error notice, and no other diagnostic occurred. A different/new error string is unknown; never regex-classify it as safe. Persist this server-emitted marker through existing ErrorEvent.reason (schema already supports it; session-stream includes ErrorEvent shape and normalizer preserves reason). Historical unmarked wrapper remains unknown. This marker is descriptive evidence, not a tool-input authorization field; room classifier still requires the entire prior-turn witness and current guards.

### 3. Current guard checks and new-work boundary

Hold the single `(room, agent)` claim while reading evidence and planning replacement. Before moving and after every async summary/account step, compare exact old binding + evidence watermark and re-check room membership/liveness/archive, current pause/Stop, normal room budget/deadline, pending interaction/capability hold, authoritative in-flight state, helpers/background work, and actual Claude crash/account/sign-in/usage policy. `isTurnInFlight` joins dispatch/runtime lock/projector open turn. Read current `SessionCrashRecovery.willAutoResume`; if not exposed, add narrow Claude adapter read-only guard access, not a generic cross-runtime recovery API. Unknown guard answer is not allowed.

No recovery on permission, pause/halt, budget, warm ceiling, pending interaction, crash-loop, account-pin, sign-in/credentials/billing/account-hold/verification, usage, runtime-gone, protected caps or unknown diagnostics. Historical server_error cannot override a current veto. Do not use missing current text, lifecycle:error or crashed warmth as authority.

One recovery per hand-off; fresh attempt failure settles and stops. Existing busy wait cannot reset count/deadline. Do not layer room fallback after Claude resume/anchor retry or Codex native recovery. A failed current hand-off cannot become “prior failed” within its own loop; classify before this new hand-off starts and bind evidence consumption to its id. A later independent hand-off cannot repeatedly consume the same historical watermark after failed recovery.

### 4. Reuse and strengthen RoomSeatMover

Add narrow `recoverFailedSeat` entry on existing mover, using the typed candidate and current guards. It calls the **same replacement primitive** `seat-mover.ts:492-551`, retaining reseatSettings, carrySessionMarks, old seat move record, pending launch, Activity and logs. Do not duplicate them in handoff code. Do not call beforeTurn/afterLimit/ranking/pickReseatAccount; beforeTurn also enables nearly-out account failover.

Strengthen common primitive with explicit expected-old-binding compare-and-rebind. Current `room-store.ts:2234-2252` checks retired destination but updates without expected old id; add an optional expected id/store CAS used by failure recovery. After async work, binding/runtime/watermark changes abort the move. No clear-then-bind gap. Preserve all existing mover consumers and test their behavior.

Failure recovery requires explicit **same actual runtime/account/inference/billing** authority. Existing pending.accountHint and settings cannot preserve it across restart; billingAccountFor can fall back to current preferences. The earlier no-new-table assumption is explicitly superseded by root-approved architecture direction after independent review found no suitable durable requirement storage. Add one narrow requirement table plus an immutable server-only reference on the **destination session_metadata**, not room binding alone or launchOrigin; the destination may remain runtime-unbound until actual launch. The requirement is a constraint, never fabricated native/session existence. Unknown actual root, attribution, explicit credits-vs-own choice or positively proven subscription-vs-per-token billing refuses.

The existing shared mover prepares settings/marks, rechecks all current guards after awaits, then atomically validates expected binding and durable latest-failure watermark, records unique source-failure consumption, inserts requirement/reference and CAS-rebinds the seat in one SQLite transaction. Any failed write/CAS rolls back publication. No launch before binding, verified-native prewrite, second mover or general recovery outbox. Preserve no-looser mode/model/effort and all marks.

Every launch surface, including direct sends and resumes after unseat, follows the destination reference. Missing/corrupt record or inconsistent reference refuses. The common Claude configuration seam enforces immutable runtime, normalized actual root, explicit inference and billing constraints against FINAL resolved launch environment before SDK effects on first and **every subsequent** launch. Registered account mapping changes cannot change root. Credits retain normal credits resolution/refusal; no disabled-credits fallback to own account. Subscription/key changes refuse rather than silently changing bill. Native settlement does not replace billing authority: native bindings lack inference/billing facts, so the requirement remains enforceable after settled state, restart, success, failure, expiry, unseat or room removal.

Canonical alias/rekey atomically carries the metadata reference and requirement destination identity with settings/native rows. Preserve requirement id/source evidence and resolve old ids to the same restriction. Conflicting requirement/runtime/account/inference/billing at destination aborts the entire rekey; never skip insertion then delete source. Upserts/eviction/retention cannot erase the restriction on an addressable session; deliberate full deletion must handle remaining aliases consistently. Source-watermark consumption cannot repeat via aliases.

A pending requirement is launchable only by a current in-memory owned-attempt token bound to exact requirement/destination/source watermark and handoff claim. Creation timestamps are not ownership. Restart loses the token and leaves a blocked pending tombstone, never automatic replay/default launch. Only a new explicit server action may revalidate all guards and own an attempt on the already constrained destination; no second replacement or second consumption of historical failure. Fresh attempt failure settles/refuses and stops. See07 for exact contract and ADR261115-223354; the architectural amendment passed independent re-review; authored implementation remains subject to executable and final review gates.

Keep old transcript intact/readable and recordSeatMove, never rename alias. Seed fresh chat with room context and fixed failure explanation, without replaying prior task text. Only current seat speaks through post_to_room/freshness; no second public voice.

### 5. Decline and logging

Extract failed/exception formatter from room-handoff.ts. Retain typed pause/runtime refusal instead of generic failed. Fixed safe copy gives a next step; no raw draft, exception path, secret or account label in shared notices. Example blocks: “The room chat hit an error.” / “Try again, or restart it from the room’s member menu.” Final copy receives normal design review.

Pollable status and report-back share the same reason. DOR-3817 sendability remains authoritative; reporting failure cannot erase posted status. Logs correlate handoffId/room/author, prior/fresh session ids, prior turn watermark, attempt0/1 and bounded typed cause. Exception is never mislabeled as empty room history.

### File ownership and API/data changes

- Main: `rooms/handoff/room-handoff.ts`, new small decline/evidence helpers in handoff, `room-trigger/aside.ts`, `room-turn-port.ts`, minimal `turn-guards/turn-waits.ts` typed propagation.
- Shared replacement owner: `rooms/reseat/seat-mover.ts`, create-seat-mover wiring, narrow store CAS. Existing settings/marks/Activity logic remains there.
- Evidence: `session/session-event-store.ts` strict tail read or small adjacent helper, room runner collector facts, Claude SDK mapper only for necessary producer-side terminal provenance/current crash reader. Large files must not grow; extract helpers.
- Conditional identity: launch-session/session-tools/launch-resolver only if real child regression identifies loss. Upstream4472 owns chat_send seat transport/queue/defusing; don't fork it.
- Durable requirement: one narrow table + server-only session_metadata reference, atomic shared mover/store transaction and alias handling, common Claude final-configuration enforcement. No new external route, input authority or four-runtime contract. Existing handoff status remains compatible. Scoped internal failure/evidence fields and guarded store method are additive. Root serializes shared files after4472.

## User Experience

Child submits permitted room words without a redundant card. The current seat posts once. A qualifying earlier server failure can be worked around for the new draft; generic failed states remain useful declines until identified. No new screen, push or completion message. Old failed transcript remains available; manual room-member restart is fallback.

## Testing Strategy

Author discriminating tests before source changes under root authorization; execute only after root/trust releases the resource hold. Use real registry/store/dispatcher/mover and actual Claude SDK mapper→normalizer→projector→event-store seam. Only SDK transport/filesystem/clock/account registry are edge fixtures. No fake qualifying flag and **no transcript deletion** in primary acceptance test.

- **Actual intact-transcript success:** produce SDK server_error + failed terminal through real mapper/store, keep actual temporary transcript/account/settings, submit a different new hand-off. One common-mover replacement, same runtime/account/inference/marks, one post, old transcript still readable; prior userMessage never resubmitted. Revert classifier/recovery for red, restore green.
- **Classifier negatives:** successful prior turn, generic error_during_execution/API rate limit, server_error plus auth/rate/unknown frame, caps, invalid_request, requested/unrequested abort and current refusal never qualify. Terminal wrapper requires actual typed producer provenance.
- **Strict evidence:** actual SQLite missing/truncated start/end, malformed diagnostics, wrong room/agent, later open/failed/successful turn and unknown cold account/guard produce no replacement. No lenient skipped-row grant.
- **Guard races:** pause/Stop, crash-loop, pending interaction, usage/sign-in/account restriction, background work, room budget/membership/archive and changed binding/watermark during async summary all veto before CAS/launch. Same failed watermark can't be consumed repeatedly.
- **Replacement primitive:** real mover settings/marks/recordSeatMove/Activity, no ranking/failover, CAS preserving later moves, launch inference pinned; fresh failure stops without extra replacement. Existing usage mover behavior stays intact.
- **Durable launch:** actual SQLite publication rollback, missing/corrupt record, immutable reference after unseat/direct send, source consumption and alias conflicts, pending owned attempt/restart tombstone; actual Claude final-environment first/settled constraints and credits/subscription/key refusal, no fallback.
- **Reason/identity:** failed and thrown paths return useful consistent status/report reason and session/cause logs. Real own-child launch/gate positive and anonymous/spoof/member-revocation negatives. Existing4472 bridge-initiate/marks paths remain unchanged.

Focused files: new room-handoff-failed-seat suite, existing mover/ledger/room-power-downstream/room-handoff/seat-report, actual SDK mapper and event-store tests, conditional launch/gate suite. No broad tests, installs, heavy hooks or typechecks while load>16. Once permitted, targeted server lint/typecheck and independent spec then quality reviews. Code arranges isolated 390/1440 light/dark live QA without this worker opening Chrome/production ports.

## Performance Considerations

One bounded strict prior-turn read, one mover publication transaction and an indexed destination requirement lookup on each launch. No model classifier, general replay queue or health model call. Existing claim/original deadline applies. DOR3778 owns remaining-only budget preflight and sole tryReserve after placement/deadline guards immediately before actual runner; no duplicate reserve/refund or fallback retry multiplication.

## Security Considerations

Structured prior server_error plus current guards only. Never generic failed/lastError/text. Fresh id cannot bypass crash/account/auth/usage/pause policy. Same actual runtime/account/inference and carried marks survive. One current public seat and compare-and-rebind protect competing work. No raw errors in room copy. PR hold+review:deep; worker never arms, removes hold or sets reviewer labels.

## Documentation

Document precisely the known supported prior-server-error recovery and useful declines after tested. Changelog references both issues without promising every failure repairs itself. Save exact integrated SHAs and red/green evidence in04-implementation.md only when source work starts. Earlier05 probe proposal is superseded;06 is active revision record.

## Implementation Phases

1. Root approves revised artifacts/upstream4472 review; reproduce actual typed prior-server-error seam with intact transcript and child behavior.
2. Add strict terminal-evidence reader and truthful failure/refusal propagation/decline.
3. Strengthen/reuse mover with same account/runtime/inference, CAS, guard rechecks and one recovery for new hand-off.
4. Negative/race/identity tests, targeted checks, independent reviews, Code live QA matching reported failure shape before closure.

## Open Questions / Acceptance Limit

- ~~Native deletion can stand in for failed seat?~~ **(RESOLVED by independent audit)** No. It is a different defect and does not close3556. Four-runtime inspection API/OpenCode expansion removed from active scope.
- ~~Concrete candidate with intact transcript?~~ **(RESOLVED design direction, root)** Actual structured Claude server_error witness in latest complete failed room dispatch, intact transcript, known actual account and current guards, starting new work through common mover. Generic error_during_execution never grants.
- **Still open:** the actual incident failure shapes are unknown from ticket text. Generic historical failed state and unclassified pre-start failures are not covered by this candidate. Do not mark either issue fully complete from synthetic tests. Code live QA must match reported shape and demonstrate recovered post, or root keeps remaining acceptance open/records the precise follow-up.
- **Implementation validation:** producer-side wrapper provenance and strict tail completeness must be demonstrated through actual SDK/store test. If ambiguous, return unknown and keep acceptance open rather than widening classifier.

## Related ADRs

Existing session ownership (ADR-0255), tool-only room speech260829-025020, trusted defaults261006-225605 and current claim-held mover design. Reuse these patterns. Proposed ADR261115-223354 records the narrow durable destination-session launch constraint; no four-runtime reset architecture.

## References

Complete DOR-4328/DOR-3556 snapshot descriptions, coordination README/Security4472 design, root-approved recovery exclusions and06-independent-review-revision.md source matrix.05 retained only as superseded audit history.

## Required native identity revision (pre-package reviews)

The mandatory error contract is part of this slice now, not deferred to DOR-3816. Before any alias mutation, establish required source/destination responsibility through strict bidirectional requirement lookup in the same SQLite transaction. A direct requirement with a missing metadata marker and an early ownership read fault are refusals. Unknown ownership cannot fall through optional settings-loss behavior. Required metadata/native/reference and ancestry/scheduled aliases either commit together or remain unchanged; in-memory aliases publish only after commit. Matching agent/runtime/account-root is not evidence that an occupied destination is the same conversation.

The actual original live SDK object is captured before awaiting persistence. A mandatory refusal restores its previous id only while it is still that exact owned object, quarantines that operation/object against later launch or transcript lookup, preserves the exact RequiredSessionIdentityError, and leaves an independent target or successor object untouched. Canonical adoption marks success only after the ownership step succeeds; its first mandatory refusal remains sticky through final observation even if the runtime restores its previous id.

Every task outcome finalizes identity before one terminal row and terminal notification. Original projection interactions, lock/queue ownership and scheduler accounting are released unconditionally. A primary body error stays primary if identity finalization also refuses; a final-only mandatory refusal records failed under the original identity. Independent target resources are never released. Ordinary legacy optional behavior remains only after positively proving that neither side is constrained. Detailed transaction ownership, caller inventory and regression matrix are in 08-required-identity-revision.md; tests there are authored, not executed.

## Private Claude launch composition requirement

The concrete Claude runtime receives its authoritative required-launch reader from the exact `setSessionSettings` owner. The structural server-private capability binds that owner's getter, reads its current storage per dispatch, and never falls back to the global Registry. A genuine owner returning strict null proves an ordinary session; no/plain/capability-erased ownership is unknown and refuses provider-affecting launch or stage. This is a local composition requirement, not an expanded shared `SessionSettingsPort` or `AgentRuntime` contract. Read failures and corrupt/missing required records retain fail-closed semantics. App startup and replay must supply the real Registry. Uncomposed adapters do not retain their former launch behavior.

Warm-stage admission must re-read this same owner after warming immediately before the append. Compare only immutable runtime/root/inference/billing plus canonical/state/owned-pending identity with positively known facts from the actual retained Query. A newly resolved but unapplied plan, a previous process's SDK billing, and global ordinary storage cannot certify the retained process. Unknown evidence refuses without relaunch/failover.
