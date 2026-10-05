# Relay delivery receipts — canonical task projection

Generated: 2026-10-01T20:37:33Z; mode: full.

**Design:** Frozen following independent design-only re-review by `/root/receipt_spec_adversarial` (GPT-6.1 Sol, Medium).
**Delivery:** Pending verified merge/DONE. All eight implementation tasks are completed with recorded proof and accepted independent reviews (8/8). PR delivery remains pending.

`03-tasks.json` is canonical. This readable file is generated from its task records; parent owns live Task API/tracker projection. One coherent DOR-2666 scope/PR; no promoted sub-issues.

Critical path: 1.1 → 1.2 → 2.1 → 2.2 → 2.3 → 3.1 → 3.2 → 3.3. No parallel writers; parallelWith is empty for every task.

### Task 1.1: [relay-delivery-receipts] [P1] Define receipt contracts and authoritative database tables

**Status:** completed · **Phase:** Foundation · **Size:** medium · **Priority:** high
**Dependencies:** None
**Active form:** Defining receipt contracts and database tables
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

Add RelayDeliveryReceipt/failure schemas in packages/shared/src/relay-envelope-schemas.ts, exported through @dorkos/shared/relay-schemas. Receipt fields: messageId existing ULID, scope agent_delivery, state accepted|delivered|failed|outcome_unknown, acceptedAt, updatedAt, expiresAt, optional settledAt and failure {code,message}. Enforce state/field consistency: accepted has no settlement/failure; delivered has settlement without failure; failed/unknown have settlement+failure. Closed codes: at_capacity, chat_unavailable, rate_limited, budget_exceeded, initiate_denied, untrusted_bridge_principal, turn_ceiling, adapter_unavailable, not_dispatched, adapter_failed, observation_lost; the last is unknown-only. Use fixed safe messages, not arbitrary errors. ULID regex ^[0-7][0-9A-HJKMNP-TV-Z]{25}$; ISO timestamps. Existing POST fields/status remain compatible.

Create packages/db/src/schema/relay-delivery-receipts.ts with relay_delivery_receipts: message_id PK, validated target subject, nullable verified owner_user_id, state, boot_epoch, accepted_at, updated_at, settled_at, expires_at, failure_code/message. Index expires_at/message_id and state/boot_epoch. No payload, from, replyTo, credentials, protected source or owner cascade. Add relay_receipt_observer_owner singleton: constant key observer, per-core owner_token, pid, hostname, claimed_at. This authoritative metadata survives relay_index rebuild; Maildir still owns payloads. Register schema in schema/index.ts and drizzle.config.ts. Generate normal Drizzle migration/snapshot/journal; never recreate DB or patch old migrations.

Acceptance: schema tests reject inconsistent states and secret/error interpolation; pre-feature DB migrates preserving existing rows; repeat migrations safely; generated registry agrees; defaults do not assign fake ownership or delivery. Test valid/invalid ULIDs and unchanged non-receipt response fields.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 1.2: [relay-delivery-receipts] [P1] Implement exclusive observer ownership and receipt persistence

**Status:** completed · **Phase:** Foundation · **Size:** large · **Priority:** high
**Dependencies:** 1.1
**Active form:** Implementing observer ownership and receipt persistence
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

Add packages/relay/src/delivery-receipt-store.ts accepting the resolved Db, injected clock and per-core observer token. Implement create/get/CAS settle/recover/prune and exclusive owner acquire/release with no payload duplication. Acquire database singleton under BEGIN IMMEDIATE only outside db.$client.inTransaction; actual database row, not dataDir/path, arbitrates same injected handle, multiple file handles and separate processes. Existing @dorkos/shared/process-liveness corroborates PID against claimed_at with bounded probe. Live-confirmed, live-unconfirmed, same-current-process lifetime, malformed holder or foreign hostname blocks; only proven gone permits takeover. Never use instance-lock same-PID=gone semantics, test bypasses, age/heartbeat expiry or distributed leases. Contention is RELAY_RECEIPT_OBSERVER_BUSY.

Fence every mutation and release by singleton owner_token inside the same immediate transaction. Accepted receipt settlement also matches receipt boot_epoch and state accepted; terminal is immutable. Reject any caller-owned active transaction rather than joining a savepoint, including get/acquisition/recovery/settlement/release, using RELAY_RECEIPT_TRANSACTION_ACTIVE. Store safe fixed code/message only, seven-day immutable acceptance-based expiry (604800000 ms); expired/pruned IDs are not recreated. Storage error is distinct from not-found.

