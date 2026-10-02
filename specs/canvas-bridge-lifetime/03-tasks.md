# Canvas bridge lifetime tasks

Canonical source: `03-tasks.json`. Full decomposition; all nine tasks pending, unclaimed. No tasks promoted; tracker and live Task API projection belong to the coordinator. Explicit user model choice: GPT-6.1 Sol / Medium.

Independent design review: `/root/bridge_spec_adversarial`, GPT-6.1 Sol / Medium, converged with no remaining freeze blockers. Runtime and implementation review remain pending.

### Task 1.1: [canvas-bridge-lifetime] [P1] Add bounded JSON-safe page-report validation and generation wire fields

**Status:** Pending · **Size:** medium · **Dependencies:** none · **Parallel with:** 1.2

Create a pure shared browser-safe bridge wire contract using the existing @dorkos/shared exports convention. Add nonempty bridgeGeneration max128 to optional existing DevtoolsIngest/DevtoolsActionResult/recording upload and capture/action/recording event fields; normalizers/projectors/Transport must preserve these fields. Page protocol is discriminated hello/init/ready/batch/navigated/resource-error/capture-result/act-result; readiness hello includes pageInstanceId max128 and bridgeVersion2. Project known fields only. Do not import server code into the client. Generation is ephemeral correlation, never credential or Doc Channel grant.

Validate raw structured-clone args with a bounded JSON-safe walk before existing JSON.stringify-based Zod refinement: reject cycles, BigInt, unsupported values/nonfinite numbers, depth>8, nodes>2048, >50 args and serialized args>16384 characters. Reject arrays>500console/200network before spread; preserve 20000 text/stack,2048 URL/error/did,65536outline,900000 screenshot caps, numeric finite/nonnegative/integer rules. Seq is nonnegative safe integer. Return a failure without throwing and do not stringify the original unknown tree.

Acceptance: targeted shared tests cover each exact cap and +1, cycles and BigInt as real structured-clone values, a matching legitimate shim batch, unknown fields cannot set active/activation/instrumented/document/URL authority, and error paths cannot throw. Build shared dist then targeted shared typecheck/lint. No runtime claim until browser tasks pass.

### Task 1.2: [canvas-bridge-lifetime] [P1] Implement new-shim generation binding with initial old-host ack mode

**Status:** Pending · **Size:** medium · **Dependencies:** none · **Parallel with:** 1.1

Change workbench-serve devtools-shim emitted script and its driving helpers to advertise bridgeVersion2/pageInstanceId on hello, and support init/ready generation binding. New shim starts unbound. Existing parent-source initial ack from an old already-open host activates explicit legacy mode: bounded console/network delivery and generation-less capture/action requests must actually work. An init enters bound mode; later ack or missing-generation requests cannot downgrade. Same-generation repeated init only retransmits ready without resetting seq/queues/pending work. Different-generation init resets old state and preserves only first-init initial load queues. Every asynchronous action/raster result captures original generation and must not relabel completion after rebind. Keep existing CSP refusal, parent-source checks and no DorkOS API authority.

Acceptance: actual emitted shim tests prove first legacy ack activates delivery, old-style actions/capture resolve, repeated same-generation init preserves queued output and pending completion, new generation rejects/drops old completion, and bound mode ignores ack/generation-less requests. Browser task later drives real baseline old-host behavior with new emitted shim, not a made-up alternate handshake. No claim of shim authentication or protection against same-world synthetic imitation.

### Task 1.3: [canvas-bridge-lifetime] [P1] Own eligible iframe lifetimes and pin host buffers and request admission

**Status:** Pending · **Size:** large · **Dependencies:** 1.1, 1.2 · **Parallel with:** none

Update canvas use-resolved-frame/CanvasBrowserContent/use-devtools-bridge. Add eligibility served-document|preview-listener|null from actual successful resolution. Direct external/devserver/fallback/unresolved frames are ineligible even with opaque origin. Require exact current frame source plus expected null for served docs or exact listener origin for previews. Host generates lifetime UUID and snapshots frame/session/document/logicalURL/origin. Retire synchronously on source/eligibility/origin/document/logicalURL/reload/session/frame replacement/observed iframe load/unmount. Host-driven reload/source remounts frame. After observed load initialize current eligible generation; ready echoes generation. Hello cannot mint generation/claim seat. Updated host never ack/downgrade. Navigated can retire readiness but not authorize a new page.

