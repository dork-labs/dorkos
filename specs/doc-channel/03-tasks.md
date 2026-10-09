# Doc Channel implementation tasks

Generated: 2026-10-01T20:11:19.260645Z

Canonical task records: `03-tasks.json`. Mode: full. Tasks 1.1, 1.2, 2.2 and 2.3 are completed after verified merges and acceptance audits; nine tasks are in progress and nine remain pending. Full v1/v1.1/v2 delivery is included. Parent owns tracking, promotion, integration and aggregate release readiness; each implementation runs in an isolated checkout.

The natural xl boundaries are 2.6 (room admission) and 4.3 (checkbox write coordination). They are promoted through the tracker adapter as DOR-2669 and DOR-2670, with parent DOR-2665; they stay unready until their canonical prerequisites pass.

Foundation contracts/storage land first. Actual Relay routing awaits DOR-2660; frame rollout awaits DOR-2662 and DOR-2663. These gates do not block local-session admission, native widgets or log-only service development. DOR-2661, DOR-2664 and general DOR-2666 remain independent work.

Shared app/composition mounts, export barrels, migrations and Transport integration are serialized by the parent at merge boundaries. Runtime admission/context belongs to 2.4; lifecycle/rekey to 1.2; room admission to 2.6; stream plumbing to 3.1; frame lifecycle to 3.2; ordinary-save coordination to 4.3.

## Phase 1: Foundation

### Task 1.1: [doc-channel] [P1] Define channel contracts and durable storage

- Status: completed
- Size: large
- Priority: high
- Dependencies: none
- Parallel with: none declared
- Issue: none; parent issue: none

Create strict leaf schemas and a transaction-capable store under apps/server/src/services/canvas/doc-channel/, keeping the existing canvasDocuments table in packages/db/src/schema/rooms.ts. PageEvent contains v:1, stable UUID id, type, JSON payload, optional coalesceKey and advisory ts. Type/coalesceKey are at most 128 characters; type is dot-separated ASCII without wildcards. Reject unknown fields, nonfinite numbers, depth over 32 and prototype-sensitive keys. Full UTF-8 envelope limit is 16 KiB. Define document ingest receipt, canvas_event frame with separate docSeq, declarations/routes/grants, per-route statuses, structured doc_events context, app.ack, state patches, presence and restricted token contracts.
Persist channel state/revision/declaration/hash/opener/closure; events with eventId/docSeq/direction/type/payload/hash/coalesce/time/provenance; exact hashed grants and approval evidence; durable batches with ordered input IDs/effective payload/dueAt/lease/attempt/correlation/admission receipt; per-input deliveries and acknowledgement evidence. Unique document-event IDs and document sequences, and partial uniqueness for one pending batch beside one active batch. Persist retention floor, private closure evidence and recoverable identity/write intents. Keep existing shared admission source kinds unchanged in this foundation PR; document batches carry a nullable admission receipt reference until task 2.4 adds the closed document source union, DB enum and adapter registration together. No new transcript store, external service, SDK dependency or second canvas table.

Acceptance and verification:
Use real temporary SQLite to verify normal migration, constraints/indexes, transaction rollback and monotonic per-document sequences. Exercise malformed envelopes, Unicode byte sizing, depth/prototype rejection, legal/illegal event patterns, source identity uniqueness and restart readback. Verify leaf imports avoid canvas/session/room cycles and subpaths resolve.

Integration boundaries:
Own packages/shared/src/canvas-channel-schemas.ts and its subpath/export, common canvas/open options, DB canvas-channel schema/barrel/migration. Seed typed contracts for document context, emit/bind, tokens and checkbox intents without enabling unfinished transports. Coordinate later shared enum/context additions with parent.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 1.2: [doc-channel] [P1] Enforce document authority and recoverable lifecycle

- Status: completed
- Size: large
- Priority: high
- Dependencies: 1.1
- Parallel with: none declared
- Issue: none; parent issue: none

Resolve a document ID to its stored scope privately, then authorize server-resolved session ownership or local room membership before exposing data. Absent and inaccessible documents both return 404; archived rooms refuse writes. Agent capability access uses verified runtime identity and owning scope; HTTP session behavior preserves the existing people-only boundary. Resolve canonical aliases on every read and dispatch. Host provenance contains server-derived document/scope/opener/actor/transport/generation/time/sequence, never page-selected identity.
Extend physical close/eviction to atomically close the channel, revoke grants/tokens, cancel unadmitted batches and retain a private tombstone before document deletion. Publish after commit; listener failures cannot restore authority. Running work is not blindly aborted, but later sends fail closed.
Move document/channel/batch ownership, accepted-unclaimed shared receipts and safe queue placeholders together in one SQLite transaction when canonical identity changes. Preserve document IDs/docSeq/sourceId/sourceGeneration/receipt IDs, rebind canonical session and validated origin digest without widening agent/runtime authority. Claimed/started receipts retain observed identity and become quarantined when safe movement cannot be proven; never recreate their generation. Collision preserves both documents and exposes health; incomplete moves block admission. Startup repairs identity moves before pumps resume.