Acceptance tests: two same-process cores on one Db and two handles on one file block the second while first deferred receipt stays accepted and later settles delivered; two real child processes have exact one winner/zero loser effects; owned child exit permits recovery. Same PID live/uncorroborated/foreign-host blocks; proven-dead/recycled PID permits acquisition. Wrong-token writes/releases fail safely. Outer transaction cannot be committed/rolled back by receipt store. No-op late terminal/pruned callbacks. No inference or process-name kills.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 2.1: [relay-delivery-receipts] [P2] Persist tracked acceptance before every publish effect

**Status:** completed · **Phase:** Delivery observation · **Size:** large · **Priority:** high
**Dependencies:** 1.2
**Active form:** Persisting acceptance before publish effects
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

In RelayCore resolve a single Db before constructing both SqliteIndex and DeliveryReceiptStore. Injected DB is caller-migrated and remains caller-owned; standalone creates dataDir/index.db and runs registered migrations. Preserve connection-close ownership and existing non-tracked behavior. Share/export the exact current detached relay.agent. predicate rather than duplicating startsAgentTurns logic. Add internal receiptContext {ownerUserId:string|null,onReceiptCreated(messageId):void}; never parse it from HTTP request data or copy it into RelayEnvelope. Public PublishResult gets optional receipt only.

At tracked publish entry reject $client.inTransaction synchronously before initialization/ID minting/effects. Validate subject/access normally; invalid/access-denied creates no receipt. After ID minting, commit initial receipt before rate limit processing/accounting writes, Maildir, subscribers, pending buffer or adapter effects. Own create transaction ends before any await/effect. Immediately after commit invoke the trusted locator-assignment callback before any later work. Missing store/exclusive ownership/recovery/storage fails closed with typed 503 and zero effects.

Eligible HTTP agent targets retain receipts when rate/consent/bridge/budget/ceiling gates refuse, no adapter exists, or adapter skips; settle only this target and do not mask turn failure with successful mailbox fan-out. Use exact closed codes; preserve existing DLQ/buffer/consent/reserved subject, sender and ceiling policies. After accepted handoff return a fresh persisted snapshot, including a fast terminal result. All post-insertion errors retain locator metadata and can only conservatively mark unknown, not confident no-effect failure.

Acceptance: zero exact delivery effects on initial insertion failure and outer-transaction publish/rollback; committed normal receipt survives later unrelated rollback. Gate/no-match/ceiling states are correct even with mailbox success. Non-agent/untracked publish responses and scheduling remain unchanged. Standalone migration/reopen works and injected DB remains open.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 2.2: [relay-delivery-receipts] [P2] Observe detached outcomes without misclassifying bookkeeping failures

**Status:** completed · **Phase:** Delivery observation · **Size:** large · **Priority:** high
**Dependencies:** 2.1
**Active form:** Observing detached delivery outcomes
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

Wire receipt settlement in AdapterDelivery for the real detached registry promise. Non-skipped success -> delivered; explicit success:false -> failed with supported machine code or adapter_failed; result null -> failed/adapter_unavailable; skipped -> failed/not_dispatched; synchronous throw or rejected promise -> outcome_unknown/observation_lost. at_capacity comes only from typed DeliveryResult.code, not prose. The receipt observes adapter outcome, never business success, reply-read or private admission. Terminal CAS also fences live singleton token.

Keep receipt/audit bookkeeping exceptions outside the adapter-failure promise catch so successful turns cannot become false failed delivery or failure DLQ/refund/notice. Persist known receipt outcome before best-effort audit/DLQ/notifications; preserve exactly existing reservation/refund decisions and bridged human-chat-only capacity holds. Receipt bookkeeping itself cannot reserve/refund/invoke/send notices or manufacture DLQ. DLQ failure does not erase at_capacity.

On terminal write failure log safe storage observation and attempt one isolated unknown CAS outside a caller transaction. If unavailable/active transaction persists leave last durable accepted, expose availability failures on reads, and allow later exclusive recovery to classify unknown; no in-memory authoritative cache or resend. Do not commit or roll back unrelated caller transactions. Late/duplicate callbacks cannot overwrite terminal/recovered/pruned rows.

