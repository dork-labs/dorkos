# Shared browser control — incremental task list

Canonical source: [03-tasks.json](03-tasks.json). Active production contract:
[06-production-specification.md](06-production-specification.md); retained prototype provenance:
[02-specification.md](02-specification.md); semantic contract: [07-semantic-browser-contract.md](07-semantic-browser-contract.md).

Mode: incremental. Frozen design provenance: `cb8bc3b9879684e3105d0238e7730e2d7fa79cd0`,
following distinct independent journals44/45. Design freeze is not runtime/native acceptance.
Full-scope authorization persists; no fresh permission step invented. ADR amendment stays Proposed until implemented acceptance.
GPT-6.1 Sol / Medium. Parent owns tracker projection, integration, review, PR/merge and cleanup.
Task API unavailable; canonical JSON remains authoritative. No new promotions or tracker writes here.

All11 original prototype tasks retain their original scope and history. Task3.3 completed after verified PR2460 merge `9dc56fd45d81fbb3125fdc48cc7e5ee1af340b0a` at2026-10-02T02:28:00Z. All11 prototype tasks are completed; the full production parent remains open in phase4.
Full delivery retains five requirements: retained named stores, unseeded clean return, two unattended
independent browsers, canonical shared control and no Chrome macOS Dock/app-switcher/focus impact.
Native/AT/phone/tunnel/distribution/network/performance are core acceptance, not optional polish.

## Active phase4 projection (parent-owned tracker mirror)

- [x] 4.1 Establish private engine package types and validation — depends on none.
- [x] 4.2 Implement retained and clean browser lifecycle with real capture — depends on 4.1.
- [ ] 4.3 Prove exact-owned crash recovery and profile exclusion — depends on 4.2.
- [ ] 4.4 Implement serialized generation-bound engine input and reset — depends on 4.2.
- [ ] 4.5 Implement canonical capture pointer caret and bounded telemetry — depends on 4.4.
- [ ] 4.6 Prove production retained stores clean return and unattended isolation — depends on 4.3, 4.5.

## Parallel work and activation barriers

4.1 types/validation first exports no unimplemented methods;4.2 owns first complete lifecycle and actual capture.
5.1 policy primitives and6.1 shared schemas may proceed after4.1 in separate worktrees.
4.3 recovery and4.4 input can progress after4.2 with disjoint files, then4.5 capture/telemetry and4.6stores.
Later5.4/5.5 native restrictions,5.7/5.8 distinct identities and8.6/8.7 AT matrices can edit concurrently;
all Chromium probes and resource/latency windows require coordinator scheduling.

Native readiness is keyed separately: verified native can activate after complete native-target, network,
distribution and native/platform gates. Chrome-compatible remains unavailable until complete first-request
HTTP/JS/native-hint Page/popup/OOPIF/all-worker/lifetime matrix passes. No worker-hint availability
exception accepted; rejected private candidate cannot activate. Native success does not resolve user
Chrome preference or close full parent. Task9.1 records mode-specific outcomes even with Chrome blocked;
9.3 additionally depends5.8 for full closure. Doc lightweight iframe/MessagePort authority stays independent;
zero-viewer emit/replay, two-viewer exactly-one emission and navigation-revoke gates are explicit7.9.
A browser-process Doc transport requires a separate reviewed contract, not this migration.

No new XL promotion: large broker work is5.1/5.2/5.3, native protocol5.4/5.5, identity5.7/5.8,
AT/native platform8.3/8.5/8.6/8.7, semantics7.1/7.2/7.3/7.6. Each is a complete bounded PR.
Reassess actual inseparable size rather than labeling XL to aggregate already split work. Original2.1
XL/DOR-2668/DOR-2667 retained. Critical implementation path:4.1→4.2→4.4→4.5→6.3/6.4→
7.4/7.5/7.6→8.4/native/platform/performance→9.1→9.2→9.3; network and identity gates join9.1,
Chrome-compatible complete acceptance also gates9.3. Failed/unobserved receipts are never readiness.

The default-off Shared browser rollout is a new user-requested addendum pending independent review.
It adds task9.4; earlier frozen design receipts do not accept it. DOR-2671 is a later graduation
decision outside initial rollout and full-programme closure dependencies. Original task statuses
and history remain unchanged in this plan checkout; parent owns current execution projection.

## Tasks

### Task 1.1: Establish prototype contracts and evidence receipts

Status: completed · Size: medium · Priority: high · Phase: Foundation

Dependencies: none. Parallel with: none declared.

Create scripts/browser-control-prototype/ contracts and executable entry points with injected fixture/profile/artifact directories. Separate profile, running browser/context, tab, viewer and controller identities. Define action receipts with request ID, tab ID, navigation generation, viewport version, actor, epoch and outcome; frame receipts include capture sequence and viewport dimensions. Define per-gate receipts with pass/fail/unverified, subject IDs, sample count, baseline/negative-control outcomes, command, timings, artifact paths and limitations. Capture lockfile-resolved Playwright library version, Chromium revision, absolute executable path, executable SHA-256 and OS. Resolve Playwright through apps/e2e rather than silently downloading during an action. Reserve separate module ownership for fixture, manager, control, viewer and gate runners. Test receipt validation, missing executable reporting and secret-free serialization. Dependencies and shared-file ownership must permit isolated parallel writers; parent integrates changes deliberately.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 1.2: Build isolated authenticated fixture and state probes

Status: completed · Size: medium · Priority: high · Phase: Foundation

Dependencies: 1.1. Parallel with: 1.3, 1.4.

Implement fixture server on loopback with fictitious login, persistent cookie, localStorage, IndexedDB, service worker, Cache Storage and deterministic HTTP cache endpoints. Give every tab a large distinct visible marker and expose an exact mutation revision. Add login/logout/expiry, form composition events, emoji/CJK input, draggable target, wheel/touch scrolling, clipboard read/write permission cases, popup and blocked-action fixtures. Provide known console/error/network failures and navigation-specific markers. Add fixture health/reset endpoints accessible only to the experiment. Tests assert all seeded stores contain expected values, reset clears only the selected fixture identity, cache server counters distinguish cache hits, and failures/popup/navigation are observable. Never connect to the real DorkOS server or external authenticated sites.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 1.3: Implement canonical Chromium lifecycle and reservations

Status: completed · Size: large · Priority: high · Phase: Foundation

Dependencies: 1.1. Parallel with: 1.2, 1.4.

Implement manager with actual headless Chromium using Playwright, private injected profile directories and exclusive process-safe reservations. Own persistent contexts, ephemeral clean contexts, stable tab IDs, navigation generations, canonical viewport versions and shutdown independently of viewer subscriptions. Never open the same user-data directory in two processes. Detect/refuse live holders; recover stale reservations without stealing a live process. Keep named durable context available or reopenable when clean mode starts; clean contexts receive no storage seed. Track owned browser child processes for graceful shutdown and crash recovery. Provide capture/action hooks without exposing raw CDP. Test two concurrent launch requests, separate-process exclusion, absent/corrupt executable, shutdown idempotence, stale reservation and live-holder refusal. A losing open attempt must not alter profile contents. Record explicit browser-stop errors and restart identity policy.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 1.4: Implement token-bound participants and control barriers

Status: completed · Size: large · Priority: high · Phase: Foundation

Dependencies: 1.1. Parallel with: 1.2, 1.3.

Implement fixture participant identity bound to unpredictable server-issued tokens. Request bodies cannot choose another participant. Separate view access from control access; explicit handoff and human takeover increment a revocable control epoch. Serialize actions and recheck actor, tab/navigation/viewport and epoch immediately before dispatch and before every unstarted composite step. Revoke queued old-epoch operations. Already-dispatched actions cannot be undone: report in-flight barrier/abort outcome, cap barrier at 2 seconds, and expose failure instead of indefinite input blocking. Bound payloads and action durations. Loopback routes reject missing/incorrect tokens and cross-site origins. Tests use controlled barriers to prove token A cannot impersonate B, watchers cannot drive, wrong tab/navigation/viewport and revoked epoch fail closed, queued/composite remaining steps cease, and timeout leaves an explicit recoverable state.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

