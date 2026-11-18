# Proposed narrow durable launch requirement — review requested, NOT implemented

2026-11-15. Supersedes only the earlier no-new-table assumption if independently approved. Recovery remains unwired. Do not move launch ahead of seat binding/claim ownership, or prewrite verified native facts.

## Existing storage investigated

- packages/db/src/schema/sessions.ts:17-65 stores runtime/agent/origin/settings, no launch account/inference requirement. shared/schemas.ts:906-925 SessionSettings has only mode/model/effort/fast.
- packages/db/src/schema/rooms.ts:1016-1029 room_sessions stores pair/session/createdAt only. No launch requirements.
- packages/db/src/schema/session/session-native-bindings.ts:3-10 and core/runtime-registry.ts:504-549 are VERIFIED actual native locations/account, written only after native proof. Ineligible for nonexistent fresh session.
- session-context.ts is token occupancy; session-locations.ts is owner/cwd navigation; session-started-by.ts records launch ancestry/permissions/report-back. None owns inference/account authority. session-limits is a refusal episode deleted on next start, not new-seat launch authority. turn-context records prompts/context and must not become executable launch configuration.
- rooms/reseat/seat-mover.ts:518-529 publishes binding before in-memory pending hint. Current create-seat-mover.accountOf calls session/fleet/session-account.ts billingAccountFor, whose root can fall back to today's launch ladder. That is not affirmative actual-account proof.
- Claude actual launched root is tracked at messaging/launch-resolver.ts:495-500, getSessionAccount:1781-1785. LaunchedPerToken is env/SDK-derived and not by itself credit-vs-own inference identity; credits-launch.ts:309-313 recognizes dedicated credits root. Settled native root can establish account only when it belongs to this exact failed session/turn; unknown attribution refuses.

## Revised minimal contract — root-approved direction, independent re-read pending

Independent architecture review `.dork/flow/4328-launch-design-review.md` justified a durable contract and required session-owned identity, continuing billing enforcement, atomic alias conflict handling and explicit attempt ownership. Root authorized amending02 and a narrow ADR, superseding the earlier no-new-table assumption because no existing storage can express required fresh-launch authority honestly. This design approval is not source authorization for persistence: no table, migration, runtime enforcement or recovery wiring is implemented.

### Immutable requirement and destination-session reference

Add one room-recovery-specific requirement table and one immutable server-only required-launch reference on **destination session_metadata**. A room-binding-only marker is rejected: unseating, moving again or directly addressing an old destination must not unlock defaults. Do not overload launchOrigin or user settings. The reference does not claim the destination has launched or bind its runtime before actual launch.

Requirement identity: schema version, requirement id, destination id, source canonical id plus complete prior-turn start/end bounds, room/author, literal Claude runtime, normalized actual account root and account identity where meaningful, explicit inference choice (credits or own-account), positively proven billing mode (subscription or per-token), createdAt. Identity fields are immutable; only pending/settled/refused state and state timestamps change. No credentials, draft, task, summary, callback or executable payload. Unknown/malformed source root, account attribution, inference or billing mode refuses; billingAccountFor preference fallback is never affirmative proof.

Require both marker→record and record→destination identity agreement. A marker with missing/corrupt record, a conflicting record/reference, unsupported schema or read failure refuses every launch. Ordinary settings upserts, idle eviction, retention cleanup, unseat and room deletion must preserve the session-owned restriction while the session remains addressable. Deliberate full session deletion must remove/tombstone identity consistently; no remaining alias can become an unrestricted ordinary launch.

### Atomic common-mover publication

Existing RoomSeatMover prepares settings and carries marks. After all awaits, recheck current live guards, source binding/runtime and evidence watermark. One synchronous SQLite transaction verifies expected source binding AND durable latest completed-turn watermark, ensures the source failure has not already been consumed, inserts immutable requirement, writes destination metadata reference and CAS-rebinds room_sessions. Check exactly one expected binding changed; any failure rolls back all publication. No clear/bind gap, early native binding or launch before room ownership. Existing normal mover policy remains explicit; recovery never calls beforeTurn, afterLimit, ranking or failover. Source-failure consumption is durable and cannot be repeated by another handoff or alias.