Acceptance and verification:
Cross real auth/lifecycle seams with login on/off, wrong session, lost room membership, archive, close, eviction and post-commit listener failures. Using real SQLite and existing protected-source fixtures, verify the atomic document/channel/batch plus accepted-unclaimed receipt/queue-placeholder move preserves all IDs, generations, authority and canonical session bindings. Task 2.5 carries the actual document-source busy-first-turn delivery/restart proof after task 2.4 installs its source adapter. Inject source-key collision and write failure; both records survive and no wrong-session dispatch occurs. Test claimed-receipt uncertainty and tombstone privacy.

Integration boundaries:
Own canvas authorization/store/service lifecycle and canonical rekey integration, including shared acceptance-receipt and queue-placeholder movement. Parent serializes projector/queue/composition edits.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

## Phase 2: Routing and delivery

### Task 2.1: [doc-channel] [P2] Authorize declarations and exact route grants

- Status: completed
- Size: large
- Priority: high
- Dependencies: 1.2
- Parallel with: 2.2
- Issue: none; parent issue: none

Add channel declaration to common open/document options for all content types. At most 16 stable-ID routes support exact types or a single terminal segment wildcard and destinations log, agent:owner, verified agent ID, room:self. Owner is recorded opener, never latest writer/viewer; human opener without a bound agent selects one through authenticated grant operation. No cross-room destination.
Read .dork/app.json only from a confined local source root. Validate at most 64 KiB, 128 types, depth 16 and 1,024 schema nodes with bounded Draft-07 type/properties/required/additionalProperties/items/enum/const/scalar-array limits. Reject refs, patterns and combinators; no fetch or format loading. Cache compilation by canonical validated hash; manifest may narrow limits/schema but cannot raise caps or grant routes.
Verified opener may enable bounded self/log routes. Other agents, room:self and checkbox writes require existing operator approval binding exact document/route/target/hash/types/limits/expiry. Persist only matching verdict grants. Hash changes suspend before dispatch; revocation prevents new claims. No declaration means log only; undeclared types save health warning; invalid declared payload is 422. Later approval never silently routes old events; explicit replay preserves IDs.

Acceptance and verification:
Test terminal wildcard segment boundaries, opener stability, manifest escapes/size/work bounds, forbidden schema features and narrowed caps. Exercise real approval acceptance/denial, mismatched verdict, expiry, declaration/manifest change and revocation during preparation. Prove no route from silence or permission mode and no old-event replay on later approval.

Integration boundaries:
Own doc-channel grants/manifest authorization and ui.configure_doc_channel, ui.approve_doc_route, ui.revoke_doc_route capability implementations; parent integrates shared UI tool contract/composition registrations.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 2.2: [doc-channel] [P2] Persist accepted input and deterministic batches

- Status: completed
- Size: large
- Priority: high
- Dependencies: 1.2
- Parallel with: 2.1
- Issue: none; parent issue: none

In one transaction insert accepted input, advance docSeq and create/merge pending route deliveries; publish only after commit. Access checks precede duplicate lookup; identical ID/hash returns original receipt before charging rate or backlog. Changed payload under an ID conflicts. Apply 60 new upstream events/rolling minute/doc and min(app,platform) limits. Uncompleted caps are 1,000 events or 16 MiB/doc and 256 MiB/install; refuse before acceptance with BACKLOG_FULL, never discard accepted input. Storage failure is 507. Validate each individual routed event fits the 80 KiB rendered prompt ceiling including escaping/fences/preamble before acceptance; 16 KiB wire bounds remain distinct.
First receivedAt opens a fixed coalescing deadline; later events do not postpone it. Exact declared coalescible types permit last-write-wins keys; comments preserve ordered IDs. Generic toggle/undo never cancel without verified unchanged baseline. Keep superseded/cancelled receipts. Pending batches stay mergeable until immutable admission; one new pending batch may follow active work. Slice at 100 inputs and 80 KiB rendered bytes, retaining overflow for later work.
Persist system status events and paginated replay with state/revision/high watermark/health/retention floor. Retain completed rows up to 30 days, 64 MiB/doc, 1 GiB/install; prune oldest completed inputs only when no pending/in-doubt reference remains. Reset exposes current state and receipt summary without claiming recovery of pruned app events.

Acceptance and verification:
Use injected clocks and SQLite: duplicate while throttled, conflict, concurrent ingests, rollback, exact caps, fixed deadline, comment ordering, 101-input slicing, near-16-KiB escaped payload and rejected over-rendered event. Assert no accepted event becomes permanently undeliverable. Prove retention preserves pending/in-doubt inputs and reports explicit reset/floor.

Integration boundaries:
Own channel ingest/coalescer/retention/replay store logic; use foundation grant interfaces without editing capability registration.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 2.3: [doc-channel] [P2] Expose host HTTP and Transport operations

- Status: completed
- Size: large
- Priority: high
- Dependencies: 2.1, 2.2
- Parallel with: none declared
- Issue: none; parent issue: none

