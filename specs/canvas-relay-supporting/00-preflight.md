# Canvas and Relay supporting lane preflight

Prepared 2026-10-01. Preparatory source audit, not a frozen specification or canonical DECOMPOSE task list. The current checkpoint below records verified delivery and active ownership; the historical source findings remain investigation pointers.

## Run boundaries and assumptions

- Own DOR-2660, DOR-2661, DOR-2662, DOR-2663, DOR-2664 and DOR-2666 plus `plans/canvas-browser-delivery-20261001.md`. Each delivered issue gets its own scoped PR. DOR-2665 and managed-browser implementation are outside this lane.
- Explicit user choice: GPT-6.1 Sol, Medium reasoning. Implementation/review subagents use that model/effort where supported, overriding Flow's tier bindings.
- User authorized scoped tracker writes, commits, pushes, PRs after independent adversarial review, conflict/CI repairs, normal merge queue, verified merge, Flow DONE and safe owned-worktree cleanup. Historic read-only/push approval notes are superseded.
- Assigned worktree: `/Users/doriancollier/.codex/worktrees/5fa3/dorkos`; branch `codex/served-document-isolation`; pinned starting commit `996161118a84f938fe76b6e569ba077dfb7a574a`.
- Verified git-dir differs from common-dir. Original checkout files are inputs only. No unrelated original `.dork/agent.json` was copied. No paid inference or personal-account/operator messaging is authorized.
- Canonical installed Flow and configured Linear adapter were read. Local settings were copied into this worktree, preserving configured connection/team; shared ignored metadata writes are now authorized. No credentials are recorded here.
- Installed Flow hardcodes its run store under the primary checkout. The human authorized its shared ignored metadata store.

## Historical initial tracker evidence

`flow snapshot` fetched 251 open configured-team issues at `2026-10-01T19:55:18.952Z`. All six assigned tasks remain in TRIAGE, unclaimed, with no project or native estimate. Canvas and Browser in Rooms is started. No new duplicates are needed.

`flow next --snapshot ... --no-account --json` reported `atWipCap: true`, `wip.total: 4`; configured global cap is three. Claimed work belongs to other owners. Later clarification permits direct scoped assignment; preserve unrelated owners and global settings.

Original routing/source audit and handoff were read as historical inputs and rechecked against the pinned current code. Their conclusions are investigation pointers, not execution proof.

## DOR-2663: served-document isolation

Current `apps/server/src/routes/workbench-serve.ts:264` sets content type, nosniff, cache and referrer headers, but no response sandbox. Current client `WORKBENCH_SANDBOX_ISOLATED` omits `allow-same-origin`; its attribute only protects framed navigation.

Bounded fix: response CSP sandbox on all served files, retaining the required script/form/popup/modal behavior and omitting `allow-same-origin`. Validate HTML and SVG/document responses, relative assets and normal frame rendering. Embedding restriction must be compatible with the actual web, desktop-dev and tunnel origins; do not blindly add SAMEORIGIN if it breaks supported cross-origin desktop rendering.

Required proof: a real browser opens a signed document top-level and attempts API reads and state-changing requests, cookies/storage and parent access. Negative assertions count the attempt and include a positive control. Normal iframe rendering and production-shim script execution must still work. Preview-origin routing is a separate surface.

## DOR-2660: namespace ownership and routing

Current `WebhookAdapter` binds its inbound subject as its outbound routing prefix. `AdapterRegistry.getBySubject` uses raw `startsWith`. Schema/start/inbound checks refuse only server-destination reachability; an agent namespace is still accepted.

Bounded fix must cover new config validation, persisted invalid config startup and inbound calls, not only the form. Reserve a webhook-owned namespace and prevent a webhook from owning agent, human, inbox, system/control and new document principals. Registry prefix matches must respect exact dot-token boundaries, including prefixes already ending with a dot. Check overlap/duplicate ownership against existing registrations without banning intentional runtime-specific prefix specialization.

Required proof: invalid agent/doc configs cannot intercept traffic or publish; valid webhook subject still works; `relay.webhook.x` cannot capture `relay.webhook.x2`; runtime-specific longest matching remains valid; persisted invalid configuration is refused with a named error.

## DOR-2661: signed JSON through the real application

Current app global `express.json({limit:'1mb'})` precedes the relay router. The route's `express.raw` then receives a consumed JSON stream; it casts `req.body` to Buffer without proving that shape.