Coordinator independent audit: manager-owned reset/barrier releases already-dispatched mouse buttons/modifiers and cancels composition on takeover or controller disconnect before accepting new input. Test cancelled queued mouseUp/keyUp and first human action unmodified/not dragging.

### Task 2.1: Build optional streamed viewer and native input path

Status: completed · Size: xl · Priority: high · Phase: Mechanical execution

Dependencies: 1.2, 1.3, 1.4. Parallel with: none declared.

Build optional local viewer that displays actual canonical Page captures rather than loading the target URL. Show tab identity, controller, clean-mode status, connection/stale-frame/error states and explicit request/handoff/takeover controls. Preserve canonical viewport independently of viewer mount/resize; map letterboxing/scaling with viewport-version validation. Forward pointer click/drag/wheel, modifiers, text/composition, clipboard permission outcomes and touch through real viewer event handlers. Distinguish native from synthetic observations. Add accessible named keyboard-reachable chrome, visible focus and semantic page snapshot interaction experiment; record pixel-stream accessibility limits. Stream only with subscribers, use monotonic capture sequences and latest-frame backpressure bounded to one pending frame and 2 MiB per viewer; refuse oversized frames. Measure actual viewer decode/render acknowledgement with visible changed revision. Integration tests render two viewers, check exact visible marker/revision in captured pixels, reject deliberately wrong-page capture and stale coordinate input, disconnect viewers without closing work, and exercise origin/token refusals. This task is honestly xl and requires parent threshold-based promotion handling; do not downsize to avoid promotion.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 2.2: Prove profile durability isolation and unattended work

Status: completed · Size: large · Priority: high · Phase: Mechanical execution

Dependencies: 1.2, 1.3. Parallel with: 2.1.

Add deterministic runner gates: seed persistent login cookie/localStorage/IndexedDB and service-worker/Cache Storage/HTTP-cache state; verify exact values after three graceful process restarts. Record session-only cookie/state behavior separately. Start clean context and prove no seeded state or cache hits; mutate clean state, return to durable profile and prove durable values unchanged. Attempt same-profile launches concurrently in separate processes and assert exactly one holder and no losing-process profile mutation; kill manager, recover stale reservation, refuse live holder. Run exactly two independent workers in distinct contexts with unique markers, fixed known counter totals and zero viewer subscriptions; prove no cross-context state. Reopening must show exact final counters. Include baseline and negative controls removing persistence/seeding clean context/shared state so intended gates fail. Keep profile contents out of artifacts.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 2.3: Prove tab identity handoff diagnostics and stream bounds

Status: completed · Size: large · Priority: high · Phase: Mechanical execution

Dependencies: 2.1, 2.2. Parallel with: none declared.

Run two subscribed viewers against one canonical tab and assert pixel marker/action revision identities, not metadata alone. Navigate and open popup; assign distinct popup tab ID and retain original action target until explicitly switched. Attach two viewers during work, close both and require exact remaining mutations and unchanged tab identity on reopen. Run at least 100 action/handoff rounds with queued and blocked operations; zero revoked queued actions or unstarted composite steps execute. Measure acknowledgement p95 under 100 ms locally and first accepted human input with maximum 2-second barrier; report in-flight outcomes. Capture known console/error/network entries with exact tab/navigation identity; fill bounded telemetry buffers and assert explicit loss counts. Measure 100 input-to-render samples at 1280x720: p95 under 250 ms local and under 600 ms with injected 150 ms RTT, reporting actual sample count, bandwidth, encoding cost and drops. Stall one viewer 10 seconds; assert other viewer remains within latency target and queue stays one pending frame/2 MiB. Run wrong-page, revoked-epoch, unbounded-queue and missing-render-ack negative controls. RTT injection is not actual tunnel evidence.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 2.4: Show the native text caret and canonical mouse pointer

Status: completed · Size: large · Priority: high · Phase: Mechanical execution

Dependencies: 1.3, 2.1. Parallel with: none declared.

Address explicit user feedback from the attended fixture demo: preserve the actual native text caret in captures, and show a visible mouse pointer reflecting accepted canonical human or agent input. Bind pointer position to tab, navigation, viewport and current control lifetime; clear stale/reset/disconnected positions. Scale coordinates correctly in the viewer. Keep view access separate from control, and never fabricate a text caret. Add red-first native caret pixels, pointer scaling and stale-lifetime regressions. Keep wrong-page pixel negative controls and frame queue bounds. Independently review changes before mechanical latency resampling; preserve the original RTT failure.

### Task 3.1: Observe native input accessibility and macOS presence

Status: completed · Size: large · Priority: high · Phase: Observed surfaces and refinement

Dependencies: 2.1. Parallel with: 2.3, 3.2.

Execute real viewer-event input matrix for click/drag/wheel/chords/emoji/CJK composition/paste/copy/touch and stale viewport refusal, asserting exact fixture outputs. Separate real native IME from synthetic composition, clipboard success from permission-denied recovery, physical phone touch from phone-sized desktop emulation. Capture accessible keyboard/focus/name behavior and inspect semantic snapshot; prove a viable semantic interaction path or mark production accessibility readiness failed. On exact pinned Chromium executable observe Dock/app-switcher inventory and foreground app before launch, during capture/input and after crash/recovery; use visible test application positive control to prove observer detects presence. Assert zero managed Chromium icons or focus steals in normal headless use. Record blocked/unavailable native, physical phone or macOS observation as unverified, with concrete required next proof. Use only fixture-only authorized tunnel route for actual tunnel observation; otherwise keep tunnel gate unverified and never infer it from synthetic RTT. Do not substitute operator credentials or personal accounts to make a gate pass.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 3.2: Measure installation recovery and resource behavior

Status: completed · Size: medium · Priority: high · Phase: Observed surfaces and refinement

Dependencies: 1.3, 2.1. Parallel with: 2.3, 3.1.

Record explicit cold executable installation/start procedure, absent executable failure and no action-triggered silent downloads. Force renderer and browser process death separately, then relaunch and check persistent cookie/localStorage/IndexedDB/cache integrity; report any lost in-flight actions rather than silently replaying them. Verify manager-crash recovery reservation handling and graceful shutdown with owned process inventory proving no orphan browser child remains. Measure idle/active browser CPU/RSS separately from Node/viewer and stream bandwidth for two browsers/two viewers, recording host baseline/load, sample duration/count and executable receipt. Derive candidate production concurrency/resource caps from measurements without inventing success thresholds. Include live child positive control for orphan observer and missing-executable negative control. Any unavailable cold install or process metrics become unverified receipts.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

### Task 3.3: Consolidate reproducible evidence and adversarial review

Status: completed · Size: medium · Priority: high · Phase: Observed surfaces and refinement

Dependencies: 2.3, 3.1, 3.2, 2.4. Parallel with: none declared.

Consolidate reproducible commands and per-gate receipts into specs/shared-browser-control/05-prototype-evidence.md without committing profile data, tokens, cookies or secret-bearing logs. Include exact executable/library/OS receipts, artifact locations, sample counts, baseline and mutation/negative-control outcomes, measured distributions, pass/fail/unverified and limitations for every gate. Require independent adversarial reviewer separate from implementers to review prototype code and evidence under REVIEW.md, verify incorrect implementations fail the intended tests, and re-review changed scope after fixes. Run targeted meaningful tests and required repository gates; avoid paid inference. Record unresolved native IME/phone/accessibility/tunnel/macOS/distribution blockers explicitly. Do not close the full production parent or claim production complete. Parent owns integration, tracker writes, every PR review/merge and cleanup.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