Pin queued batch and serialized claim/release metadata at acceptance/enqueue. Retire discards unsent old batches/timers/readiness/seq, releases old claims, clears local pending map and settles recording frame waiters. Register max64 pending requests with ID/kind/lifetime/deadline/captureExpected before forward. Deferred rasterizer checks same lifetime/frame/pending entry after await. Unknown/wrong-kind/duplicate/expired/old-gen results cannot call Transport or add frames; valid first matching result consumes entry, malformed does not. Excess host-issued requests get bounded host error.

Parent queue caps: combined UTF8 serialized1MiB +500/200entries, oldest whole-entry drops and host-owned truncation indicator; admit at most one batch/300ms and expose drops. Seq monotonic pergen. Resource error saturates10000 with one animation-frame state update and honest at-least UI copy.

Acceptance: hook positive matching response and exact zero Transport mutations for attacks; defer import across each retirement then resolve with zero old commands into new frame; queue A then change to B within300ms with zero B attribution on A; delayed claim release uses A snapshot; exact queue/request/count caps with +1 and observable loss. Required browser proof remains pending.

### Task 2.1: [canvas-bridge-lifetime] [P2] Bind server waiters and recording uploads without breaking canonical session rekey

**Status:** Pending · **Size:** large · **Dependencies:** 1.3 · **Parallel with:** none

Modify session-devtools routes, devtools-capture-store, browser-seat handlers/devtools-reads/recording and shared stream handling. Driver claims retain optional generation. Pending screenshot/action/recording entries carry expected clientId/documentId/generation from resolved claim. Register waiters before publication, cancel if emitter returns false. Lookup remains requestId alone to preserve first-turn canonical rekey; route sessionId must not equal original sessionId as an acceptance requirement.

Bound pending entries require exact X-Client-Id, host document and generation. Missing/mismatched fields drop with existing sink behavior without disclosure, waiter resolution, screenshot mutation or current-buffer reset. Legacy is an explicit issuing-claim variant genuinely lacking generation, never a response-triggered fallback; omission cannot downgrade bound entries. Unknown screenshots do not overwrite latest image. Capture/reset data from bound generation must match live claim. Host claim establishes/retires state; page extras never do. Preserve existing missing-client legacy captures only without generation. Use pending screenshot attribution, not mutable latest buffer URL. Recording upload remains server-owned path and validates pending original client/doc/gen/live claim before successful file publication, while request ID survives canonical rekey.

Acceptance: real handler HTTP tests +store tests with a known pending request for every mismatch and later exact positive response; canonical route session rekey succeeds once; legacy issuing claim succeeds; omission fails bound; old-gen reset cannot clear current entries; unknown image cannot replace valid requested image; synchronous emitter response succeeds because waiter already exists; late retired upload rejects without file publication. No isolated service test substitutes for route proof.

### Task 2.2: [canvas-bridge-lifetime] [P2] Bound active and finishing recording jobs through sequential decode and retry

**Status:** Pending · **Size:** large · **Dependencies:** 1.3 · **Parallel with:** 2.1

Change use-devtools-bridge recording state plus drawFrames/encodeGif helper interfaces and recording Transport cancellation. Track explicit finishing jobs with recordingId/requestId/original lifetime/canceled/abortController/resources. MaxONE active-or-finishing job per mounted bridge across all generations. Moving active to finishing never drops ownership. New start refuses while a finishing encoder retains resources. Retire cancels job, aborts upload, resolves frame waiters and clears/disposes resources; nonabortable encoder keeps slot until returns, then discard/dispose. Cleanup finally covers rejected helpers. Check original lifetime/cancel flag before helpers, after every awaited capture/decode/draw/encode/retry, before successful upload, and after upload result before local success.

