# Stored-model launch reconciliation tasks

Generated from `03-tasks.json`. Task state and dependencies are authoritative there.

## Phase 1: Atomic birth foundation

### Task 1.1: Add durable allocation and inference lifecycle storage

- Status: completed
- Size: md
- Priority: high
- Dependencies: None
- Parallel with: None

Add one durable allocation table with exact session-id primary key, version and createdAt. Enforce three disjoint sources: person-location requires ownerId/locationId, person-agent requires ownerId/registeredAgentId/recordedRegisteredPath, internal requires typed durable source identity and no fabricated person/location. Allocation stores no model/runtime/permission/account grant or dispatch. Add nullable metadata model_launch_state with pending-v1, attempted-v1 and established-v1. Migrate every old row to null without scanning events or guessing unused state. Keep unconsumed allocations across restart/reopen with no TTL, cap or automatic retry. Define collision and exact source validation errors with no winner adoption. Acceptance: real migration/SQLite source-shape rejection, restart persistence and old-row null tests. Allocation alone creates no metadata/settings/native/request/launch-limit row.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 1.2: Transfer birth through every first metadata writer

- Status: pending
- Size: lg
- Priority: high
- Dependencies: 1.1
- Parallel with: None

Implement a cohesive synchronous transaction seam. Derive authenticated request/owner inputs and await config/agent reads before SQL. Inside the same transaction re-read persisted allocation, source/owner congruence, durable queue/room generation and available ownership fences, perform ORIGINAL metadata INSERT or conflict expression, and consume only successful exact new-row birth. Cover runtime-registry inserts at persistSessionRuntime, rememberNativeSession, markAutoResumed and saveSessionSettings, chat-rise-facts person marker, three continuation-hold inserts, two required-launch-store inserts and two required rekey inserts. Imported/native/resume/aliases never become new from absence or UUID equality. Preserve every original seed, explicit PATCH, runtime-null CAS, hold and error behavior. Thread actual server-only context to early helpers. A newly allocated write unable to prove context remains uncommitted rather than losing birth. Test crash-before/after commit, best-effort writer failure, competing row/source/owner, early hold/person write before bind and real canonical rekey. Move proven lifecycle/allocation only with authenticated identity transaction and preserve ambiguous destination.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 1.3: Preserve original permission authority and seeding

- Status: pending
- Size: md
- Priority: high
- Dependencies: 1.2
- Parallel with: None

Extend actual HTTP/runtime-registry SQLite regression families for the delivered DOR4411 half of DOR1692. Assert explicit bound runtime wins over registered hint and inference, claimedPermissionMode evaluates actual stored value, declared values survive, undeclared values normalize to strictest, and unknown runtime retains existing behavior. Compare absent row, explicit settings PATCH then CLAIM and already-bound winner for every origin with and without valid birth provenance. Interactive/session-relay configured-stop and room/heartbeat/extension/chat-message insert-only policy retain exact INSERT versus CLAIM outcomes. Verify model/effort null filling, agent identity and launch columns unchanged. No new catalog/native I/O at metadata binding. Acceptance: measured nonzero actual service tests, including allocation/early-placeholder transfer, no changed permission outcomes or authority snapshots.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

## Phase 2: Real birth routes

### Task 2.1: Add person-owned location and registered-agent allocation

- Status: pending
- Size: md
- Priority: high
- Dependencies: 1.2, 1.3
- Parallel with: None

Under createSessionLocationsRoutes retain existing folder POST/GET dedup and wildcard cross-site/person rules. Add POST /session-locations/:id/chats with strict empty body, same real owner/location UUID lookup and boundary revalidation, then mint server UUID and store person-location allocation only. Add POST /session-locations/chats strict {kind:registered-agent,agentId}, resolving current exact Mesh id/projectPath from the same live registered list. Store person-agent variant and apply no arbitrary-folder boundary or provisioning to this previously supported agent-only path. Missing registration/path refuses allocation without default fallback. No caller id/path/runtime/model/payer/lifecycle selector, settings or dispatch. Acceptance: actual route person/origin/foreign owner/boundary tests, current registered folder outside arbitrary-folder boundary remains inertly allocatable where existing launch supports it, unique concurrent ids, collisions preserve winner and first-send registration/pause/place/account checks remain unchanged.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 2.2: Use acknowledged chat ids in every normal client entry

- Status: pending
- Size: md
- Priority: high
- Dependencies: 2.1
- Parallel with: None

Add actual shared Transport method, HttpTransport session factory composition and maintained central/mock fixture support. Migrate genuinely fresh New chat, resolveSessionForCwd new branch, /clear, creation greeting, suggested prompt, session-link and route/directory/agent fallback entry points to one intentional/in-flight allocation before PATCH/send. Use location or registered-agent variant matching actual source. Keep acknowledged UUID across saved draft/restart/send refusal and avoid automatic retries. Existing latest chat and actual direct-seat server id remain unchanged, including owner-only direct-chat and nonowner fallback. Keep navigation-abandonment fences, canonical stream settlement, pending runtime/account intent and continuedFrom. Existing explicit hub relay ids/protocol remain untouched, computer-local keeps strict same-server placement. Acceptance: real maintained route/transport and UI tests for each mint path, reused draft, direct-seat, missing agent folder, stale navigation and no replacement allocation on existing ids. Browser only maintained synthetic Test Mode where needed.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 2.3: Record internal receipt and seat births atomically

