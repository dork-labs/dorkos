---
slug: canvas-bridge-lifetime
number: 261001-201135
created: 2026-10-01
status: specified
---

# Bound browser bridge reports to their page lifetime

**Status:** Approved (design only; implementation pending)
**Author:** Codex, GPT-6.1 Sol / Medium
**Date:** 2026-10-01

## Overview

DOR-2662 makes the existing iframe bridge a bounded channel for untrusted page reports. Bind page lifetimes, pending requests and server response admission; label evidence honestly. A current malicious page can still forge its own report. The design is frozen following independent re-review by `/root/bridge_spec_adversarial` using GPT-6.1 Sol / Medium. No design freeze blockers remain. This is design approval only: runtime proof, implementation claim and tracker stage projection remain pending and coordinator-owned.

## Background / Problem Statement

`event.source === iframe.contentWindow` identifies a window, not the script that sent a message. Opaque origins all serialize as `null`. The approved preview origin identifies the preview listener, not its shim. A same-world nonce, inline-script ordering or MessageChannel cannot make reports trustworthy.

The current host forwards unsolicited action/capture results, spreads batches before validation, records unbounded unsolicited images, and can forward old requests into a newly loaded frame after lazy imports. Debounced entries capture session identity but not document identity. The server bounds stored data but updates the screenshot slot before checking request correlation and resolves actions using request ID alone. These are independently fixable without a new browser engine.

## Goals

- Reject other frames, ineligible frames, wrong origins, retired generations and unsolicited/duplicate/expired/wrong-kind results before host mutation or Transport calls.
- Pin host session/document/URL facts when accepting a batch or issuing a request.
- Bound host accumulation, request admission, response sizes and recording retention.
- Validate structured-clone input without throwing or invoking an unbounded JSON stringify.
- Preserve canonical session rekey and legacy client compatibility without allowing a bound request to downgrade.
- Make all page-returned evidence visibly untrusted in model-facing results and technical contracts.

## Non-Goals

No managed engine, separate script execution world, browser-native capture, Doc Channel endpoint/grant protocol, page-origin tool invocation, process allowlist, Relay work, new credential/config or stronger promise against hostile current-page scripts. No relaxation of CSP or iframe sandbox. No personal-account browser exercise.

## Technical Dependencies

Existing React/Transport/session stream, Zod shared schemas, injected shim/rasterizer and WORKBENCH limits suffice. No dependency additions. DOR-2663 must provide the separate served-document containment boundary before Doc Channel frame rollout; this bridge is not that boundary. DOR-2660 namespace ownership remains distinct. DOR-2661, DOR-2664 and DOR-2666 are not blanket prerequisites.

## Detailed Design

### Architecture and ownership

The host controls eligibility, frame identity, generation, attached session, document ID, logical URL, pending requests, recording admission and driver-seat claims. The page controls every console/network value, outline, title, focused element, action result and screenshot. Host attribution says which preview was asked; it does not verify the page's answer.

Add `bridgeEligibility: 'served-document' | 'preview-listener' | null` to `ResolvedFrame` and pass it to the bridge. Populate it only from the actual successful served/proxied resolution. External pages, direct dev-server addresses, fallbacks and unresolved/error frames get null, even if a future sandbox produces an opaque origin. Keep source equality and exact origin checking; served documents require `null`, preview listeners require the exact resolved origin. Do not accept `null` unconditionally when expecting a real preview origin.

### Exact field map