Implement thin authenticated routes delegating to DocChannelService: POST /api/canvas/docs/:id/events; GET /api/canvas/docs/:id/channel?since=&limit=; GET /api/canvas/docs/:id/events/:eventId. JSON replay is default, limit 1..200. Return 201 recorded, 200 duplicate, 400 malformed, 409 ID conflict, 413 oversize, 422 declared-schema mismatch, 429 with Retry-After, and 507 storage failure. Busy destination does not return 409. Preserve session/host/origin guards and 404 inaccessible document behavior.
Add Transport methods, HttpTransport implementation and test mocks. Privileged editor/host events use separate internal methods; directly authenticated API input remains untrusted and cannot select editor authority, routes, sender, destination, cwd, permissions, forAgent or reply context. Pages never fetch this API directly. Expose recorded acceptance separately from route completion/application ack.

Acceptance and verification:
Run full-app HTTP tests with real body parser and scope authorization under login on/off. Test cross-session/room denial, reserved type/forged host-field refusal, all status codes, paging/invalid limits, duplicate under rate pressure and storage rollback. Use client mock Transport tests rather than raw fetch; confirm accepted busy input remains inspectable.

Integration boundaries:
Own routes/canvas-doc-events.ts and Transport/HttpTransport/mock implementations; parent integrates app mount and schema-export amendments.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 2.4: [doc-channel] [P2] Reuse canonical admission and render document context

- Status: in_progress
- Size: large
- Priority: high
- Dependencies: 2.1, 2.2
- Parallel with: none declared
- Issue: none; parent issue: none

Extend PrivateSessionMessageSourceRef with immutable document_event_batch batchId/generation and register a fixed source adapter. Resolve canonical session/runtime/opener and consume batch in the same SQLite transaction as existing safe placeholder/shared receipt; persist receipt ID on batch. Do not create another admission ledger. Move coordinator installation outside Connections-only startup while retaining existing source authority checks and boot recovery.
Prepare structured doc_events in memory; revalidate current grant/hash/access/source generation/origin at final synchronous claim CAS immediately before runtime effect. Pass through dispatcher/trigger/common assembler to Claude Code, Codex, OpenCode and test-mode; no seedContext disguise or raw payload in visible queue text. Render document label and bounded records using fresh mintFenceNonce/fenceUntrustedBlock, defuse every untrusted delimiter and keep server instruction outside: app page data is not operator instructions. Server creates summaries from validated types or neutral type labels. Entire rendered input respects 80 KiB with single-event acceptance guarantee. Provenance is app/untrusted; grants approve routing, not arbitrary external writes.
Local owning-session delivery uses existing private admission queue pump with server-stamped relay.doc.<documentId> provenance; no public Relay publish or second turn. Resolve session-bound runtime, never hardcode Claude. Preserve source/receipt identity through canonical movement.

Acceptance and verification:
Extend shared runtime conformance and private admission tests for all runtimes. Exactly one claim under competing dispatchers; revoked grant after preparation prevents effect; current origin/canonical ID enforced. Busy first-turn rename/restart preserves receipt and produces one later dispatch. Delimiter attacks and escaping remain fenced/within ceiling; placeholder and logs omit raw payload. Existing protected source behavior stays green.

Integration boundaries:
Own private acceptance/source adapter, dispatcher/trigger/assembler, AdditionalContext document entry and every runtime renderer; parent integrates composition-root move and shared tool exports.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 2.5: [doc-channel] [P2] Schedule durable waits and truthful terminal receipts

- Status: in_progress
- Size: large
- Priority: high
- Dependencies: 2.4
- Parallel with: none declared
- Issue: none; parent issue: none

Pump oldest eligible dueAt fairly across documents/targets with durable leases and one active/pending invariant. Wait outside runtime slots; immutable accepted batches do not coalesce further. Enforce rolling 10 started turns/hour/route, rendered 80 KiB and 100-input slices, platform budgets and room ceilings. Expose nextEligibleAt; do not spin. Immediate means due now, not bypassing gates; none records routed without a turn. Soft wait warning after 15 minutes; expire unadmitted work after 24 hours with explicit replay.
Persist per-route saved/pending/waiting(reason)/routed/turn_started/turn_done/failed/expired/cancelled/in_doubt status events. Correlate batch/message/receipt/projected turn identity; projected turn_start means DorkOS dispatch started, not durable backend admission. Only correlated successful settlement proves turn_done. Relay publish acceptance proves neither. Failed started work is never automatically repeated. Previous-boot claimed/started shared outcome_unknown maps to in_doubt; resume only accepted-unclaimed receipts after fresh authority checks. No reliable shared runtime handle exists: absent history cannot prove safe retry. Expose manual review/replay rather than repeating uncertain external effects. Observe rejection/wait/revoke/in-doubt/replay metrics without raw payloads.

Acceptance and verification:
Inject clock/capacity/callbacks; two pumps yield one admission, overflow yields deterministic next slices and route ceiling waits without slots. Restart before claim resumes once; restart after claim/start is in_doubt and never auto-repeats. Unrelated settlement cannot complete another batch. Assert exact warning/expiry/budget outcomes and correlated failed completion.

Integration boundaries:
Own doc-channel delivery pump/status/recovery and source callbacks; consume the shared acceptance implementation instead of changing runtime admission semantics.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