First executable task is a red full-app regression using a real started `WebhookAdapter`, real HMAC, timestamp and nonce over exact JSON bytes with whitespace and Unicode. No mocked `handleInbound` or signature verifier. Add wrong-signature, modified-bytes, replay and malformed JSON cases as meaningful controls. Preserve current session/origin/host/auth gates and body-size ceilings when choosing a parser-order fix; do not move the webhook ahead of authorization by analogy with another ingress.

This issue is independent of Doc Channel frame transport.

## DOR-2662: bridge trust and containment

Independent preparatory adversarial reviewer: `/root/bridge_contract_review`, explicitly GPT-6.1 Sol/Medium. This review inspects the existing source and contract; it is not the required final pre-PR review of a fix.

The shim executes in the page JavaScript world. Source/origin identifies the frame, and a nonce/challenge can bind a lifetime, but neither authenticates shim authorship against current-page scripts. Any solution claiming otherwise is rejected.

Recommended contract to develop through IDEATE → SPECIFY:

1. Page summaries, console/network records, screenshots, action success and errors remain explicitly untrusted page reports. Host-assigned URL, client/document identity and generation are separate host facts.
2. Bridge eligibility requires host-resolved serve or instrumented-preview framing, plus the current source and exact expected-origin checks. A null preview origin alone does not authorize every opaque frame.
3. Parent owns a fresh generation for mount/source/reload/load/navigation/session changes. Retiring it clears readiness, batches, pending requests and recording work. Cooperative instance/challenge exchange only correlates the generation; it is observable/imitable in the page world.
4. Register each outgoing action/capture/recording request before sending, pin frame/lifetime and deadline, and accept only one matching expected-kind response. Unknown, duplicate, expired, wrong-kind and retired results never reach transport or recording state.
5. After asynchronous rasterizer work, check the original lifetime before forwarding. Flush console/network with the original document metadata or cancel it on retirement.
6. Validate structured-clone input before spread/buffer/serialize/image allocation. Cycles/BigInt must not throw JSON refinements. Bound arrays, strings, numeric fields, cumulative buffers, resource-error rates and recording count/bytes.
7. Server pending-request resolution checks client/document/generation where available. Preserve canonical session rekey behavior. Register waiters before emitting requests.
8. Bridge grants no DorkOS credentials, operator identity, file/shell/tool authority or trusted verification status. Separate-world browser authenticity is outside scope.

Reviewer source evidence: `use-devtools-bridge.ts:394–398` frame checks; `:472–530` result forwarding; `:719–727` async frame reread; `:344–365` stale batch metadata; `:465–469` unvalidated arrays; `devtools-capture-store.ts:358–375` unsolicited latest screenshot update; `session-devtools.ts:114–117` request-ID-only resolution; `devtools-reads.ts:483–492` emit-before-waiter ordering. Revalidate line numbers before implementing/reviewing.

Required proof: production-shim real-browser adversary observes challenge and forges a report that remains labeled untrusted; legitimate round trips still work; sibling/wrong-origin rejected; navigation/reload/session switch during deferred import cannot send old work; cross-document batch identity cannot drift; unsolicited/duplicate/wrong-kind/expired responses do not mutate; malformed cyclic/oversized input cannot throw or exceed limits. Include server request-owner checks and canonical rekey positive control.

Only frame-rollout containment is a real DOR-2665 dependency. Do not blanket-block its schema/store work or merge this ticket into the managed-browser engine.

## DOR-2664: precise local caller authority

Current `POST /api/relay/messages` accepts a caller-selected `from`, refusing server-only principals. Current `isTurnShapingSender` honors human/system/bridge namespaces. For human HTTP sends, shaping reads `cwd`, `forAgent` and **`__bindingPermissions.permissionMode`**, defaulting permission mode to `default`; a top-level `permissionMode` is not the path demonstrated by current code.

Document actual authentication and browser-origin gates, then the residual local native-caller authority. Do not say every local process bypasses login when login is on. Explain desk/agent identity constraints and the distinction between a server-stamped tool sender and a caller-selected HTTP sender. Account requests are separately resolved by the host advisor; non-human payloads are not uniformly ignored in every field.

Delivery is a documentation scope in the Relay guide and API operation description with regenerated API docs. Do not add a speculative process allowlist or capability redesign silently. This is related work, not a blanket Doc Channel prerequisite.

## DOR-2666: durable observable Relay HTTP outcome

Current publish returns acceptance before `AdapterDelivery.deliverDetached` settles. Success is indexed only after adapter completion; failure is dead-lettered and optionally sent to `replyTo`. Capacity is configured, not always three. The existing SQLite index is derived/rebuildable, and Maildir-backed dead letters are durable. Existing publish-accounting rows are not proof of adapter completion.

