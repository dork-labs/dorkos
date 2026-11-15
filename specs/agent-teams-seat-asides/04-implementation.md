# Implementation Summary: Private messages into room seats

**Created:** 2026-11-15
**Last Updated:** 2026-11-15
**Spec:** specs/agent-teams-seat-asides/02-specification.md

## Progress

**Status:** In Progress — root approved full spec and source implementation
**Tasks Completed:** 6 / 7 (implementation and scoped regression proof; final pushed-head handoff pending)

## Tasks Completed

### Session 1 - 2026-11-15

**Workers:** `/root/trust_reconciliation`, continued original worker; gpt-6.1-sol workhorse fallback approved by parent.

Tests were authored before source acceptance wiring. No task is reported verified/completed until execution is permitted and evidence exists. No tracker calls. Parent verified canonical CLAIMS entry and no competing PR before assignment.

## Files Modified/Created

**Source files:** Draft dedicated seat routing/inbox, explicit receipt route/scope migration, atomic local notice, carry/defuse helpers, cancellable room-release waits and terminal receipt ownership. Ordinary send orchestration extracted; ordinary predicate and Part A prompt region unchanged.
**Test files:** Seat integration, actual bridge/consent positive control, origin/adoption, lifecycle, ordinary queue policy, shutdown wiring and real migration coverage. Scoped red/green and package-check results are recorded below; final verification follows the pinned integration base.
**Artifacts:** Flow01/02/03json/03md/04, draft ADR and manifest entries.

## Known Issues

Parent approved durable route/scope and atomic no-body trace. Full API/queue/recovery contract is approved and frozen. The integrated migration is 20261116110632 idx201 on exact 1f86. Root authorized source after PR#3809 and PR#3810 independently reviewed/opened/required-green. Branch does not require their source changes; leave ordinary predicate/prompt removal regions untouched. Heavy commands require a fresh load at or below16; bounded targeted tests follow the separately approved measured resource limits.

## Implementation Notes

### Session 1

Worktree `/Users/doriancollier/Keep/dork-os/dorkos-worktrees/codex-at-dor-4472`, branch `codex/at-dor-4472`; pinned base `a23056f0a528393a9f3eea312c516ed8660f77b6`, seed `51947d1dd320ff6bac0741b72a6d00e2d41f6e63`. No moving remote ref used. uptime read before work: load7.59/8.07/8.47. No tests/build/browser/desktop/live ports/paid paths. Dependency setup `pnpm install --frozen-lockfile --ignore-scripts` passed after the first docs commit attempt correctly refused missing prettier/turbo. Normal formatting/docs hooks will run before this artifact commit. Bounded resource assumptions25 per seat/1000 global/1h approved for spec by root; batch bound applies to final defused rendered prompt including separators. D1/D2 yes, D3 no switch, D4 unchanged. PR handoff must hold+review:deep; Code owns arming/labels/release/Done.

### Authoring checkpoint — 14:43 CT

Dedicated source and all main proof scenarios authored. Metadata generator produced reserved migration20261115194500 idx197; its SQLite rebuild SELECT was corrected to initialize new columns for legacy rows instead of selecting nonexistent columns. Down migration fails pending seat rows and guards against later migrations. Independent expiry timer per inbox addresses root's deferred-active-aside finding; terminal CAS addresses late completion after stop/restart. Tests use existing send/room seam so reverted service fails on actual seat refusal, not missing new exports.

Heavy verification remains held: observed load repeatedly28–60 since14:08, latest14:42 load28.26/36.33/37.96. No test, dependency build, lint or compiler run claimed. Only source formatting/metadata generation and diff-check performed. Next: executable pre-fix/unsafe-mutant red proofs, green, package scoped checks and exact-range review once load is below16.

### Semantic integration — 15:17 CT

Rebased planning commits onto exact f9c8ca281cfa5e33e909ae5c5e5c896648e14d19 because its task-approval migration occupiesidx196. New planning HEAD4b60572eaaf3fae7fbe53a71c6fb5e34a0388a3b (see exact rebase record for full actual head). All34 non-generated source/doc/test files restored hash-identically before regeneration. Drizzle generated 20261115211709_seat_chat_delivery_route.sql and its snapshot/journal from the actual preceding schema, automaticallyidx197; no manual journal index bump or old snapshot copy. Down/test references updated. Generated rebuild SELECT supplies explicit legacy chat/null baseline for newly added columns. Lockfile unchanged. Final executable proof uses the new f9 base.