Keep max60 host-requested action frames plus requested start/end (62total), each900000chars (total55800000 chars), encodedGIF<=8MiB. Only matched captureExpected request adds a frame. Compressed caps do not bound decoded memory: inspect raster headers before decode, positive dimensions<=1568each. Sequentially decode one, draw into reusable configured-long-edge surface, retain normalized pixel input, release ImageBitmap/objectURL/tempcanvas/compressed string before next. Retained max62 normalized buffers plus one decoded source and draw surface; no Promise.all decoding or second full-size pixel set. Helpers expose disposal including rejected allocations.

Half-size retry AFTER compressed inputs were released must derive from retained normalized pixels: sequentially replace full-size normalized buffers with half-size buffers, reencode once; never re-decode released strings or recapture current page. Keep lifetime checks and one-job accounting through retry. Dispose all buffers afterward.

Acceptance: deferred capture/decode/draw/firstencode/retryencode helpers each retired then resolved produce zero successful upload and exact cleanup; slot remains occupied until disposal and then reaches zero; cancellation/rejection paths leak no resources; valid short recording uploads once. Force firstencode over8MiB with input strings already released, then half-size pixel retry succeeds, zero seconddecode/recapture, exact frame/dimension/resource caps. Test retired in-flight server upload admission with task2.1. Completed upload before retirement cannot be retracted and is documented honestly.

### Task 2.3: [canvas-bridge-lifetime] [P2] Label page evidence and replace stale trust claims

**Status:** Pending · **Size:** medium · **Dependencies:** 2.1, 2.2 · **Parallel with:** none

Add host/server-generated evidence:{source:'page-reported',verified:false} to console/network tool outputs, read_page/action outputs, screenshot CapabilityImageResult metadata and page-derived recording caveats. Trace model result wrappers and confirm metadata reaches model, not merely an internal schema. Host facts such as asked documentId/logicalURL/request/lifetime stay separate from page.title/url/focused/outline/error/did; never let reported doc ID override host context or put raw page strings into trusted instructional prose. Host-only failures need no page label unless page data included.

Update touched bridge/shim/schema/route descriptions that claim trusted shim source, hello proof of injection, or independently verified raster images. Tools disclose page can alter reports; sandbox/preview sign-in authority remains accurate. Amend original bridge ADR provenance wording to point to accepted lifetime ADR; do not relax its sandbox/CSP contract. Add correctly timestamped user-facing changelog fragment with plain cancellation/reporting explanation, using writing-for-humans.

Acceptance: tests inspect actual returned tool/text/image metadata for constant verifiedfalse on forged and real page reports; page cannot provide verifiedtrue or authority fields; host facts remain correct when page reports wrong title/URL/doc; scan touched comments/callers for superseded claims, document links resolve. UI changed cap/cancellation copy has empty/error/keyboard and screenshot evidence in browser task.

### Task 3.1: [canvas-bridge-lifetime] [P3] Prove real-browser adversaries, compatibility and lifetime transitions

**Status:** Pending · **Size:** large · **Dependencies:** 2.3 · **Parallel with:** none

Read flow browser-testing skill before writing/running scoped e2e. Use isolated fake-login site with production emitted shim, real canvas hook/Transport and real test server; no operator email/personal account or paid inference. Drive actual served-document sandbox and preview-listener origin. Positive console/network/read/action/capture rounds must assert exact admitted subject and evidenceverifiedfalse. Nested/sibling/wrong-origin/ineligible/old-gen attacks must send observable messages and assert exactly zero admitted reports with a positive control.

Actual baseline old already-open host behavior with new response-injected shim: hello→existing ack starts legacy telemetry; generation-less action/capture respond. Updated host sends init notack and never accepts legacy downgrade. Samegen repeated init preserves queued/pending work; newgen resets.

Hold rasterizer import or page result, then sameURLreload/in-frame navigation/doc/source/session change and release; old command/report cannot enter newframe/buffer. QueueA then switchB within300ms asserts correct pinned attribution/drop. Current malicious page listener observes init and forges a known-request well-shaped result; result may be accepted but stays explicitly page-reported verifiedfalse and grants no API/tool/operator authority. This positive forgery control documents limitation, not false anti-forgery success.