### Enforce final Claude launch configuration forever

Every launch surface resolves the destination session reference, including direct sends, resumes and room turns; unseated destinations remain constrained. The common Claude launch resolver obtains enforced root from requirement (not a preference hint or fabricated accountRoot/native binding), retaining normal project/account/sign-in/usage/permissions/crash/budget checks. Registered id alone is insufficient if its mapping moved: normalized actual root must agree. Credits use the real dedicated credits root and normal resolveCreditsLaunchEnv; disabled/unavailable credits refuse instead of switching to own sign-in.

Immediately before SDK effects, compare required runtime/root/inference/billing mode with FINAL resolved launch configuration/environment, after credential and folder settings resolution. Current credentials may be refused; the requirement never supplies stored secrets or bypasses credential policy. A subscription must not silently become an API-key bill, nor a per-token source silently become subscription or credits. Missing/unknown or mismatching facts refuse, with no provider/default fallback.

Native settlement may mark state settled only after exact destination/runtime/root/inference/billing agreement. **Settled never removes enforcement:** native bindings store account/location but do not own inference/billing constraints. The immutable requirement remains effective on every later launch; do not clear it on turn_start, success, failure, expiry or restart. Failed fresh attempt remains constrained/refused and gets no automatic fallback.

### Aliases and owned pending attempts

Canonical rekey atomically carries the session metadata reference and requirement destination identity alongside existing settings/native rows. Preserve immutable requirement id and source evidence; old-id resolution reaches the same restriction. A target already carrying a different requirement/runtime/account/inference/billing identity refuses the entire rekey; never onConflictDoNothing followed by source deletion. Alias resolution/consumption checks must prevent one source watermark acquiring two requirements under different ids. Settings or native proof may not overwrite a conflicting marker.

Pending launch is consumable only by an in-memory owned-attempt token bound to the current handoff claim and exact requirement/destination/source watermark. A matching timestamp is not ownership. On restart no token survives: pending is blocked/tombstoned and the old handoff is never replayed. Only a new explicit server action may revalidate all current guards and acquire a new owned attempt for the already constrained destination; it may not replay prior work, create another replacement, or consume the source watermark again. Settled continuations still enforce immutable billing restrictions and ordinary current guards. Manual repair can safely replace/unbind a seat without erasing restrictions on a still-addressable destination.

## Regression and integration requirements

- Real SQLite requirement+metadata+CAS atomicity and true-write failure rollback; old seat survives failed publication. Missing/corrupt marker/record, wrong schema and source watermark changes refuse.
- Unseat, second seat move, room deletion and direct old-destination send cannot unlock defaults. Settings upserts, aliases, idle eviction and restart preserve restriction. Atomic alias conflicts retain both original records without silent merges/deletion.
- Actual final Claude launch/configuration seam enforces runtime/root/inference/billing before SDK effect for initial and settled launches. Credit-disabled, changed registry mapping, own subscription→key and key→subscription changes refuse rather than billing another source. Unknown source provenance refuses.
- Pending owned attempt, lost process token, fresh failure, reauthorization and duplicate source/alias consumption negatives. Restart never resumes original handoff or deletes requirement by age. No successful launch before room claim/binding exists.
- Real intact-transcript prior-server_error chain, current vetoes, common mover one new-work attempt, no prior-task replay; generic/prestart acceptance stays open for Code incident QA.
- DOR3778 owns original enqueuedAt/waitDeadlineAt, FIFO25/1000, independent queued expiry, onClaimed=preparing/onStarted=running, deadline checks before/after placement/before runner. Early budget check is remaining-only; sole tryReserve occurs after placement/deadline checks immediately before actual runner. Recovery preserves original deadline and one actual charge; typed failure/refusal projection remains this slice's owner. Capacity/deadline/protected codes stay distinguishable.

Migration slot derives from actual integrated ancestry; none reserved. See proposed ADR261115-223354 and amended02. Stop for independent re-read before authoring persistence/enforcement/recovery source.