Canonical identity integration proof:
Accept a document batch while its owning first turn is busy, rekey to the runtime canonical session, restart the server and release capacity. Exactly one later admission occurs in that canonical session using the original shared receipt/source ID/generation; no stale-session queue or recreated receipt remains. This crosses the production document source adapter, shared acceptance coordinator and dispatcher pump installed by task 2.4.

### Task 2.6: [doc-channel] [P2] Admit room app events without operator authority

- Status: pending
- Size: xl
- Priority: high
- Dependencies: 2.1, 2.2, 2.5
- Parallel with: none declared
- Issue: DOR-2669; parent issue: DOR-2665

Implement local room:self as a typed app-event room entry attributed to a server-owned system author with document/grant/batch provenance. doc:<id> is a label, never a new arbitrary authors.kind. Resolve explicit granted target, recheck membership/archive and current grant at admission, and record the admitted responding agent. Page-provided mentions cannot wake anyone; no fanout, human-looking text entry or operator HTTP fallback.
Use room trigger, cascade, reply/turn-budget and busy collector gates. Persist an immutable durable batch claim CAS before launch and stable correlations so concurrent pumps/restart cannot launch twice. Non-human document admission cannot inherit operator trigger privileges. Completion/failure/cancellation maps to document receipts; unknown post-claim effect quarantines in_doubt. A Relay correlation hands off exactly once to this room path, never a second direct session turn. Keep route unavailable until this safety path passes its tests; do not substitute weaker behavior. Ordinary canvas changes, downstream events, state patches and count updates never trigger turns.

Acceptance and verification:
Cross real room entry→trigger→runner seam with fake runtime and SQLite. Test correct target only despite hostile mentions, lost membership, archived room, cascade/reply/turn ceilings, competing batch claims, busy wait and restart at admission boundaries. Assert exact one launch, recorded responder and terminal correlation; wrong author/operator fallback unavailable. Verify content updates stay quiet.

Integration boundaries:
Own room app-event schema usage/service/trigger/cascade/runner integration; parent serializes shared room-schema and composition edits.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 2.7: [doc-channel] [P2] Carry trusted document context through actual Relay

- Status: pending
- Size: large
- Priority: high
- Dependencies: 2.5, 2.6
- Parallel with: none declared
- Issue: none; parent issue: none
- External blocker DOR-2660: Actual Relay-backed document routing must remain disabled until namespace reservation for server-owned doc subjects is merged and verified.

Actual Relay-backed routes require DOR-2660 namespace reservation to include server-owned relay.doc subjects before enabling delivery. Map verified opener/current grant to explicit Relay ACL policy; never assume existing agent ACL recognizes doc principals. Internal document context binds canonical targetSessionId, grant/scope/batch/source receipt. Wire payload cannot bind target session or turn-shaping authority; do not widen isTurnShapingSender.
Fresh budgeted Relay envelope is minted only at eligible admission; durable document wait holds neither slot nor expired envelope. Add explicit document capacity policy and terminal callbacks, not spoofed bridged-human onHeld. Normal relay.agent conversation mapping cannot replace owning canvas session. Room correlation enters room admission once, not direct dispatch twice. Relay disabled produces relay_disabled waiting until reenabled or expiry; log/local owning-session routes remain available. General relay HTTP trust/signature/receipt defects retain independent tickets and receipts.

Acceptance and verification:
Use fake capacity/terminal callbacks and real Relay routing policies to prove namespace reservation, opener/grant ACL denial, hostile target/permission payload ignored, fresh TTL after long wait, terminal status mapping and one room handoff. Test disabled Relay does not disable local/log routes. Prove publish acceptance never reports turn completion.

Integration boundaries:
Own packages/relay typed internal context/ACL/capacity/terminal callbacks and document transport implementation. Parent integrates server Relay composition. Do not implement general public HTTP sender/receipt fixes.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 2.8: [doc-channel] [P2] Persist downstream state and correlated acknowledgements

- Status: completed
- Size: large
- Priority: high
- Dependencies: 2.1, 2.2, 2.4
- Parallel with: none declared
- Issue: none; parent issue: none

Register canvas_send in UI act capabilities/shared contracts/generated external and in-session surfaces for every runtime. Require documentId/eventId/type/payload and optional target room; recheck current scope/target access even when caller opened the document. Persist downstream receipt with 16 KiB envelope and sender rate limit; it proves persistence, not viewer render, and cannot trigger a turn.
canvas_patch_state accepts eventId/expectedStateRev/optional target room and set/remove JSON-pointer ops, max 100 operations, 16 KiB patch and 256 KiB final state. Decode/validate pointers; no prototype segments/expressions. Atomic patch increments stateRev and appends state event. Duplicate ID/hash returns original result before already-advanced revision check; changed hash conflicts, wrong revision is 409, invalid/oversize leaves state unchanged. Preserve content and edit lock.
Target agent app.ack payload is batchId/routeId/nonempty unique bounded eventIds/outcome handled|rejected. Verify every input belongs to exact document/route/batch and caller is recorded target/responder. Reject invalid correlation atomically; partial ack settles only named IDs. Rejected ack never retries turn. Persist per-input evidence in replay/reset; turn_done without app.ack remains unfulfilled. Same downstream ID/hash idempotently returns original; pages cannot emit upstream app.ack.

