# Shared browser control — bounded prototype tasks

Canonical source: `03-tasks.json`. Ten of eleven tasks are accepted. Task 2.2 is accepted again after cause-specific durability controls and measured-count regressions passed independent review; task 3.3 awaits whole-branch review and shipping. The lifecycle recovery correction and resource gates remain accepted. User feedback adds task 2.4 for visible native caret and canonical mouse pointer. Model: GPT-6.1 Sol / Medium, explicitly selected. Production implementation will be decomposed incrementally after evidence-refined specification.

Parent owns tracker projection, native-size promotion, integration, PR review/merge and cleanup. Default promotion threshold: xl; task 2.1 is xl. Parent promoted task 2.1 to DOR-2668 under DOR-2667. Other tasks remain canonical local tasks.

Parallel foundation: 1.2, 1.3 and 1.4 after 1.1, using separate worktrees and disjoint modules. Then 2.1 and 2.2 can proceed independently. Observed gates 3.1 and 3.2 can run alongside 2.3 after their dependencies pass. Shared runner/contracts edits must be serialized.

Critical dependency path: 1.1 → 1.2/1.3/1.4 → 2.1 → 2.3 → 3.3; 2.2, 3.1 and 3.2 also gate 3.3. Native observations may remain unverified until their actual surfaces are available; that does not count as production readiness.

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

Coordinator audit addendum to task 1.4: takeover/disconnect resets already-held mouse buttons/modifiers/composition before new input; test cancelled queued release and first human action unmodified.

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

Status: in_progress · Size: medium · Priority: high · Phase: Observed surfaces and refinement

Dependencies: 2.3, 3.1, 3.2. Parallel with: none declared.

Consolidate reproducible commands and per-gate receipts into specs/shared-browser-control/05-prototype-evidence.md without committing profile data, tokens, cookies or secret-bearing logs. Include exact executable/library/OS receipts, artifact locations, sample counts, baseline and mutation/negative-control outcomes, measured distributions, pass/fail/unverified and limitations for every gate. Require independent adversarial reviewer separate from implementers to review prototype code and evidence under REVIEW.md, verify incorrect implementations fail the intended tests, and re-review changed scope after fixes. Run targeted meaningful tests and required repository gates; avoid paid inference. Record unresolved native IME/phone/accessibility/tunnel/macOS/distribution blockers explicitly. Do not close the full production parent or claim production complete. Parent owns integration, tracker writes, every PR review/merge and cleanup.

Work only in scripts/browser-control-prototype/ and isolated ignored temporary directories. Use GPT-6.1 Sol with Medium reasoning, overriding Flow tiers. Use fictitious fixture identities; no paid model turns, personal accounts, operator messages, primary-checkout source writes or public raw CDP. Tests must name subjects, assert nonzero observation/sample counts, and carry purpose comments. Record failed or unavailable evidence honestly; missing observation is unverified, never a passing skip.

After these prototype tasks, parent refines the production specification from measured findings, explicitly amends ADR 260912-025251, and runs incremental DECOMPOSE. No production implementation tasks are created in this bounded experiment.

### Task 2.4: Show the native text caret and canonical mouse pointer

Status: completed · Size: large · Priority: high · Phase: Mechanical execution

Dependencies: 1.3, 2.1. Gates 3.3.

Address explicit user feedback from the attended fixture demo: preserve the actual native text caret in captures, and show a visible mouse pointer reflecting accepted canonical human or agent input. Bind pointer position to tab, navigation, viewport and current control lifetime; clear stale/reset/disconnected positions. Scale coordinates correctly in the viewer. Keep view access separate from control, and never fabricate a text caret. Add red-first native caret pixels, pointer scaling and stale-lifetime regressions. Keep wrong-page pixel negative controls and frame queue bounds. Independently review changes before mechanical latency resampling; preserve the original RTT failure.