IDEATE must settle a backward-compatible contract before implementation. Recommended direction to examine: retain current POST status/body fields, add an additive per-message status URL and a durable outcome record covering accepted/in-progress, completed, failed and outcome-unknown after interrupted delivery. A poll must never infer success from acceptance counts or a generic representative index row. Avoid destructive required-replyTo changes and implicit indefinite capacity waiting. Preserve current replyTo notifications.

Open implementation decisions for SPECIFY: exact durability store and retention, boot recovery of unsettled records, failure recording when DLQ storage itself fails, authorization parity with the send/list route, endpoint fanout representation, replay/rebuild semantics and what `completed` guarantees (runtime delivery completed, not application-level acknowledgement). No claim of exactly-once execution or automatic resend follows from a status handle.

Required proof: no-replyTo HTTP acceptance remains queryable while a controllable fake runtime is blocked; at-capacity refusal, thrown delivery and successful completion are observable after restart; interrupted accepted work becomes honest unknown/failed and never falsely completed; denied/unknown status access behaves correctly; existing HTTP clients and reply inboxes retain their contract. No live paid inference is needed.

This is related work; Doc Channel still owns its bounded durable outbox and explicit receipts.

## Current checkpoint

**Supporting closeout, 2026-10-03:** all six supporting issues are actually merged and Flow DONE. Owned implementation/review cleanup and both named140 return acknowledgements are complete. This three-document overview still needs its new reviewed PR and protected delivery. Broader Canvas, Relay, Doc and managed-browser parents remain open. The four-of-six preparation on 2026-10-02 was an earlier unshipped checkpoint.

This is the original preparatory source audit. Findings above describe the audited source at preparation time; they are not assertions that a merged fix is still absent.