### Scoped migration proof — 15:50 CT

Root authorized the tiny isolated in-memory SQL test while retaining the heavy server/compiler load gate. Package-isolated Vitest, one worker: green control2 executed/2 passed; deleting only the generated seat-scope CHECK produced exactly1 failed assertion among2 executed tests (a malformed seat route was accepted); migration restored byte-identically; restored green2/2. Private proof logs and actual counts are in `.dork/flow/dor-4472-sql-proof/run.json` and its three phase logs. Root separately recorded a green2-test migration run. Earlier dependency/native-binding setup failures are infrastructure and are not behavioral proof. No server test, dependency build, lint or typecheck has run; no task is marked complete.

### Light policy and wiring proof — 15:58 CT

Moved M6 origin coverage from the heavy room harness to the pure `chat-send-policy.test.ts`: actual ordinary admission predicate, verified injected session facts, interactive positive control and restricted-origin/room-bound negative cases. Isolated one-worker control10/10 green; adding relay-binding to the ordinary origin set caused exactly2 failed assertions among10 executed tests; source restored byte-identically; restored green10/10. Proof is `.dork/flow/dor-4472-policy-proof/run.json` and phase logs. Parent separately ran the source-only production shutdown wiring file:2 tests green; this is wiring coverage, not runtime cleanup proof. Full runtime/build/compiler checks remain held at load39.40.

### First bounded runtime case — 16:12 CT

Parent authorized exact cache-only dependency restoration, then a single selected M2 queue case. Current normal Turbo dry-run closures were all HIT: shared3 real compiler tasks; extension-api5 real compiler tasks. Official controller and cache restores were used without bypass or actual compilation. First selected attempt collected0 because extension-api/tool-check dist was missing (infrastructure only). After deterministic cached dependency restoration, the selected case executed1 test and failed on a real leading-command defusing gap: the common fence strips invisible characters, so a source-level ZWS before /cmd was lost. The owned seat renderer now reapplies slash-line defusing after the final fence. Identical selected case then green1 executed/1 passed,25 skipped;325ms test time,18.20s total. Logs `.dork/flow/dor-4472-m2-{first,second,third}.{txt,json}` preserve setup, behavioral failure and fix respectively. This is an initial implementation regression, not original-service baseline or per-Must unsafe-mutant proof. Further runtime cases/compiler/lint remain held pending resource condition or explicit bounded-light authorization.

### Original-service baseline proof — 16:23 CT

After a load-worsening abort before any test/source mutation, parent-authorized bounded3-process pipeline ran under the official controller. Same selected M2 queue case: current control1 executed/1 passed; replacing only ChatMessageService with exact f9 original source1 executed/1 failed on the actual room-target refusal; own source restored SHA-identically; restored green1/1. No imports/setup failures counted. Evidence `.dork/flow/dor-4472-baseline-proof/run.json` plus all phase logs and controller wrapper log. Remaining per-Must runtime mutants and package typecheck/lint are outstanding; no task-complete or PR-ready claim.

### Debugged two real probe failures — 16:31 CT

The original26-case probe failed valid reply and production cleanup. Cause1: valid reply intentionally writes no room notice; a fresh room has no latest entry, and launchBatch treated that as a gone seat. The fix supplies a constant system context-only empty-room anchor, never persisted/published; the real seat/room guards remain. Entry consumers were traced: aside context reads the frame/thread/attachment lookups and local window, runner receives explicit prompt, no read cursor/seen writer is called, and aside claims are excluded from inherited cascades. The test now verifies an actual turn, aside claim, no inherited cascade, null triggerEntryId, unchanged read cursor and exactly0room entries. Cause2: stop could clear a busy queue before the awaited busy result resumed; the continuation then installed a new uncancelled wait. It now checks stopped/empty before waiting.

Post-fix probe ran under official controller with freshload26.04 and90s child budget. A private probe-generation mistake omitted the intended -t selector and unintentionally ran the full26-case file:26 executed/26 passed,21.683s wall; both previously failing cases passed. Root was told immediately; no further test was started. Evidence `.dork/flow/dor-4472-debug-selected-1-{run.json,controller.txt}` and `.txt/.json`. This is an honest broader-run record, not a selected-only result. The executed script is preserved; a corrected selected-only script with explicit selector assertion is prepared but unrun. No full project, lifetime, bridge or package check claim.

### Semantic DOR-3060 integration