| Boundary                     | Field                                                                                         | Owner / rule                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Host lifetime                | `bridgeGeneration`                                                                            | Host UUID, maximum 128 characters, nonempty; ephemeral correlation, never a credential                        |
| Host lifetime                | `sessionId`, `documentId`, `logicalUrl`, frame WindowProxy, eligibility/origin                | Host snapshot; never read these from a page report                                                            |
| Shim discovery               | `__dorkosDevtools: 'hello'`, `pageInstanceId`                                                 | Shim-generated per-document UUID, nonempty max 128; untrusted hint, never authorization                       |
| Host initialization          | marker `'init'`, `bridgeGeneration`                                                           | Sent only to current eligible frame; host owns generation                                                     |
| Page readiness               | marker `'ready'`, `bridgeGeneration`, `pageInstanceId`                                        | Echo acknowledges current init; page-reported readiness only                                                  |
| Every accepted page report   | Existing marker, `bridgeGeneration`, payload                                                  | Generation equality required; strict discriminated payload validator                                          |
| Host requests                | Existing request marker, `bridgeGeneration`, `requestId`, existing command/lib/capture fields | Host-issued ID and pinned lifetime; library is only host→page                                                 |
| Driver claim / ingest HTTP   | Optional `bridgeGeneration` alongside existing fields                                         | Host sets it; route validates; store retains on claim                                                         |
| Server capture/action events | Optional `bridgeGeneration` alongside `targetClientId`, `documentId`, `requestId`             | Taken from resolved driver claim; shared schemas + normalizer preserve it                                     |
| Action HTTP result           | Optional `bridgeGeneration`; existing `documentId`                                            | Host fills documentId from pending request, not page data; header client ID remains request transport fact    |
| Screenshot HTTP              | Top-level optional `bridgeGeneration`; existing documentId and screenshot request ID          | Host pins attribution; store matches pending metadata before changing slot                                    |
| Model-facing evidence        | `evidence: { source: 'page-reported', verified: false }`                                      | Host/server-generated constant, not page-supplied; included for page evidence, including image metadata       |
| Model-facing host failures   | Existing failure/note fields                                                                  | Host-generated facts do not claim a page action occurred; no page evidence label unless page data is included |

Do not reuse these fields as Doc Channel grants or proof of operator intent. Do not copy page-supplied extra envelope fields into ingest (`active`, `activation`, `instrumented`, session/document/URL identifiers, recording bounds or upload path).

### Generation state machine and handshake

States: disabled → loading → awaiting-ready → ready → retired. Only host resolution/lifetime events enable a new generation. A `hello`, `ready`, `navigated` or arbitrary batch must never mint a generation or take a driver seat.

Retire synchronously on source/eligibility/origin/document/logical URL/reload change, attached-session change, iframe replacement, observed iframe load and unmount. On session change, retire rather than reattribute pending evidence; generate a new lifetime for the same live frame and initialize it again. Canonical session rekey also retires the client lifetime; any already-valid server waiter remains globally keyed by request ID and can complete if its response was already accepted under the prior lifetime. A response not yet accepted at the host when the session changes is canceled, not reassigned.

Host-driven source/reload changes remount the iframe with a key based on resolved source and reload, giving a new source identity as well as a generation. An observed load also retires the pre-load generation even where navigation kept the same WindowProxy. After load, send init for the new host generation. A hello arriving before load can request initialization later, but cannot mark readiness. Repeated hello after load retransmits the current init; it cannot rotate a ready lifetime. Ready must echo current generation. Never adopt an old pageInstanceId as a host security fact.

Shim binds its flush/action/capture operations to the generation active when each operation starts. Repeated init for the SAME generation is idempotent: resend ready without clearing queues, seq, requests or delivery state. Only a DIFFERENT generation resets seq, queues and old delivery state and acknowledges ready. Preserve bounded initial page-load queues on the first init only; subsequent init discards prior-generation queues. A completion after rebind may be dropped or sent with its captured old generation, but must never be relabeled. This is cooperative stale-message protection: a hostile current page can observe the current init and imitate readiness/results.

A page `navigated` report may retire readiness early and clear page evidence, but cannot mark a new page ready or activate a seat. Browser-observed load is the authoritative event for actual document replacement. A page can lie about navigation and make its own reporting unavailable; that is within its untrusted channel, not authority over another frame.