Acceptance and verification:
Real store and capability tests: wrong scope/target/responder, mixed valid/invalid ack atomic refusal, partial ack and duplicate/conflict; exact state boundary and rollback, pointer escaping/prototype attacks, advanced-revision duplicate and editing preservation. Tool contracts present in all runtimes, no downstream/patch/ack wakes any turn.

Integration boundaries:
Own doc-channel state/downstream/ack service and runtime-independent canvas_send/canvas_patch_state capability bodies. Parent integrates generated tool contracts and ui.patch_canvas_state registration.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

## Phase 3: v1 clients and proof

### Task 3.1: [doc-channel] [P3] Deliver channel replay over shared scope streams

- Status: completed
- Size: large
- Priority: high
- Dependencies: 2.3, 2.8
- Parallel with: none declared
- Issue: none; parent issue: none

Add canvas_event as an explicit typed wire notification alongside durable session events, and to room schemas/common delivery. Do not fabricate SessionEvent.seq values or copy document history into transcript storage; dispatch channel frames before transcript cursor logic, with docSeq independent of stream sequence, room entry cursor and content revision. Notifications are not durable history; cold/idle session channels replay from document store without existing projector. Attach live buffer before capturing highWatermark, replay through it, then drain later buffered events. Reduce duplicates by docSeq; gaps fetch document replay. Room frames never advance room entry cursor. Expose resetRequired/current state/receipt summary/retention floor when history pruned and do not synthesize unavailable app events.
Apply existing subscriber backpressure and authorized scope filtering; document state/replies/status travel over SSE and WebSocket equivalently. Client use-doc-channel uses Transport/public barrels; keep identity data out of page projections. Preserve stable content/edit state when notifications arrive.

Acceptance and verification:
Integration tests for SSE/WebSocket identical outcomes, replay/live race, duplicate/gap healing, room cursor independence, cold projector absence, slow subscriber reconnect and retained-history reset. Restart returns current state/receipts. Wrong scope receives no events or viewer IDs; live callbacks are post-commit.

Integration boundaries:
Own session/room stream discriminants/projectors/shared SSE+WebSocket delivery and client shared stream reducer; parent serializes schema barrels and Transport updates.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 3.2: [doc-channel] [P3] Connect instrumented frames with a mount-bound SDK

- Status: completed
- Size: large
- Priority: high
- Dependencies: 2.3, 3.1
- Parallel with: none declared
- Issue: none; parent issue: none
- External blocker DOR-2662: Frame rollout requires verified shared generation lifecycle and handshake integration.
- External blocker DOR-2663: Frame rollout requires verified containment of all served document responses, including top-level opening.

Expose window.dorkos.channel.emit(type,payload,{id?,coalesceKey?}), on(type,fn) unsubscribe, read-only state/status. Emit resolves durable acceptance only. Queue at most 100 events/1 MiB in memory; jitter-retry network/429 with stable IDs, reject overflow/terminal access-schema errors. State connecting/ready/offline/revoked; no promise of surviving page closure before acceptance.
Extend serve/preview injection only after DOR-2662 mount lifecycle and DOR-2663 served-document containment merge/verification. Host resolves exact instrumented window/source/origin and establishes generation-bound dedicated MessagePort. Opaque origin must equal null; preview must equal minted origin. Bootstrap requires shim-installed gating; raw remote/fallback hello cannot activate channel. Rotate navigation/replacement/reload, close old ports/cancel pending responses and correlate generation/request IDs. CSP-blocked injection and direct-preview fallback are offline. Share lifecycle owner with devtools, never protocol key/port. Same-page scripts remain untrusted; no nonce/port authorship claim and no API tokens/grants in HTML.

Acceptance and verification:
Browser tests: two frames cannot cross-talk; stale generation/old responses refused; navigation/reload cleans listeners; same-page messages remain untrusted; uninstrumented/CSP-blocked fallback offline. Verify opaque serve top-level cannot read/write API data and normal instrumented frame still functions. Queue stable retry/overflow/revocation tests and real UI offline status.

Integration boundaries:
Own frame SDK/injection, CanvasBrowserContent host lifecycle and shared bridge generation/MessagePort implementation. Coordinate DOR-2662 owner: one lifecycle, distinct doc/devtools keys and ports.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 3.3: [doc-channel] [P3] Emit native widget actions with durable status

- Status: completed
- Size: large
- Priority: high
- Dependencies: 2.3, 2.8, 3.1
- Parallel with: none declared
- Issue: none; parent issue: none

Add kind:emit native canvas widget actions with no static-node script execution. Host stamps verified widget/node identity and calls common ingest through Transport. Each click gets stable event ID and visible acceptance/wait/failure/expiry/in_doubt status; only that click's unaccepted submission disables. Keep independent new clicks available while accepted work waits. Preserve required native form schemas/validation.
Legacy inline chat kind:agent keeps busy refusal and instance settled latch. Channel-enabled canvas agent actions normalize to declared widget-action events only with approved route and visible durable status. Do not silently queue old inline actions. Downstream state updates preserve typed inputs/focus/draft/scroll and do not replace content or open content-edit banner. Provide accessible keyboard/status announcements across desktop/tablet/mobile and label destination.