Completion evidence: [PR2460](https://github.com/dork-labs/dorkos/pull/2460), reviewed head `041afeaaaf3eb8960b77018ffafa42fb51f878db`, merge `9dc56fd45d81fbb3125fdc48cc7e5ee1af340b0a` at2026-10-02T02:28:00Z. This closes the bounded prototype evidence task only; native and Chrome-compatible production readiness and the full parent remain open.

### Task 4.1: Establish private engine package types and validation

Status: completed · Size: medium · Priority: high · Phase: Private engine foundation

Dependencies: none. Parallel with: none declared.

Create private @dorkos/browser package with browser-safe command/result/error types, runtime descriptor and strict validation for absolute injected dataDir, bounded IDs/parameters and counters. Accept injected clocks, process observers and narrow policy callbacks; no home resolution or app/auth/room/runtime-SDK imports. Export only complete types/validators in this PR, not a constructor/factory with unimplemented lifecycle methods or a pretend launch success. No raw Page/CDP/selector/profile-path or arbitrary evaluation in consumer API. Validate package exports, dependency boundaries, frontend exclusion, counter exhaustion and invalid configuration. Actual fixture launch/capture belongs the first complete lifecycle slice, task4.2, not this package skeleton. Phase4 may proceed while prototype task3.3 shipping remains in_progress.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

Establish one public pinned Playwright library boundary with runtime-relative assets represented in its descriptor. Package types do not select a private patched dependency or pretend install readiness; CLI/desktop shipping verification must resolve the actual production library, not a development-only monorepo installation.

Completion evidence: [PR2463](https://github.com/dork-labs/dorkos/pull/2463), reviewed head `4bc298b79a08db6856e6dc253e6baa28e9cd4d09`, merge `71e3e40bec60211572e520e5b8b620cd79409259` at2026-10-02T03:52:00Z. All43 reviewed branch-owned blobs match the actual merge. This closes the private contracts task only; the full parent and native/Chrome-compatible readiness remain open.

### Task 4.2: Implement retained and clean browser lifecycle with real capture

Status: completed · Size: large · Priority: high · Phase: Private engine foundation

Dependencies: 4.1. Parallel with: none declared.

Worker: `/root/prototype_manager`; isolated source checkout: `/Users/doriancollier/.codex/worktrees/browser-engine-lifecycle/dorkos`. Private fixture lifecycle merged in PR #2465 at `359784d7c08af054291d2598bd416e4ada19895b`; both whole reviews passed exact `36963e4a2e9f07d9fce7f67c617744ba55645eca` and all 34 owned merged blobs match. Original failures and corrected history are preserved. Only task 4.2 is completed; full production acceptance remains open.

Implement first complete private engine constructor/open/close/tab-list/capture slice using reviewed Playwright and explicit executable descriptor; never resolve/download implicitly. Persistent named profiles and unseeded separate clean browser receive fresh browser/tab IDs, fixed canonical viewport and truthful stopped/uncertain outcomes. Inject roots/process observation; register cleanup before launch and bound IPC/acquisition/teardown. Reserve profiles atomically with manager/Chromium PID-birth and launch phase; no losing attempt modifies seeded profile. Capture actual named fixture Page JPEG/receipt through narrow API, keeping raw engine objects private. Real tests cover open/capture/clean close/return, absent/corrupt executable, concurrent same-profile open in independent processes, zero-viewer browser lifetime and idempotent shutdown. This is fixture-only lifecycle capability, not permission for public egress or mode activation.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 4.3: Prove exact-owned crash recovery and profile exclusion

Status: pending · Size: large · Priority: high · Phase: Private engine foundation

Dependencies: 4.2. Parallel with: 4.4.

Extend engine lifecycle with attributable descendant PID/birth recording before parent death, renderer/browser/manager distinct failures and startup reconciliation. A dead manager or absent native lock cannot authorize reuse while recorded Chromium is live; unknown observer/PID reuse/failed launch cleanup fail closed and quarantine profile for explicit repair. Shut down only exact matching recorded identities, never process groups or operator browsers; attempt all cleanup steps and preserve original failure. Actual crash fixtures prove recognized live-root refusal without profile mutation, original/recovery descendant disappearance, stopped old IDs, fresh restart relationship and no interrupted side-effect replay. Root-only observer/PID-reuse/missing observation mutants must fail their intended gates; incomplete inventory is UNVERIFIED, never invented allGone.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 4.4: Implement serialized generation-bound engine input and reset

Status: pending · Size: large · Priority: high · Phase: Private engine foundation

Dependencies: 4.2. Parallel with: 4.3.

Implement bounded action dispatch with per-tab serialization, at most64 pending operations,16KiB payload/2048-byte text, at most16 composite steps and2-second execution/reset barrier. Recheck live browser/tab/navigation/viewport/input-generation and server validation hook before each unstarted step. Distinguish rejected queued, aborted composite and uncertain started effects; never undo/retry by claim. Reset held mouse buttons/modifiers/composition/drag before successor input, invalidate late dispatch restoration and tombstone every tab of a stopped browser including unseen tabs. Actual fixture tests prove exact wrong-tab/nav/viewport rejection, cancelled queued releases cannot leave dragging/Shift/composition, blocked operation bounded and new input unmodified; keep raw CDP private.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 4.5: Implement canonical capture pointer caret and bounded telemetry

Status: pending · Size: large · Priority: high · Phase: Private engine foundation

Dependencies: 4.4. Parallel with: none declared.

Complete capture/tab-popup hooks with actual canonical pixels, native caret capture and manager-observed pointer only after successful mouseMove/click dispatch. Bind pointer to initiating tab/nav/viewport, snapshot before capture, null on intervening move/reset/navigation/resize/close and refuse stale late restoration; no fabricated caret or touch-derived mouse. Provide bounded console/error/network diagnostics by tab/navigation/request, explicit drops/truncation and secret-safe summaries, with no automatic disclosure. Actual fixture tests check caret focus/blur/blink, pointer reset/midcapture races, popup distinct stable tab and independent wrong-Page byte marker negative; telemetry overflow has exact loss counts. Presentation/authorization remain later slices.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 4.6: Prove production retained stores clean return and unattended isolation

Status: pending · Size: large · Priority: high · Phase: Private engine foundation

Dependencies: 4.3, 4.5. Parallel with: none declared.

Run three actual clean restarts with exact cookie/localStorage/IndexedDB/SW/Cache Storage/HTTP cache
fixture values; session/expired-cookie behavior explicit. Two private profiles complete 100 exact
mutations each with zero viewers; reattach same live Page. Run profile-only persistence baseline with exact cookie/localStorage/IndexedDB/service-worker/Cache Storage/HTTP-cache values after three real clean restarts. Record session-cookie/expiry separately and do not promise lossless recent writes on forced crash. Separate clean mode starts empty, mutates only itself and removes private clean data after exact process cleanup. Two agents in separate profiles each complete100 exact fixture mutations with zero subscribers; later engine reattachment identifies same live tab/current counter. Persistence/seeding/shared-context mutants prove exact named failures, without exporting profile state. Server-level handoff receipts belong task8.4.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.1: Implement canonical destination parser DNS and grant policy

Status: completed · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 4.1. Parallel with: 6.1.

Destination policy primitives merged in PR #2467 at 4f117573928cc737c74d9f186de0ff320ebd2004 on 2026-10-02T10:09:22Z. Both distinct independent whole-change reviews passed exact pushed head 57ea622c06df54a6adeccb1e559c87cee23e089d; all 25 owned merged blobs match that head. Original source failures and corrected history remain preserved. This completes only this private foundation slice; forwarding, runtime integration, public activation and full DOR-2667 delivery remain open.

Historical pre-merge checkpoint: Worker: `/root/prototype_manager`; isolated source checkout: `/Users/doriancollier/.codex/worktrees/browser-egress-policy/dorkos`. Frozen source `b65503dd3c968fb6546c711d924105451ac33c40` is integrated for fresh parent verification and whole-change review. No actual merge, broker/runtime activation or full task completion is claimed.

Implement services/browser/egress policy primitives without opening production browser access: canonicalize authority once, reject userinfo/ambiguous hosts/Host mismatch/forbidden schemes and ports. Public HTTP(S)/WS(S) initially ports80/443; deny all nonglobal/mapped-IPv6/private/metadata/host-interface destinations and configured app/admin authorities/aliases before any allow grant. Bounded resolver/CNAME validates every A/AAAA answer, rejects mixed sets and yields pinned numeric endpoints with policy revision. Local-dev grant is owner/workspace/browser-bound exact literal scheme/host/port with expiry; cannot override admin deny. Test rebind/mixed/CNAME/mapped-IP/adjacent-port/alias cases and allowed shared-CDN hostname independent of denied app authority, using injected resolver and socket fixtures.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.2: Implement authenticated broker forwarding and live revocation

Status: pending · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 5.1, 4.2. Parallel with: none declared.

Build per-browser generation/owner/policy-bound broker lease and bounded HTTP absolute-form/CONNECT/WS forwarding using canonical policy primitives. Connect pinned numeric address without a second DNS lookup, validate peer, strip proxy credentials from upstream and bind live sockets/tunnels to lease/revision. Configure no DIRECT/PAC/system/WPAD/implicit-local bypass; subtract loopback bypass. Keep TLS browser-to-site with certificate checks, no interception CA or ignoreHTTPSErrors. Revocation/expiry/admin-alias change closes existing connections/pools; dead broker never retries direct. Fake endpoint tests verify zero forbidden connects, permitted public/exact-local positives, no credential disclosure, byte/time limits and live WS/tunnel closure; this does not claim all-protocol OS isolation.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.3: Prove browser target egress and shared-authority tunnel isolation

Status: pending · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 5.2, 4.5. Parallel with: none declared.

Run exact-runtime broker acceptance for navigation/redirect/image/script/iframe/OOPIF/popup/dedicated/shared/service-worker install/fetch/background requests after detach and WS/WSS. Workers stay enabled and HTTP cache remains testable; Playwright route is not the firewall. Exercise fake admin/local/private/metadata endpoints, expired/revoked leases, dead broker no DIRECT fallback and an allowed relay fixture whose denied admin target remains untouched/unauthenticated. Shared-IP/shared-SAN H2 fixture warms allowed authority then attempts denied app authority: require separately denied CONNECT and zero app requests while unrelated allowed shared-CDN host works. Include cross-origin fetch/redirect/Alt-Svc and open-tunnel revocation. Bypass-enabled mutant must reach intended fake endpoint; current source comments alone cannot pass runtime proof.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.4: Prove supported WebRTC restrictions without disabling sandbox

Status: pending · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 5.3. Parallel with: 5.5.

Choose supported native pre-execution runtime controls for WebRTC ICE/STUN/TURN/data-channel page networking; no JS API shim, denied camera permission or guessed flag as proof. On exact executable/platform, exercised page APIs attempt fake loopback/private/admin endpoints while endpoint connects/packets are observed; permitted broker HTTP(S)/WS(S) positives run too. Cover target/lifetime initialization before Page/worker execution and retain native sandbox. Removed-restriction mutant must expose intended endpoint traffic. Unavailable API/packet observation is UNVERIFIED; bypass that cannot be disabled/routed with supported controls returns NETWORK_POLICY_UNSUPPORTED and refuses that configuration, not a passing skip. No privileged firewall/entitlement changes or claim to contain browser compromise.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.5: Prove WebTransport QUIC and unsupported scheme policy

Status: pending · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 5.3. Parallel with: 5.4.

Select supported native pre-execution restrictions for WebTransport and QUIC/HTTP3 and explicit supported URL-scheme policy on exact executable/platform. Observe exercised page attempts against fake forbidden endpoints/packets, permitted HTTP(S)/WS(S) positives and dead broker no-direct negative. Reject file/external/custom schemes; app-owned about:blank and same-origin blob/data render without network authority but fetches use broker. Removed/bypassed restriction must produce its specific forbidden endpoint observation; raw-socket helper is not page evidence. Unsupported/unobserved restriction yields NETWORK_POLICY_UNSUPPORTED and mode remains unavailable. Native sandbox stays enabled, no privileged OS firewall changes or all-host-egress containment claims.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.6: Implement explicit pinned runtime installation and status

Status: pending · Size: medium · Priority: high · Phase: Runtime network and identity gates

Dependencies: 4.2. Parallel with: 5.1.

Implement `dorkos browser install/status` using pinned official Playwright full Chromium
`--no-shell --no-remove`, private versioned cache and atomic verified manifest publication.
No implicit action-time download/update, system packages or unrelated cache removal. Verify
fresh-process executable hash/version/platform; test absent executable, concurrent/interrupted
install, stale/mismatched receipt and repair. Status distinguishes installed from mode/network/
platform acceptance; installing a rejected candidate cannot make it usable in production. Keep acceptance records separately keyed executable hash/platform/policy/identity mode; installed does not mean ready. Native fallback is never silent.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.7: Prove unchanged explicit native identity across all lifetimes

Status: pending · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 4.3, 5.6. Parallel with: 5.8.

Collect native baseline from exact unmodified executable/hash/platform: HTTP UA and appVersion/navigator.userAgent/platform, low entropy brands/mobile/platform and supported high entropy full-version-list/platform-version/architecture/bitness/model/wow64. Native mode performs no UA override and explicitly retains headless token if native. Trusted HTTPS fixtures record first request before Accept-CH and separately negotiated subsequent requests per origin; compare actual native conventions, not host-derived MacIntel/CPU rewrites. Observe Page, popup first request, OOPIF, same/cross-origin navigation/reload, dedicated/shared/service workers, nested/background lifetimes, clean and persistent reopen/restart. Unsupported required fields stay UNVERIFIED with causes; no worker-hint availability exception is accepted. Native readiness record may eventually activate only after its own complete network/distribution/native-platform gates, irrespective of failed Chrome candidate.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 5.8: Prove supported Chrome-compatible identity before mode availability

Status: pending · Size: large · Priority: high · Phase: Runtime network and identity gates

Dependencies: 4.3, 5.6. Parallel with: 5.7.

Collect exact native executable baseline; expose explicit native mode. Chrome-compatible
policy normalizes only native HeadlessChrome token in legacy UA/appVersion, preserving native
Client Hints, brands/GREASE, platform reduction and actual version. Apply supported configuration
before first target request; never patch JS getters, response headers or fake Google Chrome
brands. Prove initial and negotiated HTTPS requests/JS metadata across Page/navigation/reload/
popup/OOPIF/dedicated/shared/service workers/background activity, persistent/clean contexts
and separately negotiated origins. Missed first request/worker, UA-only metadata loss, invented
architecture/version/brand mutants fail specifically. Keep Chrome-compatible mode unavailable
until the entire matrix passes; reject private candidates without production activation. This complete target-matrix PR is large after separating native task5.7; partial coverage cannot become a ready default. Retain rejected candidate shared-worker JS/service-worker first-request failures and missed-initialization popup mutant; private copied-package research cannot replace installed dependency. Research264a worker-hint availability proposal is pending/UNVERIFIED and not an accepted exception. Required metadata absence cannot certify a context by assuming workers share Page hints. Keep mode unavailable until complete matrix passes; unchanged separately verified native is explicit, never substituted silently. Full parent remains open while requested Chrome-compatible default unresolved.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.1: Add strict browser and semantic shared schemas

Status: completed · Size: medium · Priority: high · Phase: Shared contracts and server authority

Dependencies: 4.1. Parallel with: 5.1.

Strict browser and semantic shared schemas merged in PR #2467 at 4f117573928cc737c74d9f186de0ff320ebd2004 on 2026-10-02T10:09:22Z. Both distinct independent whole-change reviews passed exact pushed head 57ea622c06df54a6adeccb1e559c87cee23e089d; all 25 owned merged blobs match that head. Original source failures and corrected history remain preserved. This completes only this private foundation slice; forwarding, runtime integration, public activation and full DOR-2667 delivery remain open.

Historical pre-merge checkpoint: Worker: `/root/prototype_contracts`; isolated source checkout: `/Users/doriancollier/.codex/worktrees/browser-shared-contracts/dorkos`. Frozen source `92d9068f34cca6c5775dab1da344d3aac37bf798` is integrated for fresh parent verification and whole-change review. No actual merge, broker/runtime activation or full task completion is claimed.

Add exported browser-safe strict Zod schemas for lifecycle, grants, generations, actions,
frames/real render receipts, errors, diagnostics and exact version-1 semantic/event/continuation
shapes. Extend Transport and typed mocks; use managed `browser.*` namespace rather than
changing iframe ui/devtools verbs. Acceptance: unknown keys/enum/bounds/version and forged
actor fields rejected; no engine objects or executable payloads in public schemas; strict
correlation/stream watermark and secret noecho schemas match the approved contract. Define all closed role/key/event/reason enums, conditional event payloads, request edit stream ID and continuation event watermark with strict unknown-key rejection; identity counters safe integers, opaque IDs never authority. No engine stub methods added to Transport in this types PR; typed operation implementation belongs task6.8.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.2: Persist owner-qualified registry migration and reconciliation

Status: pending · Size: medium · Priority: high · Phase: Shared contracts and server authority

Dependencies: 4.3, 6.1. Parallel with: none declared.

Add metadata migration for profile owner/label/mode/version and session/room attachments.
Server browser domain derives liveness from engine, reconciles stopped/uncertain objects and
never silently rebinds old browser/tab IDs. Durable metadata excludes page/profile contents.
Attachment possession does not grant access. Acceptance: owner-qualified isolation, restart
reconciliation, clean/profile independence and explicit detach vs stop behavior; update domain
census/AGENTS when domain is introduced, not by weakening checks.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.3: Implement explicit grants scope and controller revocation

Status: pending · Size: large · Priority: high · Phase: Shared contracts and server authority

Dependencies: 4.4, 6.2. Parallel with: none declared.

Trusted auth/capabilities supply actor and owner. Separate view/control/secret-input/diagnostics/
artifact/profile permissions; check exact grant revision/expiry/attachment on requests, delivery
and each unstarted step. Human takeover invalidates old work immediately; bounded reset precedes
new input. Membership removal/revocation/disconnect closes streams and invalidates continuations.
Acceptance: outsider/room-only/spoofed actor, view-only input, stale generations/same-actor epochs,
secret grant revoked between select-all/insertion, held-state reset and barrier timeout negatives.
Unknown vs inaccessible IDs remain indistinguishable; sharing disclosure is explicit. Add thin validated routes only for implemented operations under /api/browser profiles/instances/tabs; stopped/uncertain states accurate. Update service census/domain instructions when domain introduced. Session/room membership necessary but insufficient; view disclosure private content and signed-in action scope.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.4: Implement authenticated pixel metadata streams and actual render ACK

Status: pending · Size: large · Priority: high · Phase: Shared contracts and server authority

Dependencies: 4.5, 6.3. Parallel with: none declared.

Implement scoped short-lived viewer tickets/origin/CSRF guards and lossy non-durable pixel frames;
one pending <=2MiB per viewer, real decode/draw acknowledgment, prior-receipt/next-frame protocol
and legacy compatibility only where intentionally supported. Metadata streams have identities,
sequences and resync; no page data in durable room/session replay. Acceptance: two simultaneous
changed-pixel viewers, wrong/replayed/missing receipts, lost-response reconnect, stale old-tab/
control state, zero-viewer continued work and stalled viewer cannot delay peers or engine input. Add server-side monotonic state and stale-control/nav/viewport checks. Tickets actor/tab/grant/origin bound, never durable credentials in URLs; close on grant expiry/revocation. Metadata replay excludes pixels/page data. Lost subscription does not revoke controller unless explicit lifecycle rule; action response lost never auto replay.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.5: Implement bounded authorized diagnostics with exact redaction loss

Status: pending · Size: medium · Priority: high · Phase: Shared contracts and server authority

Dependencies: 4.5, 6.3. Parallel with: none declared.

Expose read-only diagnostics only under separate owner-qualified grant. Bind sanitized console/error/network summaries to tab/navigation/request, enforce bounded retention and byte limits, count exact drops/truncations and use typed safe errors. Recheck grant before read/delivery and close revoked subscriptions; no cookies/URLs/page strings/typed secret/protocol payload in durable session/room stream/logs/crash analytics. Test overflow exact counts, wrong tab/nav/outsider/room-only access, revoke during serialization and secret sentinel removal. A sanitizer mutant must reveal named sentinel; unrelated assertion is not detection. Diagnostic receipt stores safe provenance/counts, not secret dumps.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.6: Implement authorized staged uploads downloads and file confinement

Status: pending · Size: large · Priority: high · Phase: Shared contracts and server authority

Dependencies: 5.2, 6.3. Parallel with: none declared.

Add explicit artifact/upload/download permissions and private owner/browser-specific staging roots; default downloads denied. Accept server artifact IDs only, not absolute paths. Normalize/realpath-confine and open without following changed symlink; bidirectional profile/artifact separation, exclusive private filenames, size/type/time quotas and partial cleanup. Reject file/native-picker arbitrary paths and never export cookie/profile/cache/runtime/reservation files. Publish artifact ID only after completion/ownership validation; room attachment alone no access. Actual fake upload/download positive plus traversal/symlink-swap/filename-overwrite/outsider/room-only/private-profile/oversize/partial negatives prove intended boundary; unknown IDs inaccessible.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.7: Register scoped managed capability tools for every runtime

Status: pending · Size: large · Priority: high · Phase: Shared contracts and server authority

Dependencies: 6.4, 6.5, 6.6. Parallel with: none declared.

Register browser.* grants and managed_browser_* tools in authenticated capability dispatcher for real implemented lifecycle/tab/navigation/actions/control/diagnostics/artifacts. Trusted context resolves owner/actor/attachment, body cannot impersonate. Keep existing iframe ui/devtools semantics until migration; no raw Page/CDP/eval/selector/protocol/path capability. Shared runtime conformance tests exercise spoofed actor, outsider and view-only refusal, revoked queued work, exact tab/nav/viewport/epoch and uncertain side effect without replay. Do not replace managed MCP preset yet; gated internal fixture capability surface can land without public activation, and all runtime callers use same scoped policy.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 6.8: Implement complete Browser Transport and typed mocks

Status: pending · Size: medium · Priority: high · Phase: Shared contracts and server authority

Dependencies: 6.4, 6.5, 6.6. Parallel with: none declared.

Extend Transport for implemented profile/instance/tab lifecycle, grants/control/actions/view attachment/diagnostics/artifact and semantic read/subscribe contracts; HttpTransport browser-methods handles typed failure/resync consistently, mock transports match. Do not export methods returning pretend successes or permanent NOT_IMPLEMENTED placeholders; use scoped complete operations available from server. Validate exact request/response shapes, origin/auth/CSRF, no frontend engine import, inaccessible-object equivalence, revoked/out-of-order stream response and abort handling. Semantic operations can be added as complete methods when task7.3 lands, without temporarily promising unimplemented service behavior.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.1: Extract exact sanitized AX trees and private per-frame bindings

Status: pending · Size: large · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 4.5, 6.1. Parallel with: none declared.

Implement target-scoped AX extraction/frame/OOPIF registry, private DOM object and fingerprint
bindings, versioned fresh node refs/actor leases, dirty observers and bounded stable read/retry.
Return typed sanitized data, never copied HTML/URLs/attributes or executable app-origin content.
Native password/file/unknown-sensitive controls redact before hash/serialize. Keep extraction behind a private supervisor boundary; task7.2 independently enforces process allocation/admission ceilings before activation.
Acceptance: identical-node replacement, frame/DOM races, malicious AX/markup/password sentinels,
wide/deep/shadow output and truncated read-only behavior. Hostile allocation and web-server responsiveness acceptance remain blocked on complete task7.2; public output slicing alone is not memory proof. Enforce256KiB/2000nodes/depth32/32frames, role/name512/description1024/text2048-byte bounds; one extraction/tab5 starts/sec1sec deadline+one retry, refs/actor leases<=2sec and8 leases/tab. Truncated output read-only, connected DOM identity/frame generation/fingerprint not backendID/name/position authority. No unbounded full DOM, copied remote HTML or engine object export.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.2: Enforce supervised semantic allocation and hostile-page failure

Status: pending · Size: large · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.1, 6.3. Parallel with: none declared.

Implement enforced working-memory/admission/process isolation for private semantic extraction, bounded IPC and cleanup of AX/DOM/Runtime objects. Wide shallow CDP reply can allocate before slicing; post-parse output bounds are not memory proof. Test actual hostile wide/deep/shadow/subframe candidates in separately supervised engine, exhaustion/unavailable path and web server/input/peer viewers remain responsive; budgets release target sessions. Missing enforceable isolation fails semantic readiness instead of claiming preallocation bound. Test one-pending extraction, deadline/retry cap, oversized nonsecret value read-only and secret redaction before hash/retention; failure cleanup preserves primary while every resource attempted.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.3: Dispatch semantic focus edit and write-only secret continuation

Status: pending · Size: large · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.2, 6.3, 6.4. Parallel with: none declared.

Map approved focus/activation/toggle/plain-text/secret/key actions through canonical serialized
control queue. Revalidate DOM object/frame/tree/focus/grant/epoch/input generation at every step;
no name/selector fallback or script setters. Secret operation is explicit write-only/noecho with
per-step grant. One in-flight edit suspends old refs; exact actor-stream/request correlation and
receipt watermark permit only same-field expected edit continuation with fresh lease/revision.
Acceptance: successive characters reach exact canonical field with local editor focus retained;
both notification orders, held later refreshes, unrelated dirty/focus/replacement/reset/deadline/
revocation stop continuation, secret buffer clears/noecho, lost response never replays effects. Native plain text input/textarea only; unsupported richtext/widget read-only. Exact focus DOM chain, canonical Enter/Space/enum key/manager text, no setter/fabricated event; expected operation focus/selection transitions privately validated each step. Secret native password additionally exact secretInput grant, raw-key/pixel lane same permission. Stream metadata128events/5min, one pending/viewer8max excludes typed/page contents; uncorrelated coalesced dirtiness wins. API tests no arbitrary selectors/ref fallback.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.4: Implement FSD Browser entity and optional canonical pixel viewer

Status: pending · Size: medium · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 6.8. Parallel with: 7.1.

Build FSD entity/browser state/query/subscriptions and feature/browser viewer through barrels;
Canvas composes presentation, no sibling internal imports or engine in frontend. Scale fixed
canonical viewport without resizing Page; close/detach/reopen shows same live tab and does not
launch/stop it. Acceptance: two actual changed-pixel viewers, wrong-page-byte oracle, late old state,
read-only view and lost subscription recovery; no local-history navigation of shared Page. HttpTransport and mocks are complete before consumption; browser entity owns query keys/server-state, features own presentation and barrel exports. Render loss/stale/refused/view-only with accessible named chrome; no viewer requirement for browser work.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.5: Forward real viewer events and render canonical pointer caret

Status: pending · Size: large · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.4, 6.3. Parallel with: none declared.

Wire click/drag/wheel/keyboard/modifier/text/composition/touch/clipboard permission states through
shared control identities. Overlay only capture-bound canonical pointer, clear on stale/reset/
navigation/viewport/controller mismatch, preserve actual native caret pixels. Distinguish tap/wheel
emulation from native touch scrolling. Acceptance: actual viewer event handlers, scaled pointer,
focus/blur, lost pointer capture cancellation and first new-controller unmodified input. Native IME,
clipboard, phone and AT claims remain gated G2; use fixture doubles without operator clipboard reads. At actual decode/draw/twoRAF boundary send exact prior receipt with next frame; local resize scales presentation only. Tests same exact tab native caret and pointer visibility independent image oracle, wrong-Page replacement bytes under expected receipt and stale lifetime hide; native gate remains distinct.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.6: Render semantic outline editor with bounded own-edit focus

Status: pending · Size: large · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.3, 7.4. Parallel with: none declared.

Render typed escaped roles/names/state with independent local tree selection and explicit canonical
focus action; never import remote DOM/ARIA ownership into app origin. Implement pending/refused/
freshness states, bounded own-edit focus continuation and exact stream order, secret native password
buffer clear-on-send, no automatic replay/retarget. Polite controlled announcements, no remote alert
priority/focus theft. Acceptance: keyboard fixture exact Page effects, local outline no remote focus,
replacement and out-of-order events fail closed. Real AT observations remain G2, not DOM-only parity. Use exact semantic eventStreamId/requestId/coveredEventSequence; pending first order retains focus but suspended refs, receipt first waits ordered watermark. One in-flight commit<=2sec; future char explicit fresh lease, no buffered autoreplay. All unrelated DOM/focus/replacement/epoch/nav/frame/grant/gap/deadline cancels and clears. Owned polite statuses, no remote live-region priority; secret echo/value/length forbidden, local buffer clears on send.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.7: Attach canonical browsers to session Canvas independently of Doc

Status: pending · Size: medium · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.4, 6.2, 6.3. Parallel with: none declared.

Add distinct managed-browser reference schema with owner/author/scope limits and durable metadata
replay. Render optional viewer, not iframe URL clone; attachment never grants browser access.
Detach removes presentation only; explicit stop remains separate. Keep ui preview and Doc iframe
MessagePort authority unchanged. Acceptance: zero-viewer engine work, one canonical Page with two
views, detach/reopen identity and navigation controlled only by current controller. Any proposed
browser-process Doc peer transport is deferred behind a separate contract plus zero-viewer replay,
two-viewer no-duplicate emit and navigation-revoke gates, never inferred from this attachment.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.8: Add explicitly granted Room browser attachments

Status: pending · Size: medium · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.7, 6.3, 7.5. Parallel with: none declared.

Use existing room Canvas author/replay/limits with explicit owner-issued browser grant/disclosure.
Room membership alone is insufficient; removing member/attachment or expiring grant invalidates
streams/actions without stopping independently owned browser. Acceptance: authorized people/agent
two-viewer actual pixels, outsider and room-only refusal, queued/composite cancellation and metadata
replay cannot restore authority or copy account state. Doc peer namespace remains independent.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 7.9: Prove lightweight Doc authority and viewer independence

Status: pending · Size: medium · Priority: high · Phase: Canonical presentation and semantic interaction

Dependencies: 7.7, 7.8. Parallel with: none declared.

Add regression tests preserving instrumented iframe preview and parent/MessagePort authority independently from managed viewers; lightweight documents need no Chromium. Managed pixel/tab IDs cannot mint Doc SDK authority, cross namespace or gain app-origin credentials. Existing Doc peer behavior must emit/downstream replay with zero viewers, emit exactly once with two viewers and revoke old-page authority after navigation. Exercise delayed old frame/port token, duplicated subscription and absent viewer positives/negatives. Do not introduce browser-process Doc transport in this PR: that requires separate reviewed contract and same zero-viewer/no-duplicate/navigation-revoke proof before adoption; keep prior iframe decision effective.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.1: Package CLI source engine and explicit runtime install path

Status: pending · Size: medium · Priority: high · Phase: Distribution and real acceptance

Dependencies: 5.6, 4.3. Parallel with: 7.4.

Resolve private engine source/runtime manifest explicitly in CLI bundle; new command/status/install
surfaces retain existing source-resolving build conventions. Test fresh cold install, absent runtime
no-download, real path/alias invocation, cache relocation and interrupted upgrade rollback. Include
provenance/licenses and exact runtime receipt. Packaging success cannot activate unaccepted identity/
network configurations or imply native/visibility/platform acceptance. Test source-vintage pinned engine, CLI entrypoint symlink/macOS var aliases and fresh-process manifest publish. No action auto download, --with-deps or unrelated cache cleanup; native/Chrome availability displayed per mode not installation alone.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

Follow existing CLI @dorkos source/root-subpath discovery instead of a second alias table or stale dist. Determine whether the pinned public library must be externalized to retain runtime-relative assets; any external is an actual shipped CLI production dependency. Verify cold package with no dev node_modules/cache fallback and source/hash receipts; do not silently bundle away required package assets.

### Task 8.2: Package desktop single-copy real runtime and upgrade rollback

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 8.1. Parallel with: none declared.

Use desktop server and same manifest/acceptance policy; single-copy unpacked executable assets,
no execution from virtual asar paths or duplicated unreachable resources. Verify installed package
runtime paths, hash/version, startup/shutdown and update rollback on supported platform. Retain
Windows alpha label until real installation gate passes; macOS Dock/focus observation belongs G2,
not a packaging assertion. No new privileged host installation side effects. Check emitted asset tree and unpack references, license/provenance, fresh package install and rollback while preserving named private profile. Windows x64 real end-user install remains separately unverified alpha until observed; no Linux desktop claim. Cold package run must find same source/hash, not npm cache/personal Chrome.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

Extend established desktop server ESM parse/runtime specifier/packaged declaration checks without weakening them or accepting warnings. Electron-builder uses files/asarUnpack and intentionally no extraResources: ship one reachable real-file executable/dependency copy, or explicitly installed private cache with reviewed paths/lifecycle. Verify Node launcher and cache paths from actual installed package rather than monorepo require.resolve; test absent library separately from absent/damaged runtime, license/assets, cache reuse and cold/rollback.

Supported-platform packaging acceptance includes actual fresh macOS installed app and Windows x64 installed package observations where that platform is claimed: exact real-file runtime path/hash, private profile create/close/reopen, absent-runtime refusal, upgrade/rollback and owned shutdown. Windows host unavailable remains explicitly UNVERIFIED/alpha for that platform and does not manufacture acceptance or reject independently verified macOS mode. Platform-specific native presence/input remains separately gated, not inferred from installer success.

### Task 8.3: Observe macOS Dock app-switcher and foreground invariance

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 8.2, 5.7, 7.5. Parallel with: none declared.

On exact packaged supported macOS executable/platform use real Dock/app-switcher/process foreground inventory before/during launch, capture/input and renderer/browser/manager crash-recovery. Visible test app positive control must prove observation detects presence/focus. Assert managed headless Chromium adds zero Chrome Dock/app-switcher icons and zero foreground steals; exact owned process cleanup. UI automation unavailable/failed inventory remains UNVERIFIED, never screenshot-label substitute. Repeat accepted identity modes independently and retain failing configuration unavailable. No OS entitlement/firewall changes or operator-app termination.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.4: Retain integrated lifecycle zero-viewer and 100-handoff receipts

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 4.6, 6.7, 7.5, 7.8. Parallel with: none declared.

Run three actual clean restarts with exact cookie/localStorage/IndexedDB/SW/Cache Storage/HTTP cache
fixture values; session/expired-cookie behavior explicit. Two private profiles complete 100 exact
mutations each with zero viewers; reattach same live Page. Exercise exclusions/recovery and 100
handoffs (ack p95<100ms, barrier<=2s) with meaningful named mutants. Record exact source/runtime,
counts and all failures/unverified observations; no prototype PASS inheritance or lost-action replay. Record all5 delivery requirements' subjects: named exact persisted stores, separate unseeded clean return, two profiles100 exact actions each without viewers/same-live-page reopen, two authorized changed-pixel viewers and one epoch. MacOS presence receipt separate task8.3. Prove100 local handoff ackp95<100ms/max2s barrier, mouse/modifier/composition reset, same-actor epoch mutant; force distinct failures and exact inventories original/recovery. No recent-write flush/lossless crash promise.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.5: Observe real native IME clipboard and physical phone input

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 7.5, 8.2. Parallel with: none declared.

Execute real fixture native click/drag/wheel/modifier/emoji/CJK IME composition/copy/paste plus permission-denied recovery through production viewer. Physical Android/iOS touch scrolling/drag is distinct from phone-sized desktop/tap/wheel emulation. Record OS/browser/input versions, actual fixture outcomes and stale viewport/controller refusal. Clipboard requires concrete isolated or preserve-and-restore arrangement before native system reads/writes; no operator contents in artifacts, blind restoration or mock-success native claim. Unsafe/unavailable composition/clipboard/phone arrangement remains UNVERIFIED; full readiness blocked. All managed profiles fixture-only, no paid model/accounts.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.6: Observe macOS VoiceOver browser and desktop semantic interaction

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 7.6, 8.2. Parallel with: 8.7.

Record actual VoiceOver sessions on supported macOS web and packaged desktop using exact OS/browser/AT/runtime. Exercise canonical focus order, successive text field edits with local focus continuation, secret noecho, status/refusal/navigation/revocation and stale tree/frame replacement. Outline/screenshot/DOM assertion/synthesized key cannot establish screen-reader parity. Test view-only local selection never moves canonical focus; remote alerts do not steal local focus. Retain pass/fail/unverified scope and observed limitations; no universal AT/native IME claim from fixture keyboard success.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.7: Observe Windows and mobile assistive-technology matrix

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 7.6, 8.5. Parallel with: 8.6.

Record actual NVDA on supported Windows web browsers, TalkBack Android web and VoiceOver iOS web using exact device/OS/browser/AT/runtime. Verify canonical focus/edit/announcements/navigation/revocation/stale semantic refusal, mobile scrolling/composition and same-field continuation. Windows desktop remains alpha absent separate actual installer observation; JAWS/additional combinations unsupported until observed. Missing device/observer never passing skip or emulated parity. Dedicated fixture-only profiles/sites, no operator account/clipboard data. Retain per-combination acceptance rather than inheriting macOS/native browser results.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.8: Measure host resources and enforce conservative admission

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 8.4, 8.2. Parallel with: none declared.

In a coordinated resource-only window collect nonzero idle/active browser CPU/RSS separately Node/frontend and payload bandwidth for two browsers/two viewers; record exact source/runtime/OS/counters, baseline/load/headroom and observation availability. RSS sums may share pages; free RAM excludes reclaimable cache. Derive conservative enforceable profile/browser/tab/viewer/queue/capture-rate limits from supported envelope, predictable refusal under pressure, no invented capacity from PASS. Positive live-process observer plus root-only/unbounded queue mutants fail specific observations. Hold concurrent latency/browser measurements; retain old loaded-host/zero additional slots results without universalizing them.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 8.9: Measure exact pixel-verified local RTT stalled and real tunnel render

Status: pending · Size: large · Priority: high · Phase: Distribution and real acceptance

Dependencies: 8.4, 7.8. Parallel with: none declared.

Record 100 actual input-to-decode/draw/twoRAF samples local p95<250ms and injected150msRTT p95<600ms,
plus >=10-second stalled viewer with one pending/2MiB bound. Independently validate changed pixels
from named canonical Page, not response self-comparison. Measure actual authorized fixture tunnel
separately; distinct coordinated resource/latency windows, host load and Node/browser/frontend
CPU/RSS/bandwidth. Retain all failures and samples, choose conservative admission envelope from
headroom rather than declaring capacity from observation PASS. No universal idle-host/SLA claim. Resource window task8.8 is separate, not simultaneous; parent schedules quiet browser lane and records unrelated host interference. Retain original RTT100629.9ms FAIL and later scoped300samples instead of erasing history. No filtered failed samples or relaxed250/600thresholds; missing observation UNVERIFIED, actual authorized fixture tunnel separate from150msRTT injection.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 9.1: Freeze exact per-mode readiness with public activation gates

Status: pending · Size: large · Priority: high · Phase: Readiness migration and delivery

Dependencies: 5.3, 5.4, 5.5, 5.7, 6.7, 7.3, 7.9, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9. Parallel with: none declared.

Record readiness separately for each exact executable/platform/identity mode, using
that mode's 5.3–5.5/identity-target/8.2/8.3–8.9 receipts plus API/grant/semantic
negatives and artifact privacy. Status/launch accept only reviewed configurations; failed/unverified
private candidates remain inactive for their rejected mode. Chrome-compatible cannot
activate before its complete target/worker matrix. Explicit native mode may activate
when its own complete identity-target, network and platform gates pass; a failed
Chrome-compatible candidate is not a native rejection. Do not use aggregate5.8status
to block verified native mode or admit failed Chrome-compatible mode. Full compatibility
acceptance and the parent task remain unresolved until the Chrome preference is satisfied. Validate mode/policy
manifest mismatch cannot bypass admission; never silently fallback. Record accepted scope and still-
unverified combinations for product copy and release checks. Dependencies5.7(native) and5.8(Chrome) have distinct outcomes: native record can activate only after its own complete identity/target/network/distribution/native/platform gates even if Chrome failed; Chrome unavailable until full5.8passes. This task must preserve blocked Chrome/full-parent state and mode-specific reasons rather than requiring aggregate candidate PASS or silently fallback. Research264a availability exception unaccepted. Tests stale hash/policy/mode receipts and rejected private patch cannot activate, frontend cannot bundle engine, and status reports unavailable correctly. Full parent not DONE until user Chrome preference and all delivery requirements satisfied.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 9.2: Migrate preset and explicit storage-state compatibility without Doc change

Status: pending · Size: large · Priority: high · Phase: Readiness migration and delivery

Dependencies: 9.1, 6.8, 7.8, 9.4. Parallel with: none declared.

After task9.4 establishes the default-off experiment and task9.1 accepts exact selected-mode readiness, retain the existing browser path while browser.enabled is false. While on, provide explicit managed-browser selection across every runtime through scoped managed_browser capabilities; reject unavailable requested modes without silent native/legacy fallback or uncertain action replay. Do not unconditionally remove legacy browser/preset paths in this initial opt-in migration. Preserve iframe ui/devtools/Doc behavior with no mandatory Chromium for lightweight documents. Existing browser login/status/forget and agent-browser site summaries get explicit compatibility; authorized storage-state import creates a new named profile, not a full clone, personal Chrome reuse or clean-mode seed. No automatic live-page/state migration to legacy on disable. Test all runtime callers, off/on selection, cached tools, absent-mode refusal, revoked views/control/grants and profile ownership. Native-only rollout cannot close the full user compatibility goal; Chrome preference remains unresolved until its complete gate passes.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

### Task 9.3: Document accepted delivery and independently verify release scope

Status: pending · Size: medium · Priority: high · Phase: Readiness migration and delivery

Dependencies: 9.2, 5.8. Parallel with: none declared.

Update profile/login/sharing/install/repair/recovery guides and developer engine/Transport/capability/packaging/failure taxonomy using plain truthful language. Explain private-content signed-in controller disclosure, clean state separation, uncertain lost effects/no replay, actual runtime identity choices, installation vs readiness and explicit stop vs detach. Retain Windows alpha and unverified native/AT/tunnel combinations; no challenge-bypass/indistinguishability/lossless-crash claim. Require independent exact pushed-branch compliance/quality review and affected gates before final parent merge; parent alone updates ADR/manifest only when implemented acceptance qualifies. Completed prototype receipts retained. Full parent closure additionally requires Chrome-compatible preference5.8and every5full delivery requirement; task dependencies do not turn an unverified gate into success.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.

Historical parent source-integration note, before the later lifecycle merge: destination-policy and strict-schema source gates were bounded evidence. Lifecycle PR2465 remained unmerged following an inherited Doc ingestion timeout; all six browser queue shards passed. Full production and native/Chrome-compatible gates remained open.

Current observed state: private fixture lifecycle PR2465 merged at359784d7c08af054291d2598bd416e4ada19895b on2026-10-02T07:06:16Z; exact reviewed36963e4a2e9f07d9fce7f67c617744ba55645eca matches all34 owned merged blobs. Task4.2 completes only that fixture slice; tasks5.1/6.1 remain in_progress and full production readiness remains open.

### Task 9.4: Roll out default-off Shared browser experiment with safe live disable

Status: pending · Size: large · Priority: high · Phase: Readiness migration and delivery

Dependencies: 6.3, 6.7, 6.8, 7.4, 9.1. Parallel with: none declared.

Implement persistent browser.enabled default false in UserConfigSchema and its enclosing factory, append the implementation-release idempotent config migration, and prove fresh defaults plus actual on-disk stale-config behavior without a vacuous migration assertion. Classify config exposure and operator-only writes, mirror configuration references, and add the existing EXPERIMENTS/describeExperiments/ExperimentsTab row titled Shared browser with plain benefit/cost copy and graduationIssue DOR-2671. No temporary environment-only switch or second settings system. Server guarded global config authority applies across users and all runtime callers; preserve the existing login-on cookie/agent checks and document login-off local-trust limits, without claiming a new owner-only route or granting access to others' profiles.

Gate instance/action/grant/control/view/semantic admission, dynamic managed tool discovery and dispatch, direct routes and live streams on the server setting and exact selected-mode readiness. Off preserves legacy browsing and lightweight Doc/iframe without Chromium. Enable refuses missing/failed/unverified selected-mode readiness with truthful bounded reasons, leaves off and never installs/downloads implicitly or substitutes native/legacy. Serialize live disable with config writes, acquisition/close/recovery: persist false and linearize admission closure, revoke grants/views/control, invalidate queues, advance input generation, drain/reset held input within the existing <=2s control barrier and prove bounded exact-owned stop. Timeout is not cancellation proof. If config persistence fails, keep admission fenced and attempt cleanup, expose the write failure without off-success, and reconcile persisted setting, pending shutdown evidence and exact owned-process inventory on restart. Startup never resumes stale browser metadata, queued actions or grants; ambiguous persistence/cleanup refuses acquisition until reconciled. Preserve named profiles and uncertain outcomes; no automatic page migration or replay. Keep stopping/stopped-uncertain visible until cleanup is observed, retain reservation/ownership evidence on failure, and forbid unsafe re-enable or stale callback/grant resurrection.

Meaningful fixtures: off direct/cached-tool/view/semantic calls fail their intended admission cause; on exact-ready mode succeeds; installation-only/stale hash/wrong policy/unavailable Chrome fails without fallback or download. Disable during queued and in-flight input, held keys/buttons/composition, two viewers and unattended browsers; assert no post-barrier effect, stream/grant invalidation, exact process disappearance and preserved named stores. Inject config-write failure and restart reconciliation, failed/never-resolving reset, unavailable inventory, stop failure and concurrent re-enable; assert no false off-success, unsafe relaunch, uncertain replay or profile deletion. Prove all runtime selection and multiuser global authority without cross-owner access, and lightweight Doc/iframe positives while off. Retain original failures and exact nonzero subjects/results. DOR-2671 is a separate future graduation decision, not a rollout/full-parent dependency; no default-on implementation in this task. Preserve every original readiness gate and the five full-delivery requirements.

Use GPT-6.1 Sol with Medium reasoning. Keep work in an isolated assigned checkout with disjoint ownership and normal hooks; parent owns integration, tracker writes, review, PR/merge and cleanup. Use fictitious fixture subjects and private profile/artifact roots; no paid inference, personal accounts, operator clipboard contents or public raw CDP. Each exported operation must be implemented and verified rather than stubbed. Record exact source/runtime/platform, nonzero subject/sample counts and pass/fail/unverified receipts; negative controls must fail the intended named cause, not unrelated setup assertions. Install cleanup before fallible acquisition; preserve primary errors while attempting every cleanup and report observation gaps honestly. This slice permits private fixture integration only, not public production activation; activation requires that exact identity mode's complete identity/network/distribution/native-platform readiness. Preserve original prototype failures and completed task history.