On retirement clear generation-local pending batches/timers, seq, readiness/resource counts, all local request entries, recording-frame waiters, active recording buffers and finishing recording jobs. Finishing jobs remain owned by their original lifetime through every asynchronous helper and must be canceled/disposed as specified below. Resolve local recording-frame waiters with null. Explicitly fail outstanding tool requests through their existing HTTP result channel with a bounded host-generated error and their pinned metadata, where possible, before releasing the old claim; otherwise their existing finite server timeout is the backstop. Do not assert this error proves the command never executed.

### Handshake compatibility and version matrix

The new shim initially has an unbound protocol mode. Its hello advertises `bridgeVersion: 2` in addition to pageInstanceId; an old host ignores unknown fields and returns the EXISTING `ack` marker. Accept that first parent-source ack only while unbound: enter explicit legacy mode, start bounded telemetry delivery and accept generation-less old-host capture/action requests. Legacy outgoing reports keep their original fields; optional advertisement fields must not break old-host checks. The initial legacy ack actually activates delivery, not merely records a compatibility label. The new shim must continue to perform real old-host action/capture round trips in that mode.

A parent-source init enters bound mode and assigns the host generation. This mode is terminal with respect to legacy: later ack or generation-less requests cannot downgrade it. A new init with another generation rebinds; the same generation init only retransmits ready. An updated host NEVER emits legacy ack or accepts generation-less page reports. It only enables ready after its version-2 generation exchange; an old shim cannot force compatibility fallback. Page code may imitate either mode in its own world; modes provide interoperability and correlation, not authentication.

| Host                    | Shim                       | Expected behavior                                                                                                                       |
| ----------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Old                     | Old                        | Existing legacy behavior unchanged                                                                                                      |
| Old already-open client | New response-injected shim | Hello → existing ack activates legacy delivery; generation-less action/capture works                                                    |
| Updated                 | New                        | Init/ready and generation required; repeated same-generation init preserves state                                                       |
| Updated                 | Old cached/in-flight shim  | Remains unready; refuse driving/report admission with existing unavailable flow until reload supplies the new shim; no silent downgrade |

A server-generated response can load a new shim into an old open host; that compatibility path is mandatory. Strict new-host admission cannot promise support for a previously loaded old shim without weakening its generation contract. No server wire downgrade is inferred from a page message: legacy server waiter behavior depends only on the issuing host claim.

### Atomic buffering and asynchronous requests

Each accepted batch stores one immutable lifetime snapshot. Flush uses that snapshot's session/document/URL/generation; never current refs. Retired unsent batches are discarded. Driver claim/release queue closures similarly capture immutable claim fields at enqueue time, so a delayed release cannot release a new document or generation.

Before a capture/action/recording frame is forwarded, register `{requestId, kind, lifetime, deadline, captureExpected}`. Cap local in-flight admission at 64 requests per generation. Excess host-issued tool requests receive an immediate host failure, rather than silently timing out. Recording-frame requests count in the same cap.

Lazy import closures pin the original frame and lifetime. After import success/failure, verify both are current and the pending request is still live before posting. A switched frame never receives an old command or rasterizer source. Validate event targetClientId/documentId/generation against the host before registering or forwarding. A request addressed to a new bound claim must carry all three; the legacy no-generation path is allowed only for a legacy claim.

Results must match the registered request ID, kind, generation and frame, before any image retention or Transport call. Delete the local pending entry when accepting the first valid result. Invalid responses do not consume the waiter: a later valid response can still succeed until deadline. Duplicate/unknown/expired results are dropped; screenshots cannot overwrite state merely because they name an arbitrary request ID. Only a request with `captureExpected` may add an action recording frame.

### Server correlation and rekey compatibility

Extend pending screenshot/action entries with optional expected `{clientId, documentId, bridgeGeneration}` taken from the resolved claim at issuance. Register waiters before publishing events, and cancel/resolve them if publication fails. Lookup remains request ID alone. Do not require the route session ID to equal the original session: first-turn canonical rekey is supported intentionally.