Acceptance and verification:
Mock Transport tests plus real browser suite: separate clicks/IDs, network retry, all durable states, approved versus unapproved normalization, required-field errors and legacy inline busy/latch behavior. State/replies do not reset form values/focus/caret/scroll. Inspect designed states in light/dark at phone/tablet/desktop; stable test IDs for copy-independent locators.

Integration boundaries:
Own gen-ui widget context/actions/native status rendering and canvas host callback integration through public barrels. Parent integrates shared ui-widget contracts.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 3.4: [doc-channel] [P3] Prove the writer-to-channel consumer handoff

- Status: pending
- Size: large
- Priority: high
- Dependencies: 2.5, 2.6, 2.8, 3.2, 3.3
- Parallel with: none declared
- Issue: none; parent issue: none

Create sanitized temporary-vault dashboard fixture retaining writer/build/note/comment functions. Writer accepts stable operationId and canonical-request hash, persists distinct writer receipt after exactly one mutation and durable pending channel handoff before successful-save response. Same ID/different payload conflicts; different IDs with identical text remain separate comments. UI separates File saved from Notification saved/waiting and cannot mark unpersisted comment Saved. SDK resolves channel receipt only.
Migrated mode disables old notifier and AckWatcher resends for migrated operations; JSONL acknowledgements are audit mirror, not dispatch owner. Operation ID spans writer receipt/channel input/app ack. note.open stays confined writer operation; notify.flush handles only pre-admission handoff, never admitted/in_doubt retry. Preserve five-minute Undo, closed-thread unseen indicators and sessionStorage draft restoration.
Prove busy comment→restart→one canonical owning-session turn→correlated app reply while existing markdown remains truth. Toggle/undo zero turns only with verified unchanged baseline and both receipts. Replies/replay cannot duplicate toasts, replace iframe or reset focused textarea/draft/caret/scroll/selection.

Acceptance and verification:
Drive real browser and server-store seams with fake callbacks: lost writer response/retry gives one mutation/event; write-before-ingest reload recovers handoff; busy first-turn rename/restart keeps same receipt and one later turn; completion without ack stays unfulfilled; partial ack affects only IDs. Retained note.open/Undo/draft/unseen-indicator scenarios pass, and no old notifier sends a duplicate.

Integration boundaries:
Own sanitized LifeOS-style temporary fixture, fake writer/build/runtime endpoints and v1 end-to-end acceptance scenarios; never edit personal vault or production consumer.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

## Phase 4: v1.1 hosts and editing

### Task 4.1: [doc-channel] [P4] Advertise document events to MCP apps

- Status: completed
- Size: large
- Priority: medium
- Dependencies: 3.1, 3.2
- Parallel with: none declared
- Issue: none; parent issue: none

Advertise namespaced DorkOS extension with dorkos/app.emit and downstream dorkos/app.event, not standard ui methods. Tie extension permission to hosting document/generation, retain source/origin checks and normalize common ingestion. Keep tools/call refused. Extension calls cannot select routing/editor authority or leak other scope data. Downstream events/state/receipts use shared replay reducer and stable IDs; clean up permissions/listeners on replacement/navigation.

Acceptance and verification:
Protocol and browser tests verify advertised extension, missing permission/wrong document/source/stale generation refusal and tools/call still denied. Emit/ack/reply/replay preserve draft/focus/selection and do not launch duplicate turns. Test listener cleanup and doc replacement.

Integration boundaries:
Own mcp-apps model/bridge extension and public host callbacks; no internal cross-feature canvas imports.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 4.2: [doc-channel] [P4] Emit verified editor lifecycle and selection events

- Status: in_progress
- Size: large
- Priority: medium
- Dependencies: 2.3, 3.1
- Parallel with: none declared
- Issue: none; parent issue: none

Add host-only doc.saved, selection.ask and md.task.toggled methods. Resolve current loaded source line/text hash, not rendered DOM. Read-only documents expose no toggle. File saves emit doc.saved only after actual successful persistence, never onChange, failed autosave or no-op. Native task click prepares authenticated checkbox operation input for separate granted writer; page ingestion cannot forge editor authority. Selection/file text stays untrusted context. Media/CSV/JSON emit only genuinely supported lifecycle/selection events, without fabricated editing support. Existing edit rights and conflict display remain intact.

Acceptance and verification:
Drive save success/failure/no-op/autosave paths and source-line mapping for markdown, selection and task control availability. Reject page attempts to impersonate host events. Read-only task controls absent; unsupported media edit event never emitted; state replies preserve source editing/focus/selection.

Integration boundaries:
Own markdown viewer host task/selection/save callbacks and supported media/CSV/JSON host lifecycle adapters. Use public host contracts, not DOM-derived authority.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 4.3: [doc-channel] [P4] Coordinate granted checkbox writes and crash recovery

- Status: pending
- Size: xl
- Priority: medium
- Dependencies: 2.1, 4.2
- Parallel with: none declared
- Issue: DOR-2670; parent issue: DOR-2665