Acceptance: deferred outcomes for success/failure/null/skip/throw yield exact state/code; success plus store/index exceptions produces zero failure DLQ/notice and no receipt-caused refund; fallback unknown persistence tested; persistent storage/transaction outage retains durable accepted for later recovery; DLQ ok:false and throw preserve failed receipt; existing only-chat onHeld and carried ceiling refund tests remain green.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 2.3: [relay-delivery-receipts] [P2] Recover exclusive observations and prune bounded receipt history

**Status:** completed · **Phase:** Delivery observation · **Size:** medium · **Priority:** high
**Dependencies:** 2.2
**Active form:** Recovering observations and pruning receipt history
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

After migrations and exclusive database observer acquisition, recover older-token accepted receipts before enabling tracked publishing. Different epoch alone never proves dead owner. Failed acquisition/recovery returns receipt-use 503 and leaves unrelated existing non-tracked Relay behavior; later initialization retry is metadata-only and never dispatch. Already-terminal/current-owner records remain untouched; recovered state unknown/observation_lost never retries or inspects mailbox contents. Existing mailbox recovery retains its separate policy.

Integrate expiry into existing RelayGc sweep as isolated phase. expiresAt is acceptance+seven days, unchanged by polling/settlement; now>=expiresAt reads as absent before physical prune. Delete at most 500 expired rows in ordered expiresAt/message_id batch, under token-fenced transaction outside caller transaction; leave payload files, derived rows, traces and private receipts untouched. A failed phase does not break other GC phases.

On graceful close latch receipt subsystem closed, block new tracked publishes/callback writes, atomically mark own outstanding accepted unknown and release singleton only for matching token before underlying DB closes. Late callbacks are no-ops. If active transaction or DB outage prevents release, retain durable owner and report safe error; a second same-process core stays blocked until owned release succeeds or process exits. No heartbeat stealing or unconditional cleanup.

Acceptance: index rebuild+real close/reopen preserve terminal metadata; proven-dead owner recovery changes exact one pending receipt/zero effects; live owner is never recovered. Late old callbacks cannot alter successor/pruned state. Failed release blocks another core. 500-row prune bound, precise expiry boundary, no renewal, and private/mailbox rows unchanged.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 3.1: [relay-delivery-receipts] [P3] Expose owned status reads and preserve locators across route errors

**Status:** completed · **Phase:** HTTP and delivery verification · **Size:** large · **Priority:** medium
**Dependencies:** 2.3
**Active form:** Exposing owned status and preserving route locators
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

In apps/server/src/routes/relay.ts create trusted receiptContext only for relay.agent. destinations. Capture verified res.locals.user.userId when login on, null when off. Preserve existing server principal/destination and validation checks before publication. Route-owned onReceiptCreated synchronously assigns messageId/statusUrl variables outside entire try/catch before any later effects. Existing successful POST stays 200 and adds receipt/statusUrl, leaving deliveredTo and other fields unchanged.

Add GET /api/relay/messages/:messageId/status returning bare receipt with no-store. Validate ULID; malformed 400 INVALID_RELAY_MESSAGE_ID after auth; unknown/expired/untracked/other-owner uniform404 RELAY_RECEIPT_NOT_FOUND. Existing gate then exact trusted owner: login-on non-null owner matches user, null local-trust owner readable only by verified readOwnerAccount install owner; login-off follows local trust. Never trust from/replyTo/client/body owner data. No payload/subject/owner/token/transcript disclosure, no fallback to index/DLQ. Storage/observer/transaction unavailable use distinct documented503 codes.

Auxiliary activityService.emit errors are safe-log best-effort and keep accepted 200. Any other structured post-insertion route exception, including before publish returns, snapshot lookup or later construction/serialization work, includes exact messageId/statusUrl and safe RELAY_RECEIPT_RESPONSE_UNAVAILABLE503 rather than bare PUBLISH_FAILED. Pre-insertion availability failure guarantees zero effects/no locator; existing authority/validation errors unchanged. If headers already sent/network gone do not send twice or alter receipt; lost response never means resend is safe. Register complete OpenAPI schema/error responses in services/core/openapi-registry.ts.

Acceptance: real POST/deferred adapter/GET without replyTo proves at_capacity; authenticated other owner404, forged data grants nothing, off-to-on owner-only adoption and off-again local trust; activity rejection200 still retains receipt; post-insertion pipeline and route failures retain exact locators; error sentinels reveal no secrets. Existing route patterns do not shadow status/trace paths.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 3.2: [relay-delivery-receipts] [P3] Update Transport and explain delivery observation limits