For a bound waiter require exact expected header client ID, host document ID and generation before accepting its result. A missing field fails equality. Return the existing sink success/drop behavior for rejected correlation; do not disclose another pending request. No mismatch may resolve a waiter or update screenshot storage. Bound and legacy waiters are explicit variants, not validation fallbacks. Legacy waiter means the issuing claim genuinely lacked generation. No response can downgrade a bound waiter by omitting generation.

For legacy screenshot waiters, preserve valid requested response behavior, but still drop unknown IDs before storing screenshots. Existing tests that directly inject an unsolicited screenshot need to create an actual pending request instead of preserving the defect. Generation-aware capture/reset batches must match the current claim for the same client/document/generation; host claims can establish/retire the claim, ordinary page data cannot. A retired generation's reset must not clear a current generation's data. Preserve missing-client-ID legacy captures as existing route behavior where no generation is supplied; never treat these as generation-aware authority.

Pin screenshot outcome attribution to pending request metadata instead of the buffer's mutable latest URL. When a bound action arrives, expose host document ID separately from `page.url/title/focused`; do not allow reported documentId to override host attribution.

Recording upload is host output, not page-requested upload. Preserve server-owned destination/path from pending recording state. Add generation to recording state/events/pending upload metadata where necessary so retirement cannot finish an old run using new-page frames. Validate upload client/generation/document against that pinned state. Maintain request-ID rekey compatibility.

### Validation and limits

Use a shared pure validator that accepts unknown structured-clone data and constructs a JSON-safe bounded projection. Do not call server `DevtoolsConsoleEntrySchema` on raw args: its JSON.stringify refinement assumes JSON input. Reject cyclic structures, BigInt, unsupported types and non-finite numbers in args using a bounded walk (max depth 8, max visited nodes 2,048, max serialized args 16,384 characters per entry). Only after projection may existing Zod validators run. Catch all failures and drop the message without throwing the window listener. Ignore unknown properties by constructing known fields, not copying whole objects.

Reject over-count arrays before spreading: max 500 console and 200 network entries. Preserve existing per-field caps (console text/stack 20,000; args count 50; URL/source/error/did 2,048; request ID 128; document ID 256; outline 65,536; screenshot data URL 900,000). Seq must be finite, nonnegative safe integer and monotonic within one generation; duplicate/lower seq batches are dropped. Validate existing result numeric constraints, and finite network timing/status/size values. For screenshot success require a valid raster data URL and existing MIME/magic-byte validation; reject SVG and malformed base64 before recording decode/draw or ingest.

Keep at most 1,048,576 serialized UTF-8 bytes combined in parent console/network queues, with oldest whole entries dropped until within budget, plus existing entry caps. Report drops using existing truncation semantics extended with a host-owned drop indicator rather than silently advertising completeness. Coalesce forwarding to no more than one batch per 300 ms per lifetime. Rate-limit message _processing_ by admitting at most one batch per 300 ms; count admitted/dropped batches for deterministic tests. This can drop burst batches; surface loss and keep a finite bound. Do not claim it prevents browser structured-clone cost or a malicious page from consuming its own CPU before the listener runs.

Saturate resource-error count at 10,000 and schedule at most one visible state update per animation frame. Reporting 10,000 means at least that many, so UI copy must state the cap honestly.

Recording keeps at most 60 requested action frames plus its requested start/end frames (62 total), each at most 900,000 characters. Cumulative retained data-URL characters therefore cannot exceed 55,800,000. This explicitly bounds the pre-encoding buffer independently of server-reported frame counts; retained strings can consume more memory than their character count. Encoded output remains capped at 8 MiB. Stop admitting frames at the cap, state truncation honestly and resolve stop; never repeatedly append forged frames. Do not misrepresent the encoded 8 MiB cap as the raw-frame memory bound.

### Finishing recording jobs, decoding and disposal

A stop does not remove lifetime ownership. Move active recording into an explicit finishing job `{jobId, recordingId, lifetime, requestId, frames, canceled, abortController, resources}` held in a bounded registry until upload settles or disposal completes. There may be at most ONE recording job total per mounted bridge across all generations, counting active AND finishing jobs. A start while a finishing job still owns resources receives a bounded host failure; generation rotation must not bypass this admission limit. Do not set the sole recording reference to null and leave an untracked asynchronous closure holding all frames.