- Status: pending
- Size: lg
- Priority: high
- Dependencies: 1.2, 1.3
- Parallel with: None

Use internal variant of same table for actual async pre-metadata gaps. At chat-send-message new-target branch insert receipt chat_messages.id, exact minted toSessionId and corroborating queueMessageId with allocation in ONE store transaction. Existing-target messages allocate nothing. Actual room-store.bindRoomSession inserts allocation only if its roomId/authorId seat INSERT wins, recording actual sessionId/createdAt generation. Concurrent loser returns real seat and allocates no losing id. Restart consumer validates actual dispatcher queue/receipt source and current seat tuple before metadata transfer. Preserve current limitation that a receipt without a dispatcher queue row is not automatically delivered. Exact source deletion removes only its still-unconsumed allocation in real owner transaction. Canonical rekey moves source/linkage atomically or preserves conservative collision, no best-effort identity split. Test true queued restart, concurrent seat winner, source deletion/rebind, crash windows, foreign source and existing legacy receipts/seats.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 2.4: Carry birth across remaining genuine server mint owners

- Status: pending
- Size: lg
- Priority: high
- Dependencies: 1.2, 1.3, 2.3
- Parallel with: None

Wire same typed internal allocation or immediate atomic pending stamp at actual fresh branches in relay binding, room new/replacement and direct-seat, fresh task run versus sticky reuse, new heartbeat day/account-seat move versus existing day, extension start/agent-send, chat-message/todo, current owning session_start implementation, carry-over successor, required recovery destination, computer-local startup and connector subscription fresh versus reuse. Preserve existing durable source identities and admission/launch limits. Persist allocation before actual async gap in existing owner transaction, without adding lifecycle flags to unrelated durable tables. Never stamp generic bind, old startup probe id, import, rekey alias, old room/day/run or copied established source as fresh. Test every census mint/reuse branch and interrupted/reopened legitimate metadata-only fresh source. Retain carry-over account/model/frozen context and original origin seeding, source chat unchanged. Report any actual unexpressible owner fence before broadening authorization.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

## Phase 3: Owned launch evaluation

### Task 3.1: Evaluate saved models at the actual outbound owner

- Status: pending
- Size: lg
- Priority: high
- Dependencies: 1.2, 1.3, 2.1, 2.3, 2.4
- Parallel with: None

Implement owner-local decision for pending fresh birth: keep unchanged when evidence unknown, refuse positively excluded explicit model only with fresh applicable COMPLETE selected runtime/session/account/payer evidence, or delegate existing approved adapter substitution. Offered value/resolvedModel aliases count. Empty/stale/partial/timeout/unverified/config-only/wrong-context catalog is unknown. No discovery in metadata bind, credential fetch or new sample/model request to settle uncertainty. Recheck exact model, canonical owner, abort/rekey/account/payer after awaited evidence. Changed input yields bounded stale refusal without retry/overwrite. Pure refusal writes no model or state and must leave no child/settings/claim/audit/projector leak. CAS pending->attempted immediately before outbound after final no-await check, keeping uncertainty if handoff not acknowledged. Failed attempted write blocks outbound. Positive response establishment uses later adapter proof only. Test actual deferred external catalog with SQLite concurrent winner/abort/rekey, true no-request counts, unknown and independently allowed positives.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 3.2: Apply Claude cold and warm response attribution

- Status: pending
- Size: md
- Priority: high
- Dependencies: 3.1
- Parallel with: 3.3, 3.4, 3.5

Cover actual cold/resumed message-sender and warm pump/SDK append with the same owned lifecycle. Claude current global cached menu lacks complete final selected-account proof, so preserve unknown unless existing owned metadata source has demonstrated no-cost completeness. Establish only real main SDK stream_event message_start with response identity, excluding parent_tool_use_id/helpers/init/user/error wrappers. Attribute to exact evaluated logical owner and prepared frame before paused consumer yield, never mutable current session. Persist owner-checked establishment independently of turn-granular event flush. Test actual runtime with scripted SDK edge, cold/resume and same warm SDK instance across two real logical turns, stale old response, helper response, no response and fresh current positive. No new query to force evidence, preserve cleanup and permission behavior.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 3.3: Apply Codex account-specific evaluation and uncertainty

- Status: pending
- Size: md
- Priority: high
- Dependencies: 3.1
- Parallel with: 3.2, 3.4, 3.5