Checkbox-toggle is a server operation requiring editing rights and explicit write grant, not generic page interpretation. Grant binds document source/resolvedCwd/treeKind/canonical path/operation. Host input includes stable event ID, 1-based line/textHash/expected version/desired boolean. Re-resolve realpath inside recorded tree and refuse symlink escape, source/tree change, absent/read-only file or conflicting editor lock. Verify exact task marker/hash/version; modify only marker preserving BOM/line endings/final newline.
Use existing optimistic concurrency/atomic replacement plus one canonical-path coordinator shared with normal saves; revalidate version inside lock and immediately before replace. External editors do not share lock, so refuse observed conflict and document residual race. Persist durable intent and before/after hashes before replacement. Same event ID never writes twice. Only verified evidence permits atomic success-event+routable-outbox commit. Crash after replacement reconciles hashes; unfamiliar file state is in_doubt without delivery/retoggle. Conflict returns typed receipt/reload; verified no-op emits no false changed turn. Comment/arbitrary markdown writes remain outside grant.

Acceptance and verification:
Real temp-file/SQLite tests cover all path/tree/symlink/access/editor/version/marker conflicts, BOM/CRLF/final-newline preservation, exact single marker change, duplicate/conflicting IDs and concurrent normal save. Inject crashes before/after replace/before completion: verified after-state releases one event, before-state safe policy retains intent, unfamiliar state quarantines and never blindly toggles. Conflicts/no-op yield zero changed turns.

Integration boundaries:
Own checkbox operation/intent/recovery and shared canonical-path coordinator integrated with ordinary server file saves; parent serializes file-write route/service updates.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 4.4: [doc-channel] [P4] Track mounted views and quiet host presence

- Status: completed
- Size: medium
- Priority: medium
- Dependencies: 2.3, 3.1, 3.2
- Parallel with: none declared
- Issue: none; parent issue: none

Implement POST /api/canvas/docs/:id/presence and authenticated per-document per-mount random viewer IDs bound to caller. Heartbeat every 30 seconds with 75-second TTL; count mounts as views, not people/stream subscribers. Publish doc.viewers only count changes; heartbeat is ephemeral, never durable event-log noise. Restart starts zero until fresh beats. Host opened/closed log mount transitions; crashed mounts expire once. Do not leak private viewer identities downstream. Count changes never wake agents. Focus defaults log-only, debounced, and can wake solely through separately granted explicit route.

Acceptance and verification:
Clock tests for duplicate beats, multiple tabs by same caller, stale/wrong document IDs, exact TTL and once-only crash expiry/restart zero. Browser mounting/unmounting reconnect does not double count. Count changes produce zero turns and no heartbeat log rows; focus-flip burst bounded.

Integration boundaries:
Own doc-channel presence store/timer and frame/native host mount hooks. Parent integrates presence Transport endpoint and lifecycle registrations.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 4.5: [doc-channel] [P4] Verify MCP and native write consumer scenarios

- Status: pending
- Size: medium
- Priority: medium
- Dependencies: 4.1, 4.3, 4.4
- Parallel with: none declared
- Issue: none; parent issue: none

Repeat writer/channel/ack preservation contract for native checkbox and MCP extension hosts with real persistence and fake runtimes. Validate writes are independently acknowledged from agent turn completion, busy/restart retains receipt identity, crash reconciliation does not duplicate mutation or dispatch, and partial app ack affects exactly selected inputs. Exercise editor conflicts/reload actions, read-only behavior and presence view semantics. Keep tools/call refusal and quiet downstream/presence behavior observable.

Acceptance and verification:
Browser and HTTP/store end-to-end sequence: grant→native toggle→busy wait→restart→one write/turn→app ack/reply; crash after file replace; MCP emit/return event; revoked/mismatched doc permission. Preserve draft/caret/focus/scroll/selection/Undo/unseen indicators. Exact counts required, no merely nonzero assertion.

Integration boundaries:
Own v1.1 extension of sanitized consumer/browser fixtures; preserve task 3.4 proof rather than duplicate unit implementation tests.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

## Phase 5: v2 standalone and controls

### Task 5.1: [doc-channel] [P5] Restrict standalone bearer ingestion and SSE

- Status: completed
- Size: large
- Priority: medium
- Dependencies: 2.1, 2.3, 3.1
- Parallel with: none declared
- Issue: none; parent issue: none

Mint dct_ tokens only through explicit document token capability/UI; persist hash/document/types/direction/expiry/creator/revocation. Token issue cannot create route grants; relevant manifest/grant invalidation revokes authority. Limit bearer auth to channel-specific ingest/replay/SSE; no wholesale canvas session-gate exemption. Authenticate before body parsing. Mixed cookie/operator and bearer authority is refusal, never cookie fallback. Preserve host/DNS-rebinding guards.
Use ACAO:* solely authorized bearer surface without credentials; preflight permits necessary Authorization/Content-Type headers. Use fetch-based SSE Authorization header, never EventSource query token. Check expiry/revocation continuously on active streams and close them. Token cannot reach URL/log/content/scope snapshot. Standalone receives document-only data without other scope events/private viewer identities. Replay is bounded by docSeq/retention resets, and stable input retry returns original acceptance.