Retirement marks the finishing job canceled, aborts any upload, resolves its frame waiters, clears retained encoded input/output strings/byte arrays and schedules disposal of decoder/drawing resources. An already executing encoder may not support abort; keep its finishing slot occupied until it returns and then discard its output and dispose. Admission therefore bounds overlapping work even when cancellation cannot interrupt a third-party helper. Registry removal happens only after cleanup, with a finally block that also covers helper failures. Failure reporting may use the pinned request's existing bounded result channel; it may never upload a successful recording after cancellation.

Check the exact original lifetime and cancellation flag before starting each helper, immediately after EVERY awaited capture/decode/draw/encode/retry operation, and immediately before issuing a successful upload. Check again after upload resolution before accepting local success or retaining resources. A resumed old job cannot consult current generation refs and adopt them. The half-size retry follows the same checks and resource accounting. After compressed inputs have been released, retry derives half-size encoder inputs from the retained normalized pixel buffers, sequentially replacing each full-size normalized buffer with its half-size replacement. It must not decode released strings again, retain a second complete pixel set or recapture a changed page. Retain normalized buffers until successful first encoding or completion/cancellation of the one retry; disposal after either path releases them. A test forces first encode over the 8 MiB cap after strings were released and asserts the second encode uses the half-size normalized data, succeeds for a valid positive fixture, keeps the one-job budget and performs no second raster/decode. Use a lifetime AbortSignal in the recording Transport upload; server upload admission validates original client/document/generation and the still-live pending recording claim before file publication. An upload already committed before retirement remains a completed recording; abort cannot retract that completed side effect. Retirement before successful-upload admission must produce no successful upload, and stale in-flight uploads must fail server admission if the generation/claim has retired.

The 900,000-character cap limits compressed raster data and the 8 MiB cap limits encoded GIF output. Neither bounds decoded pixel memory. Validate raster dimensions BEFORE full decode using bounded format header inspection; require each image's width and height to be positive integers no greater than 1,568, and reject larger/malformed headers. For recording, normalize decoded output onto the configured recording long-edge size and process frames sequentially: decode one frame, draw into one reusable target surface, extract the encoder's required data, then release ImageBitmap/object URL/temporary canvas and the corresponding input string before decoding the next frame. Retained pixel/encoder inputs remain bounded by frame count × configured normalized dimensions; document the concrete configured dimensions and byte allocation formula in implementation tests. Do not use Promise.all to decode every retained frame or retain full-resolution canvases alongside encoder inputs.

If the encoder necessarily holds normalized pixels for every frame, include those arrays in job resources and dispose them on cancellation/completion; do not claim constant memory. The budget is one job with at most 62 compressed frames and at most 62 normalized frame pixel buffers, plus one decoded source image and reusable draw surface. Helpers must return or expose disposable resources; a rejected helper still releases anything allocated before failure. A new job cannot start until those resources are released.

### File structure and API changes

Modify existing canvas resolution, component and hook; factor pure lifecycle/message-admission helpers within the canvas slice where useful. Shared wire validation/types live in `packages/shared` with an exported subpath consistent with existing exports. Follow barrels/FSD. Server changes remain in existing workbench-serve and session/browser-seat domains/routes. Shared schemas and session event normalization must carry optional generation end to end. No new persistent model, database table or config migration.

### Evidence labeling

Add constant evidence metadata to console/network outputs, page-read/action outputs, screenshot CapabilityImageResult metadata and page-derived recording caveats. The host assigns it, never the page. Tool descriptions say the page can alter what it reports. Replace comments describing source identity as trusted shim authentication, `hello` as proof of injection, or rasterized images as independent verification. Keep exact host facts outside page values; do not interpolate page title, errors or outlines into trusted instructional prose. Existing page-returned error strings remain bounded untrusted result data.