DOR-2663 [PR2457](https://github.com/dork-labs/dorkos/pull/2457) merged as `d19d3ee73534dc9b69474bedffe9840db74ed931`; Flow DONE/readback is retained in primary programme custody. DOR-2660 [PR2459](https://github.com/dork-labs/dorkos/pull/2459) merged as `6b7309b9fc13d8580c890f707b839d5527277f0b`; Flow DONE/readback is complete. Namespace routing is released; its clean managed worktree was archived after ignored evidence was copied and hash-verified.

DOR-2661 PR2461 merged at 2026-10-02T02:43:13Z as `4d7fe3a082ec9fe1f92ae0b236f5537b84f9917c`. Flow DONE and completed/agent-completed readback are verified. All five source/test files match reviewed `306a5bec`, and all twelve merge-group workflows pass (25 successful checks, two skips). Its clean managed worktree is archived after 32 ignored evidence files were copied and hash-verified in the retained programme workspace.

DOR-2662 [PR2470](https://github.com/dork-labs/dorkos/pull/2470) merged as `6303271680cab557390c5f464c38910fc879022a` at 2026-10-02T14:54:55Z. All 52 owned files match reviewed head `74ac776a1da1353db905a35e880cdcbfcbf05ce4`. Flow DONE at 14:58:26.045Z, completed/agent-completed readback and run completion are verified. All 12 actual merge-group workflows passed (27 checks: 25 success, two skips). Owned author and reviewer checkouts were archived; both paths and Git registrations are absent. The source remote branch is absent; the reviewer checkout was detached. Named retained copy sets contain 1,033 author/queue originals, 110 reviewer originals and 34 final-delivery originals, with hash parity. These are copy-set counts, not directory totals.

DOR-2664 [PR2472](https://github.com/dork-labs/dorkos/pull/2472) merged as `bbfa433e05b621bf9d805b827066712a4be82183` at 2026-10-02T16:50:28Z. All five files match reviewed `d57e61502a3c6790e48766c1d2a6f889c29745da`. Flow DONE at 16:52:48.588Z and completed/agent-completed readback succeeded. Owned author and reviewer checkouts were archived; their paths and Git registrations are absent. Thirteen exporter tests and the normal affected verification remain attributed to the retained source-head evidence. This documentation delivery describes caller authority; it adds no authentication mechanism.

DOR-2666 [PR2494](https://github.com/dork-labs/dorkos/pull/2494) merged as `9984c87b784ddf99405426916bd406551b614618` at 2026-10-03T08:02:37Z, tree `70eb3ad47a6322676f8b6cb3c5cdc796c6892fad`. Independent full specification and distinct quality reviews approved pushed `34667e8e3e3508b987780cf286f115585b248a9a` with zero findings. All 57 owned paths match the protected candidate: 54 keep reviewed bytes; registry, API and Transport preserve the complete clean incoming union. All 12 exact-candidate workflows succeeded, with the full 27-job census retained, including six browser CI shards and four test shards. Flow DONE/run completion at 08:04:23.215Z and live completed/agent-completed readback for all six supporting items are recorded.

Receipt controls passed 358 tests in 16 files, including 20 real HTTP cases without skips. The three current-bound causal controls retain baseline/failure/restored proof. Normal verification on the composed250e source passed 61 quality tasks (seven cached) and 37 test/build tasks (three cached). Later main composition is attributed to the protected candidate, not that local run. These are fake-boundary/temp-SQLite/Core/Express/IPC controls and CI browser proof, not paid inference, personal login or native OS acceptance. The authoritative contract is in [the receipt specification](../../specs/relay-delivery-receipts/02-specification.md).

Receipt author and reviewer checkouts were archived as `01a100d4-c576-7eb3-a641-d80e5e63ab68` and `01a100d5-62e5-7523-af79-c6349112b48e`; both paths and Git registrations are absent. Owned abandoned remote/local branches were removed only after the recovery bundle and all six prerequisite main ancestors were verified. Recovery bundle SHA256 `63280bcc625964aa17ae62adb7d243a6517799a2205822515cbd435457722bb6` and retained evidence remain outside those checkouts. Primary and foreign worktrees were untouched.

Historical schema chronology: Doc budget [PR2466](https://github.com/dork-labs/dorkos/pull/2466) merged as `bfbc102fb219beff7ad452ef52844e13fdd49a79` at 2026-10-02T14:00:21Z. Its warning migration138 has tag `20261002045158_doc_batch_waiting_warning`, when1790916718758. The original receipt139 reservation/generation followed that checkpoint. Incoming approval139 later superseded it. The same two receipt tables were normally regenerated at140 and both owners ratified the actual tuple; old receipt139 proof remains historical, and incoming approval139 was preserved.

Current receipt tuple: index140, version6, when1790998275968, tag `20261003033115_relay_delivery_receipts`, breakpoints true. All three generated files retain reviewed bytes. Supporting root issued the named140 RETURN at 2026-10-03T08:18:11.117465Z after actual merge/DONE/owned cleanup. Doc ROOT acknowledged at 08:20:10.292540Z; programme acknowledged at 08:22:30.980327Z and confirmed both recipient acknowledgements. This returns only the named allocation. It does not globally unfreeze private Doc/Room/token DDL or complete Doc acceptance.

Closeout custody: primary `.dork/flow/evidence/DOR-2666-actual-merge-closeout`, `DOR-2666-actual-queue-proof` and `DOR-2666-actual-owned-cleanup`; named return records are in `DOR-2666-named140-return/root-issued-return.json`, `doc-acknowledgement.json` and `programme-acknowledgement.json`. These are retained root observations, not new execution by this overview author.

The merged DevTools hook publicly returns only `resourceErrorCount`, `notePersonNavigated()` and `noteFrameLoaded()`. It exposes no public generation or invalidation subscription and grants no Doc authority. The actual eight-source API handoff describes host ref/load/source/remount seams; future Doc-owned channel composition and runtime/mount acceptance remain separate and unaccepted. The bridge merge does not complete Doc task3.2 or activate Doc frames.

Three fenced source lanes remain authorized: Doc, browser and one bounded supporting implementation issue, with one writer per checkout. This separate metadata preparation does not claim an implementation issue or change global WIP policy. Parallel research/review and shared ignored Flow metadata writes are authorized. Private Doc implementation stays outside this lane.

Next: deliver the [final programme overview](../../plans/canvas-browser-delivery-20261001.md) through its new reviewed PR and protected queue. All six supporting issues are complete; broader Doc/browser/Canvas/Relay work remains open. Preserve the historical audit above. This authoring checkpoint is not yet shipped metadata.

Historical project pulses were Relay16/22 and Canvas23/29 on 2026-10-02; they are not current rollups. The retained 2026-10-03 Relay, Mesh & A2A pulse reports 30/34 terminal items: 18 completed and 12 canceled, with four open. Policy disposition is `skip`, reason verbatim `rollup-incomplete`, in advisory mode. Associated active specs are zero under the recorded matching rule. The installed adapter has no callable `completeProject` capability despite its prose contract, and no project close occurred. Six supporting deliveries do not close the broader Canvas, Relay, Doc or browser parents.