**Status:** completed · **Phase:** HTTP and delivery verification · **Size:** medium · **Priority:** medium
**Dependencies:** 3.1
**Active form:** Updating Transport and receipt guidance
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

Extend packages/shared/src/transport.ts sendRelayMessage result with optional typed receipt/statusUrl and add getRelayDeliveryReceipt(messageId) returning RelayDeliveryReceipt. Implement through apps/client/src/layers/shared/lib/transport/relay-methods.ts using existing fetchJSON boundary, no raw fetch in consumers. Enumerate and update all real Transport implementations/mocks/factories by rg so a new required method does not survive only in mock or break unrelated tests. No UI/poller is added. Shared facade/barrel imports only.

Update docs/guides/relay-messaging.mdx and relay-observability.mdx with same POST request/200 compatibility, exact agent_delivery scope, normal-auth status GET example, seven-day acceptance expiry, at_capacity, accepted versus delivered/unknown and mailbox fan-out distinction. A receipt is minimized observation, not durable queue, private admission, exactly-once, business outcome or retry token. Explain local-trust posture, owner adoption when login is enabled, availability errors, and status-read retries rather than message resend. Database-file corruption cannot reconstruct authoritative metadata from Maildir; normal restart/index rebuild retain it. Add contributing guidance only if the new shared predicate/settlement seam needs it. Use writing-for-humans for user prose and honor retired vocabulary. Add one timestamped user-facing changelog fragment for the shipped behavior at implementation review; no historical changelog edit.

Acceptance: typed Transport and OpenAPI match runtime contract; relevant mocks/consumers typecheck; safe doc examples parse with valid ULIDs and live API paths; no claim of implementation from frozen artifacts. No new source domain/config flag/SDK/CI change.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.

### Task 3.3: [relay-delivery-receipts] [P3] Prove receipt guarantees and prepare one reviewed delivery

**Status:** completed · **Phase:** HTTP and delivery verification · **Size:** medium · **Priority:** medium
**Dependencies:** 3.2
**Active form:** Verifying receipt guarantees and preparing delivery
**Tracker promotion:** None; parent projects this checklist onto DOR-2666.

Complete the coherent DOR-2666 PR verification using real temporary SQLite/RelayCore/router and fake only adapter effect boundary/auth seam. Deferred promises and injected clocks replace sleeps; tests have purpose comments/exact IDs/counts. Cross POST->detached at_capacity->GET without replyTo; cover all explicit outcomes, gates plus mailbox partial success, no match, zero effects on storage or transaction rejection, audit/DLQ failures, exclusive live-owner contention across same Db/two handles/two child processes, owner death recovery, close/token fences, index rebuild/reopen, migration and standalone DB path, seven-day expiry/500-row GC, ownership transitions/minimization, locator-bearing post-publish failures and compatibility. Preserve private acceptance/dispatch suites as unchanged exclusion regressions, existing holds and ceiling refunds. No inference/live paid harness.

Prove green baseline and collection; temporarily remove detached receipt settlement so only intended HTTP at_capacity regression fails; restore/rerun. Independently bypass active outer-transaction guard and confirm rollback-after-effect regression red; restore/rerun. Run changed test files using pnpm vitest run <path>, changed package filtered typecheck/lint for shared/db/relay/server/client, generated migration check, then pnpm verify. Do not run bare full vitest or modify CI. Record actual command outcomes and limits in 04-implementation.md; task passes only with observed evidence.

Parent owns tracker/task projection, implementation claim, pre-PR review, attach/merge and DONE. Prepare one reviewable DOR-2666 branch with all tasks converged, avoiding promoted sub-issues and separate partial-delivery PRs. Do not mark delivery complete until the required review/verified merge/DONE gate is satisfied; frozen design/adversarial design review is not runtime proof. No speculative API/queue/private admission extensions.

Scope fence: this is one DOR-2666 change in the existing Relay project, intended to land as one coherent PR after all tasks converge. Do not add private-session admission/source kinds, replay/resend, durable dispatch, operator authority changes, UI/SSE/MCP/A2A surfaces or paid inference. Use existing facades, one writer per checkout, and meaningful tests with exact IDs/counts rather than sleeps or vague bounds. All implementation and delivery are pending; design approval is not runtime evidence.