## User Experience

Normal local previews continue to report logs and answer page actions. A reload/navigation/session switch cancels outstanding work with a plain message: “The preview changed before it returned a result. Try again.” This does not claim an action did not run. An uninstrumented or CSP-blocked page retains its existing refusal/fallback flow. Browser tools disclose that their results come from the page. Bounds produce an honest truncation note; saturated resource errors show “at least 10,000 errors.” No new approval UI or inferred operator consent is introduced.

## Testing Strategy

Each test explains the boundary it proves. Baseline tests run green with actual subjects; guard removal must make the intended regression fail.

- **Unit:** browser-safe projection drops cyclic/BigInt/deep/oversized args without throws; array prechecks run before spread; field limits and exact pending count/queue bytes/frame count; seq reset and duplicate handling; unknown/wrong-kind/duplicate/expired results have zero Transport calls with a matching positive control.
- **Hook temporal:** defer rasterizer resolution, then source/reload/doc/session change and resolve it; assert the new frame receives zero old requests. Queue document A batch then switch to B within 300 ms; no A entry has B metadata. Delayed claim-chain release uses A snapshot. Retire resolves every local recording waiter and empties buffers.
- **Server routes/store:** cross the real HTTP handler with existing test server/FakeAgentRuntime. A known bound request rejects wrong/missing client, document and generation without resolving or updating screenshot/reset state; then its exact matching response succeeds once. Canonical route session rekey still resolves; legacy issued request works; omitting generation cannot downgrade a bound request. Unknown screenshots never replace a prior valid requested screenshot. A synchronous publication positive control proves waiter registration occurs first.
- **Browser:** isolated fake-login fixtures only. Run real production injection, served-document sandbox and preview listener, hook and real transport/server. Assert console/network/read/action/capture positive round trips, host generation and evidence metadata. Sibling/nested/wrong-origin fixtures send observable attacks and produce zero admitted reports. Drive same-URL reload, in-frame navigation, session change, delayed import and delayed page result; assert old reports/commands do not cross.
- **Browser adversary:** current page registers a message listener, observes current init, forges a well-shaped known-request result and sends it. It may be accepted as page-reported evidence; assert its `verified: false` label and no DorkOS capability grant. This positive control proves the limitation instead of making a false anti-forgery claim. Demonstrate sibling or retired-generation attempts still fail.
- **Finishing-job temporal:** defer capture, decode, draw, first encode, retry encode and upload-admission helpers separately. Retire while each is pending, resolve it, and assert zero successful upload calls admitted after retirement, all resources disposed, registry returns to zero only after disposal, and new generation cannot start a second job while old work retains resources. Include helper rejection and cancellation during retry. A legitimate stop/upload remains a positive control.
- **Handshake compatibility:** execute the actual baseline old host handshake/message behavior with the NEW emitted shim in Chromium. Existing ack must activate console/network delivery and generation-less action/capture responses. Updated host never emits ack, ignores legacy reports and cannot downgrade after init. Repeated same-generation init preserves queued telemetry and pending work; a different generation cancels/resets it.
- **Browser recording:** repeated unsolicited valid images, oversized image and stale-generation captures never add frames; 62 requested frames reach the exact cap and the next is dropped. A legitimate short recording still saves to its server-owned path.
- **Gates:** targeted client/shared/server tests, package typecheck/lint and affected `pnpm verify`; browser suite and screenshots of affected error/truncation states. Required merge-queue gates remain intact. Revert each key guard in a temporary test experiment and confirm its specific regression red, then restore the source.

## Performance Considerations

No new browser dependency. Validate only admitted messages; bound traversal work and queue retention. Parent limit is 1 MiB console/network, 64 pending entries and finite timers. At most one active-or-finishing recording job owns at most 55.8 million compressed data-URL characters, at most 62 normalized frame pixel buffers, one decoded source image capped at 1,568 × 1,568 pixels and one reusable draw surface. Sequential decode/draw releases source/input resources; a non-abortable encoder keeps the global job slot occupied until output is discarded/disposed. Compressed-character and encoded-file caps do not bound decoded pixel memory. Browser delivery/structured-clone cost precedes host validation and is outside this guarantee. Rate limits must expose dropped evidence rather than pretend complete telemetry. Dispose timers and release recording state on every retirement.

