# Canvas and Relay supporting lane preflight

Prepared 2026-10-01. Preparatory source audit, not a frozen specification or canonical DECOMPOSE task list. DOR-2663 is merged and Flow DONE. DOR-2660 is claimed for bounded source work in its own worktree; the historical source findings below remain investigation pointers.

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

DOR-2663 source work is complete; worker evidence is in `../served-document-isolation/04-implementation.md`. Independent pushed-head review and delivery remain pending. Its next implementation slot is yielded to Doc foundation; coordinate before another source claim. Bridge and receipt drafts are in isolated worktrees undergoing design review. Other source scopes remain unclaimed.

All six were routed/triaged through the resolved Linear adapter. Shared ignored metadata and direct-assignment advancement are authorized, resolving initial WIP/store questions. Two principal implementation scopes run at once; research/review can run in parallel.

Doc owns private-session acceptance changes. Relay receipts remain a distinct outcome store. Frame rollout waits isolation merge and bridge contract; Relay routing waits namespace fix. Other supporting work is not a blanket prerequisite.

Explicit human shipping authority permits normal queue entry after truthful exact-pushed-head independent review and Flow REVIEW. Preserve forge checks, verify merge, then Flow DONE. Never impersonate a person or fabricate reviewer tokens/calibration.

Next: fresh verification, review and isolation delivery; converge bridge/receipt designs. No issue is merged or DONE yet.