Rebased planning HEAD4b60572 onto exact main d965452436a7e75b871394f1769eac65bc3d8327; new planning HEADdb2772e261af80c7dd21051478aa5b9889773b22. Full39-file source backup SHA manifest a16577ef7a41bb007628c65306d25e76515298c438e22370396b792b66d0f5c9, under own ignored dor-4472-pre-d965-rebase. Restored35 non-overlap files identically before integration; manually ported service/store/wiring/spin-off spec onto new ordinary queue code. Ordinary deliver and maySteer, action wiring and drain joiner were checked byte-identical to d965. No batchInto resurrection; shared MAX reused from chat-client-id. Underlying DB schema/journal unchanged, so generated route197 retained. No tests/build/hooks during rebase. Earlier f9 proof remains preliminary and is not final integrated-head proof. New queue actions require real session queue rows; authored live ordinary-positive-control regression ensures private receipt IDs cannot enter those paths.

Root pinned budget semantics: known pre-run placement/current-target/disposal/pause refusals cost zero; one reservation per batch admitted to existing runner attempt. Later runtime/protected-dispatch refusal may consume that attempt. No deeper runtime hook/refund/policy rewrite. Delayed-placement regression authored first; timing source unchanged awaiting permitted red probe.

### Integrated budget and in-placement rekey regressions

On pinned d965, delayed-placement budget regression RED1 executed/1 failed because room/global budget reached0 before any runner. Source now uses remaining-only preflight; after placement, current-target/claim/Stop and authoritative pause checks, complete request assembly, one synchronous tryReserve precedes the runner attempt. Later protected/runtime refusal may consume that attempt. Two follow-up failures were fixture defects and remain recorded as failures: missing canonical AgentHomeRegistry prevented real pause identification; using the same agent in two rooms correctly prevented concurrent placement. Corrected fixture asserts actual paused-agent resolution and two distinct independently eligible agents/placement barriers. Selected budget test then GREEN1/1 across all4 scenarios.

Native rekey DURING placement regression RED2 executed/1 passed/1 failed: real runner received old ID; same-clock leave/rejoin negative already passed. Fix accepts only authoritative original-binding retirement to the current same-room/author canonical ID while exact dispatch is still held; updates held input and claim only. No fresh move redirect. Same selection then GREEN2/2; valid alias charges1, replacement scope charges0. Proof logs dor-4472-budget-* and dor-4472-rekey-* are private, with separate failed-fixture copies. Final source formatting and diff-check passed afterward. Current hashes/base are in dor-4472-d965-budget-rekey-checkpoint.json; no final exact-head/package or all-Must proof claim. New ordinary queue action regression is authored but unrun.

### Closed-origin hybrid audit and fix

M7 runtime untrusted flag proof: selected green1/1; deleting actual flag produced1 failed assertion (undefined vs true); source hash-restored green1/1. Ordinary queue/action isolation selected test initially used the wrong absent-cancel return expectation; actual API returns undefined, not false. After correcting fixture contract, green1/1 with a live ordinary steering positive control. No production queue change was needed.

Origin audit found facts.launchOrigin ignored by the new seat path. Real bridge adoption can retain relay-binding or pre-origin null metadata, while person Direct rooms legitimately have interactive/session-relay origins. Added22 tests using real describeSessionFor, runtime metadata, roomSessionPlace and actual BridgeSessionAdopter (filesystem probe/model runtime only are fake). Before fix22 executed/8 passed/14 actual failures:12 disallowed hybrid origins incorrectly accepted,2 changed bridge-authority cases wrongly launched. Approved predicate now reuses ordinary origin eligibility plus room, permits relay/null only under current active bridge tuple, and captures/revalidates that tuple across placement/native rekeys. No schema growth or switch. Same focused selection green22/22. Actual metadata-free adoption is refused until ownership is recorded; positives never stub session facts. Earlier f9 or pre-amendment proof remains preliminary; final exact-head/package checks are still outstanding.

### Prerequisite merge integration — c1bd9ecc

Fresh GitHub main pinned once to c1bd9ecc9984390ca7d51d7c2311371b89092e08 after both prerequisites merged. No upstream overlap with40 owned tracked/untracked paths. Full hashed working backup manifest d26827736e42da3140c02c989ca269cebe4e7dadc7e2fa0fe6b1f25b7b510a02; planning commits rebased without hooks/tests; new planning HEAD87e3ca1f147b85212b20c65ff77de4e9d3cf0de7; all40 files restored hash-identically. Actual base journal ends196/task-approval, route197 follows unchanged. Diff-check passed.