Acceptance and verification:
Real full-app requests: wrong-doc/type/direction, expired/revoked token, mixed cookies, malformed/oversize unauthenticated body and query-token refusal. CORS/preflight/host behavior tested at actual mounted path. Fetch-SSE closes upon expiry/revoke and never emits unrelated document data. Inspect logs/content for token exposure; duplicate accepted ID survives reconnect.

Integration boundaries:
Own token capability/store/auth, narrow channel bearer routes and fetch-SSE implementation; parent integrates app parser/auth/CORS mount ordering.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

### Task 5.2: [doc-channel] [P5] Expose route controls and safe state-bound widgets

- Status: pending
- Size: large
- Priority: medium
- Dependencies: 3.3, 5.1
- Parallel with: none declared
- Issue: none; parent issue: none

Provide convenience header controls for declarations, exact approval, revoke, explicit replay/review and document token mint/revoke using existing authenticated capabilities. Show app/event types/destination/expiry and no route from silence. Distinguish saved/waiting/failed/expired/in_doubt/handled state; replay admitted/uncertain work requires explicit review policy rather than automatic repeat. Tokens never enter document state/content or URLs.
Implement declarative widget bind using literal JSON pointers into channel state, with catalog type validation and no eval/expressions/prototype segments. Current snapshot/replay drives binding; malformed bind has useful error. State changes preserve user's typed native fields and content editing banner/lock. Header/widget states keyboard reachable, theme-token colors, visible focus, status announcements, usable at phone/tablet/desktop. Include loading/empty/error/revoked/offline states.

Acceptance and verification:
Mock Transport and browser tests for exact approval card details, deny/revoke/replay behavior and token safety. Binding valid pointer/types and rejected malformed/expression/prototype paths; snapshot/reset/duplicate patch updates idempotently. Active field focus/caret/value/scroll survives state changes, and dark/mobile/keyboard designed states visually inspected.

Integration boundaries:
Own canvas route/grant/token header UI and gen-ui state binding behavior/catalog validation; parent serializes shared widget/Transport contract adjustments.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

## Phase 6: Delivery verification and documentation

### Task 6.1: [doc-channel] [P6] Verify all phases and document author migration

- Status: pending
- Size: large
- Priority: medium
- Dependencies: 3.4, 4.5, 5.2
- Parallel with: none declared
- Issue: none; parent issue: none

Complete sanitized full-phase consumer proof for standalone bearer fetch-SSE and bound widgets, retaining native/MCP/frame writer handoff scenarios. Lost writer response and channel retry remain one mutation/event; restart produces one canonical receipt-backed turn, app ack distinct from completion, partial ack exact, in_doubt never automatic repeat. Reconnect/retention reset/revocation preserves draft/focus/caret/scroll/selection/Undo/unseen indicators. Do not change personal vault or claim production consumer migrated.
Write app-author emit/on/state/retry/grant/token documentation and developer canvas/Relay/runtime-conformance guides/API/tool descriptions. Explain in-memory pre-acceptance page-close loss, recorded versus dispatch-start versus runtime completion versus app ack, same-page untrusted captures, missing generic outward-action cap and external-editor race. Production LifeOS steps require stable writer receipts/pending handoff and disabling notifier/AckWatcher retry ownership; retained writer/build/note-open/JSONL mirror remain explicit. Use user-facing writing skill and changelog fragment, no prices or unsupported platform claims. General DOR-2660–2664/2666 remain independent changes/receipts.

Acceptance and verification:
Run relevant targeted unit/integration/conformance tests, server/client/shared/Relay typecheck and lint, browser suite with screenshot inspection and pnpm verify before PR. Record exact proof subjects and limitations, not mock-only claims. Signed webhook full-app regression belongs to DOR-2661 and is cited only once that independent task proves it; Doc Channel does not declare it fixed.

Integration boundaries:
Own final v2 consumer acceptance, docs/contributing guides/API descriptions and changelog fragment; parent owns release readiness and final aggregate verification.

Implement in an isolated checkout. Preserve runtime SDK confinement and client FSD public-barrel imports. Use temporary data and fake runtime callbacks; paid model paths remain unarmed. Run targeted tests and relevant package typecheck/lint, and run the browser suite with visual inspection for changed UI. Parent integrates shared-file edits and owns tracking.

## Dependency paths

Foundation: 1.1 → 1.2. Routing: 2.1/2.2 → 2.4 → 2.5 → 2.6; 2.7 additionally requires DOR-2660. Host API and state converge at 3.1. Frame SDK requires 3.1 plus DOR-2662/2663. Native widgets can progress separately. v1 proof is 3.4; v1.1 proof is 4.5; final full-scope proof is 6.1.

After 1.2, 2.1 and 2.2 can develop in parallel against foundation contracts. After server contracts stabilize, room/Relay, streaming/frames and native-widget lanes use separate ownership. MCP, editor and presence tasks can proceed independently once their dependencies land. No task is made smaller by splitting a safety invariant across PRs.