During recording emit unsolicited valid images/oversized/stale results; zero added frames. Exact62requested cap drops63rd; valid short recording saves server-owned path. Deferred finishing jobs verify no successful upload after retire, exact resource disposal and no crossgen second-job admission. Firstencoded output deliberately too large after compressedstrings released: half-size normalizedpixel retry succeeds without seconddecode/recapture. Capture and inspect affected cap/error states.

Acceptance: scoped browser suite green with nonzero subject counts, recorded commands/results and screenshots; no arbitrary sleeps, mocks of the boundary under proof or zero-subject negatives. Runtime evidence is mandatory before completion.

### Task 3.2: [canvas-bridge-lifetime] [P3] Run meaningful gates and converge independent adversarial implementation review

**Status:** Pending · **Size:** medium · **Dependencies:** 3.1 · **Parallel with:** none

Run targeted shared/client/server tests for changed behavior, rebuild shared if stale dist, scoped typecheck/lint and affected pnpm verify. Browser suite from3.1 must pass and visual states be inspected. Read REVIEW.md and perform guard-removal experiments with a green nonzero baseline: remove source/origin/generation/pending-result/recording-retirement guards one at a time, ensure intended regression turns red for its actual subject, then restore and rerun. Do not bypass checks or pay inference.

Before EVERY PR obtain independent adversarial implementation review on current code, using GPT-6.1Sol/Medium explicit user choice; design reviewer /root/bridge_spec_adversarial's approval is design-only and cannot substitute. Review real call paths, oldhost/newshim, rekey and finishing async resources. Fix findings and re-review changed scope until converged. Check current main and related merged lane semantics, especially DOR2663 containment, without copying Doc Channel or managed-engine work.

Acceptance: record exact commands/exits/test counts/screenshots/mutant results and reviewer identity/verdict in04implementation; no unfounded passing/security claim. All code and canonical task states agree. This task is pending until runtime and independent code review actually complete.

### Task 3.3: [canvas-bridge-lifetime] [P3] Deliver DOR-2662 through verified merge, Flow DONE and owned cleanup

**Status:** Pending · **Size:** medium · **Dependencies:** 3.2 · **Parallel with:** none

DELIVERY REMAINS PENDING. After3.2 evidence and independent review converge, coordinator uses authorized Flow/PR skills to commit/push scoped work, create and attach each PR to its Codex task, with correct provenance and nonclosing parents for any partial phase. Follow real review/CI and normal merge queue until verified merged. Resolve failures/conflicts with meaningful checks and independent re-review on fixes; never bypass protections or stop at queued/PRcreated.

Coordinator uses resolved flow:linear-adapter for every tracker read/write, publishes exact merged field/generation/lifetime/evidence contract and browser/route proof to existing Canvas project for Doc Channel consumption, marks only actual blockers on DOR2665, then closes DOR2662 only after entire scope shipped. Run Flow DONE after merge. Preserve commits/artifacts remotely and safely archive only owned clean worktree; do not remove other lane worktrees. Record merged PR/commit, closed issue, runtime evidence and cleanup outcome in checkpoint before disposal. No speculative processallowlist/managedbrowser/Doc grants scope.

Acceptance: verified merged PR link/commit, DOR2662closed, FlowDONE recorded, scoped artifacts remotely preserved, owned clean worktree safely cleaned. Designfreeze/taskcreation is not delivery. This task cannot be marked complete early.

## Execution order

Foundation: 1.1 and 1.2 can run in parallel; then 1.3. Response admission: 2.1 and 2.2 can run in parallel in separate isolated writer worktrees; then 2.3. Verification/delivery: 3.1 → 3.2 → 3.3. One lane worktree must never have concurrent writers.

Critical dependency path: (1.1 + 1.2) → 1.3 → (2.1 + 2.2) → 2.3 → 3.1 → 3.2 → 3.3. Read live ownership/WIP and claim through Flow before implementation.