At real acquired app-server process/thread before turn/start use final selected account/payer context. Preserve DOR3168 verified same-account/default/custom/credits substitution and durable notice as owning narrower behavior, no generic default or duplicate gate. Cached global catalog cannot prove complete final scope. For establishment trace actual ThreadChannel and thread/tokenUsage/updated producer correlation. Last counts lack request id and mapper-local dedup resets on resume, so historical/repeated/zero usage alone leaves attempted uncertain. If real correlation is proved, persist only current evaluated owner response. Test real pool/transport/SQLite with scripted protocol process, pending->attempted before send, inherited old usage, genuine current response if distinguishable, abort/account change and independent valid model. No native binary/account probe or fabricated usage. Exact landed DOR3168 integration is required by final integration task before final acceptance.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 3.4: Apply OpenCode prompt and command response rules

- Status: pending
- Size: md
- Priority: high
- Dependencies: 3.1
- Parallel with: 3.2, 3.3, 3.5

Place gate after actual plan/model/session account binding and before promptAsync or command request using existing leases/subscriptions cleanup. Provider.list/public menus and unmatched localhost tags remain unknown, no generic account entitlement claim. Trace pinned event producer and actual mapper to distinguish model-generated main text/thinking or attributable provider usage from synthetic/error assistant frames, shell/tool/command completion and child output. Establish only truly correlated current evaluated model response. If producer cannot support that distinction, retain attempted uncertainty with existing compatibility and no additional refusal. Test actual OpenCode lifecycle with scripted external client for prompt and command paths, synthetic/error-only response, child, no response, current positive if supported, abort/rekey and cleanup before resume. No sidecar/provider discovery solely for this gate.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 3.5: Apply Doe purpose-aware durable response rules

- Status: pending
- Size: md
- Priority: high
- Dependencies: 3.1
- Parallel with: 3.2, 3.3, 3.4

Use real Doe engine/frozen execution context before outbound. Configuration alone does not confirm upstream availability, so unknown preserves model. At actual provider onUsage, real ModelStore recordUsage persists before emission and write failure remains fatal. Establish only exact current evaluated scope=main AND ordinary inference purpose using request identity from actual callback/store, excluding child and summary even when summary uses main scope. Shared model_request drops purpose and cannot alone prove this. Test actual engine+SQLite with scripted external model edge for main normal response, child/summary, zero/missing usage, persistence failure, abort and first real outbound ordering. No invented token/cost/response or credentials just for validation. Keep tool/approval/native authority behavior unchanged.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

## Phase 4: Composition and delivery evidence

### Task 4.1: Compose landed model and context prerequisites

- Status: pending
- Size: lg
- Priority: high
- Dependencies: 2.2, 2.4, 3.2, 3.3, 3.4, 3.5
- Parallel with: None

Before final acceptance integrate actual reviewed landed DOR3168 and DOR4488 source into the current implementation baseline through normal owned workflow. Verify actual main ancestry/diffs and all intersections, including launch-model default/substitution/prompt recording, durable notice/history and warm/reopened/new model picker context. Preserve original explicit model intent, credits/custom-provider/account scope, configured default selection and concurrent settings winner semantics. Run meaningful actual composition regressions with real transport/store routes and scripted execution edges, including loaded notice + sendPrompt recording reaching actual turn when account fallback applies. Prior source-qualified evidence may carry only when exact semantics remain unchanged. Preserve historical failures and report conflict/source changes for root review. Acceptance requires exact landed inputs and nonzero combined owning cases, no assumed PR/draft code or cross-lane edits.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.

### Task 4.2: Verify complete first-inference and compatibility contract

- Status: pending
- Size: lg
- Priority: high
- Dependencies: 4.1
- Parallel with: None

Run final actual existing affected route/SQLite/adapters/client families on composed exact source. Cover all normal and internal birth/reuse paths, every first writer and atomic crash/source conflict, legacy/import/native rekey and established compatibility, catalog unknown versus complete exclusion, no-request/no-cost outcomes, attempted uncertainty and real attributed establishment. Include original DOR4411 bound/hint/CAS permission and all origin INSERT/CLAIM comparisons plus DOR3168/DOR4488 composition. Regenerate actual OpenAPI/migrations through existing tooling with scoped diff, normal types/lint/format/security floors and required exact-head verification receipt before publication. Use genuine stock resource policy: job24 builds/types, tests16 multifile/native/browser, worker1/retry0/defaults. Never weaken guards, skip cases, raise floors or claim false zero inference from missing data. Root performs compliance then REVIEW.md quality/security and delivery. Acceptance is measured nonzero unique census/raw errors/source bindings and authentic exact-head proof, with honest unknown and platform limits.

Use actual owned services, SQLite and route/runtime lifecycles. Script external SDK, process, model or catalog edges only. Keep native authentication, permission checks and account/payer selection real. Use default test bounds and zero retries. No personal profile, provider, paid inference or deliberate native/auth/permission weakening. Preserve raw failures and exact source-qualified proof.