Current shared build dry-run has a genuine compiler miss dcfbda1dbee08828: main changed schedule-notice-copy.ts and TaskHealth.recentStreak in schemas.ts since d965. The older restored Shared dist is not claimed source-equivalent. No compiler or final-current-dist test was run while load exceeded16; serial normal build with concurrency1 waits for the approved resource window. Package and final integrated proof remain outstanding.

### Security integration — edbb692c

Pinned base `edbb692ca6b52f641416a93515e6ac74e3460b5c`; planning HEAD `0c6e9c593220fb4a682a1f2a17ae0b72b9ea571f`. Full42-file hashed backup is in `.dork/flow/dor-4472-pre-edbb-rebase/manifest.json`. Restored41 nonoverlap files byte-identically. The sole source overlap was `room-trigger/aside.ts`: preserved the upstream DOR-4453 `strangerMarkForShown` context fallback and used the prepared sender carry before that fallback. All binding, untrusted-text, permission, pause and budget guards remain. Parent reviewed and approved the exact integrated patch. Actual base journal still ends at196; route197 follows without regeneration. Old-base proofs remain historical, with fresh new-base checks required.

Post-review P1 requeues still-owned post-claim busy batches at the FIFO front using pending-state CAS, preserving original deadlines and counts. Four selected cases passed after meaningful failing assertions. P2 retains terminal receipt intents after storage faults in a bounded component-owned map, closes new admission/model attempts, retries through one owned timer, and preserves explicit-stop ownership without writing after close. Five selected cases passed; an earlier global-timer fixture assertion was corrected to distinguish the room claim's legitimate presence timer from messaging-owned timers. Both independent static re-reviews were clean on the post-fix source snapshot; final base/HEAD review remains separate.

### New-base scoped verification

On pinned edbb692c, server8GB typecheck (both configurations) and DB typecheck exited0. Server lint exited0 with144 warnings, including the existing service max-lines warning at the reduced522-line count; DB lint exited0 with no warnings. The real `pnpm check:max-lines -- --update` exited0 and reduced only the chat-message-service baseline572→522. No broad `pnpm verify` or full suite was run, per the explicit targeted-only instruction. A mistaken initial controller invocation exited127 before any compiler and is retained as setup evidence, never regression proof. A brief overlap between the final ratchet seconds and the pure policy test is recorded separately; subsequent commands waited for actual process completion.

Fresh feature checks: seat39/39, origins22/22, lifecycle1/1, actual consent-gate M5 selection1/1, ordinary origin policy10/10, migration2/2, actual shutdown wiring2/2. Adjacent ordinary message-service70/70, message-store12/12 queued-actions15/15 and queued-view8/8 passed (182 executed across11 exact files/selections). Commands, exact base, source/test hashes, positive executed counts and durations are in `.dork/flow/dor-4472-final-*-run.json`; package results are in `.dork/flow/dor-4472-{serverTC,dbTC,serverLint,dbLint,maxLines}-run.json`. Final commit review and Code review remain pending; no PR/arming action is delegated to this worker.

### Directory-size hook correction

The first normal feature commit was rejected by the directory-size guard: the chat-messages directory had26 source files. Schema generation reported no changes, format passed, and affected lint passed28 tasks; no hook was bypassed. Moved the three new sending helpers into `chat-messages/sending/` and changed the service imports. The four-file comparison proves only relative path literals changed. The staged directory guard now exits0 with23 root source files. Seat39/39 and ordinary service70/70 passed again after the move; package recheck and normal commit remain gated by fresh load.

## Current-main reconciliation (2026-11-16)

Rebased the single feature onto exact main `5cb0e5368ace8304d3fbe061d6681af6aa85ae3f`. Its canvas opened-by migration occupies idx197. The exact prior `2e25d213` source, proofs and one-commit bundle are preserved privately. Resolved the journal with exact main bytes, removed only the superseded own up/snapshot/down files, and ran real Drizzle generation from the combined schema. Drizzle assigned `20261116053850_seat_chat_delivery_route` at idx198, when `1794807530114`. The fresh snapshot's prevId matches main and retains canvas_documents.opened_by_extension_id; no journal index or snapshot was edited manually. Only generated SQL's new-column SELECT values were curated to the existing chat/null legacy-copy defaults. The matching down file uses the generated timestamp and retains its latest-migration refusal.