## Security Considerations

Generation authenticates no script and authorizes no action. A hostile current page can forge readiness/results, suppress messages, tamper with DOM/console, lie about navigation and execute its own page capabilities. A cross-origin/opaque sandbox prevents DOM access to DorkOS; DOR-2663 supplies served-content isolation. Preview actions retain the preview site's existing sign-in authority. Host forwarding provides only the current approved reporting/command channel; no arbitrary `/api`, file path, grant, tool invocation or operator identity may be introduced. Preserve CSP refusal and server authentication. Raster bytes are validated but remain untrusted visual evidence.

## Documentation

Update bridge/shim/route/schema/tool comments and descriptions touched by the contract. Amend the original bridge ADR's source-identity/provenance wording with the new accepted design ADR. Add a user-facing changelog fragment during implementation, describing cancellation and safer preview reporting without internal jargon. Publish exact merged fields/lifetime/taint evidence for the Doc Channel lane through the coordinator's Linear adapter. No historical changelog sweep.

## Implementation Phases

- **Phase 1 — core contract:** Execute frozen canonical tasks to implement eligibility, host generation/handshake and typed safe message validation, including temporal and adversary regressions.
- **Phase 2 — response admission:** Pin host pending requests and server correlation, preserve legacy/rekey paths, update recording lifetime and cumulative bounds, add explicit evidence metadata and stale-comment cleanup.
- **Phase 3 — verification and delivery:** Run meaningful browser/route proofs, independent adversarial review and guard-removal checks; fix findings, ship the scoped PR through required queue gates, publish the boundary contract and mark DOR-2662 DONE only after verified merge. Phases are internal tasks; a partial PR must not close the parent.

## Open Questions

- ~~Can a same-world nonce authenticate the shim?~~ **(RESOLVED)** Answer: no. Rationale: page listeners observe host messages and can imitate the current shim; generation provides correlation only.
- ~~Must response resolution require the original session ID?~~ **(RESOLVED)** Answer: no. Rationale: canonical first-turn rekey must remain valid; request ID lookup plus expected client/document/generation is the binding.
- ~~Do page reports need Doc Channel grants?~~ **(RESOLVED)** Answer: no. Rationale: this is existing browser reporting; grants authorize distinct document-channel capability and must not be conflated.
- ~~Which admission and retention defaults ship?~~ **(RESOLVED)** Answer: 64 pending requests, one admitted batch per 300 ms, one active-or-finishing recording job across generations and 62 retained recording frames. Rationale: independent design re-review converged with these finite bounds. Runtime/positive-control proof remains mandatory; any justified contract change updates constants, acceptance assertions and documentation together.
- ~~Which model-facing provenance field ships?~~ **(RESOLVED)** Answer: additive host-generated `evidence: { source: 'page-reported', verified: false }` in tool output metadata. Rationale: makes taint explicit without accepting a page-authored trust label; implementation must trace each result wrapper and prove the field reaches the model.

## Related ADRs

- `260711-143246-devtools-bridge-postmessage-capture-channel.md`: original channel architecture; amend provenance wording rather than weakening the sandbox.
- `260708-185519` served-document sandbox and `260912-025251` browser driving posture: retain current authority limits.
- `261001-201136-page-reported-bridge-lifetime.md`: accepted design decision on taint, generation and request binding; runtime implementation remains pending.

## References

DOR-2662; original Doc Channel routing/source audit; programme overview `plans/canvas-browser-delivery-20261001.md`; source files listed in ideation and detailed design; `REVIEW.md`. Current source has been read, but no implementation tests or live tracker facts were independently executed in this preparatory subagent.