The existing canvas down-roundtrip case first failed at its actual latest-migration refusal guard after the new migration was added. Its fixture now builds the real migration horizon through its own tag, following the existing database test pattern; real and synthetic later-migration refusal controls remain. Exact seat migration/down, canvas horizon and journal scopes pass 13/13. The room subsystem retains one BridgeStore shared with the author lookup and seat inbox; all main file-size baseline decreases and the feature's 522 baseline are preserved. The prior 2e25 head deferred local heavy validation while the host was busy. A later low-load window restored normal combined-source verification: server/spaces and DB typechecks passed, server lint passed with 144 existing warnings and no errors, and DB lint passed. Final combined-source independent review and required current-head CI remain gates.

## Historical current-main b70 reconciliation

The prior published single-feature head `8017a77efee915e1940ba9010b65fba3ab040616`, all 48 source paths, raw proofs and exact commit message/fragment are preserved privately. The current rebase targets exact main `b70c724835133ab1532faf8ad35d5661a5030d14`. The journal and canvas migration test use exact main bytes; main's FG-005 ownership leaf refactor also supersedes the introduced CLI setup prewarm, so that test is restored byte-exact to main. Main's task-permission migration198, task/Shared contracts, ownership leaf, controller and all ratchet decreases are retained, with our existing service limit522.

Real Drizzle generation from this combined schema assigned `20261116083851_seat_chat_delivery_route` at idx199, when `1794818331848`, after the actual task-permission198 snapshot. No journal index or snapshot was edited manually. Only generated rebuild SELECT values for the new columns were curated to explicit legacy `chat`/null defaults, with a comment; noncomment SQL equals the previously accepted up. The matching renamed down migration retains the latest-migration guard and truthful interruption settlement. The own positive down fixture still applies every real predecessor through its own generated tag; the unconditional synthetic-later refusal remains intact. Historical validation and timeout measurements above belong to their stated older heads and are not new b70 proof.

The first bounded recovery observation never reached project load16 and started no compute. A later fresh7.16 window admitted real generation through the genuine current b70 controller; inner load7.23 remained7.23, generation exit0 in2.06seconds. All future compute retains project16 preflight and post-slot checks plus the current repository controller policy; no guard override or forged held flag. Current combined-tree tests, dependency refresh, package checks and independent integration review are still pending.

## Historical current-main 6811 reconciliation

Published3b3, tree7cbac317, all46 source files,28 server hashes,129 proof files and feature bundle are privately backed and archived. The normal single-feature rebase is paused at detached6811bee366a871fa3312d8d6a867c983fadb8662; remote remains3b3. Its only overlap is the journal. Restored exact main journal through due-history199, removed only the three obsolete own migration artifacts, and used real Drizzle generation against that actual preceding snapshot. Drizzle assigned `20261116095731_seat_chat_delivery_route` at idx200, when `1794823051869`. Raw generation is preserved; only new-column SELECT defaults are curated. Down migration differs only in its generated timestamp references. The real down/up test now checks that main due-history values survive alongside the existing canvas protection. All28 server files remain byte-exact3b3. Validation and independent stage1/quality review are pending; no rebase continuation, commit or push is authorized before root review release.

## Current-main 1f86 reconciliation (validation pending)

Published7755 and all46 source files,28 server hashes,103 proof files, current PR comments and feature bundle are privately backed before mutation. Root approved actual main `1f86df2d1b8cc8ab51aa7aab2f3390ce36c38761` after auditing its advance beyond requested3ed: only journal overlaps our feature, and the journal still ends at wake-and-confirm200. The normal single-feature rebase is paused at detached1f86 while remote remains7755. Restored exact main journal, removed only the three backed obsolete own artifacts, and used real Drizzle generation against the actual wake-and-confirm snapshot. Drizzle assigned `20261116110632_seat_chat_delivery_route` at idx201/when1794827192742. No hand-numbered journal or snapshot. Narrow SELECT defaults and one plain explanatory comment retain the exact accepted nine real SQL chunks; installed primary Drizzle loader semantics are verified with no empty/comment-only query. Down differs only in two timestamp references. Existing meaningful due-history row down/up assertions remain; all main todo fields, notification/API contracts, safe-git/Codex protection, tests/workflows and ratchets are retained. All28 server files remain byte-exact7755. Current validation and independent stage1/quality review are pending; no continuation, commit or push before root release.
