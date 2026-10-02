# Doc Channel source audit and ticket triage

## Current reconciliation — 2026-10-01

Rechecked against pinned worktree source
`996161118a84f938fe76b6e569ba077dfb7a574a` by read-only server and consumer
investigation subagents. The current specification adds these requirements:

- Extend existing `services/session/private-messages/acceptance.ts` and
  `packages/db/src/schema/session/message-acceptance.ts` with one typed document
  batch source and independent composition-root registration. Preserve the two
  existing Connections sources and their exact authority checks.
- `session-event-normalizer.ts` emits projected turn_start before runtime output;
  that receipt is DorkOS dispatch evidence, not backend admission. Boot recovery
  quarantines previous dispatching/turn_started attempts as outcome_unknown;
  Doc Channel exposes in_doubt and never automatically repeats them.
- `canvas/index.ts` observes rekey best-effort; canonical session resolution and
  channel ownership need recoverable guarded moves, not an assumed cross-runtime
  transaction. Existing removal hooks run post-delete; channel closure must
  become transactional before physical deletion.
- Structured `doc_events` additional context must cross the closed kind union,
  prepared-message/dispatch/assembler seams and all runtime renderers.
- Reference consumer strips SDK UUIDs, generates writer IDs and runs independent
  notifier/AckWatcher loops. Migration requires stable operation IDs, a durable
  writer-to-channel handoff and disabled legacy dispatch for migrated operations.
- File writes and channel notifications have separate receipts. Native checkbox
  write intents release routable events only after verified mutation evidence.
  Ordinary server saves and checkbox operations share canonical-path coordination.

These are source findings, not runtime verification. Detailed contracts and
proof subjects are in 02-specification.md; original evidence follows below.

## Historical audit

Checked 2026-10-01 against checkout
`b7cf9de4eed9b5674826a1f23b1eaf912c0e1200`. Existing `.dork/agent.json` edits were
present before this work and were left untouched. Evidence below is source
inspection unless explicitly described otherwise; it is not a production exploit
reproduction or an installed-build verification.

Read DOR-2660 through DOR-2666, including comments, through Composio's personal
account. All seven were in Triage; all returned empty comment lists. DOR-2665
belongs to Canvas and Browser in Rooms. No Linear write was attempted during the
initial source audit. The subsequent approved project reopening and Flow routing
assessment are recorded in [00-flow-routing.md](./00-flow-routing.md).

## Findings

| Ticket / claim                                       | Current evidence                                                                                                                                                                                                                                                               | Verdict and next proof                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOR-2660 — webhook captures agent subjects           | `packages/relay/src/adapters/webhook/webhook-adapter.ts:204` derives its prefix from the inbound subject; `packages/relay/src/adapter-registry.ts:207` uses `startsWith`.                                                                                                      | Still present by inspection. Reserve webhook-owned subjects at validation and registration; migrate existing invalid configurations with a visible refusal. Test `id` versus `id2`, exact segments, trailing-dot namespace prefixes, and broader overlapping prefixes. Restricting creation alone leaves existing persisted configurations unsafe.              |
| DOR-2661 — JSON breaks webhook signatures            | `apps/server/src/app.ts:286` mounts global JSON parsing; `apps/server/src/routes/relay-adapters.ts:764` declares raw parsing later and `:779` casts `req.body` to Buffer. `webhook-adapter.ts:539` uses `rawBody.toString()`.                                                  | Parser-order defect remains by inspection. Correction: the code does not re-serialize JSON; an object becomes `[object Object]` when signing. A real full-app request with signed whitespace-preserving JSON is still required before calling it reproduced. Route-only mocks cannot prove it.                                                                  |
| DOR-2662 — bridge messages can be forged             | `apps/client/src/layers/features/canvas/model/use-devtools-bridge.ts:394` checks source/origin; `:402` checks protocol marker. `devtools-inject.ts:21` constructs a static inline script, without per-mount identity.                                                          | Present. Rotate a host-bound generation on mount/navigation, reject stale responses, bind requests to that generation. Correction: inline text, page message listeners and same-realm interception make a closure nonce insufficient against malicious page scripts. Captures remain page-origin evidence.                                                      |
| DOR-2663 — top-level served HTML lacks sandbox       | `apps/server/src/routes/workbench-serve.ts:264` sets content type, nosniff, cache and referrer headers, without a CSP sandbox.                                                                                                                                                 | Present. Response CSP must omit `allow-same-origin` but retain the tested functional sandbox tokens, including `allow-scripts` for instrumentation. Bare `sandbox` disables all scripts. Test top-level opening, API reads/writes and normal iframe rendering. Account for HTML/SVG and all document responses; preview-origin traffic is a separate surface.   |
| DOR-2664 — HTTP caller selects a human sender        | `packages/relay/src/adapters/claude-code/agent-handler.ts:259` identifies turn-shaping senders; `:356` selects shaping payload; `:393` reads permissions from `__bindingPermissions.permissionMode`. `routes/relay.ts` passes caller-selected `from` to publish.               | Deliberate trust boundary remains. Correct path is in `packages/relay`, not `apps/server/services/runtimes`. A top-level `permissionMode` alone is not the demonstrated mechanism. Document exact authority and evaluate capability-based sender identity. An Origin check alone cannot constrain native local processes and cannot identify every opaque page. |
| DOR-2666 — successful HTTP acceptance may fail later | `apps/server/src/routes/relay.ts:256` explains detached acceptance; `packages/relay/src/adapters/claude-code/claude-code-adapter.ts:793` only permits capacity waiting when `context.onHeld` exists. `packages/relay/src/adapter-delivery.ts` owns detached failure reporting. | Present. Capacity is configured (`maxConcurrent`), not invariably three. Doc Channel needs persistent batch status and completion/failure callbacks; spoofing a bridged-human wait callback is not an acceptable fix. Keep the broader relay HTTP status contract in its own ticket.                                                                            |
| Widgets refuse while busy                            | `apps/server/src/routes/session-ui-action-handler.ts:96` dispatches with `whenBusy:'refuse'`; `:125` returns 409, `:135` returns 202.                                                                                                                                          | Confirmed. The comment explains intentional stale-action prevention. Do not silently change every existing inline widget action into a durable queued action.                                                                                                                                                                                                   |
| Whole-document downstream only                       | `apps/server/src/services/canvas/canvas-service.ts:126` defines `CanvasFrame`; `packages/shared/src/session-stream.ts:854` carries `canvas`. Room streams have the analogous schema.                                                                                           | Confirmed. Channel events need a new discriminant and separate sequence; retain content edit protection. The server can refuse an edit-held write, so the source's blanket “held behind a banner” description is too broad.                                                                                                                                     |
| Existing scope WebSockets can carry events           | `services/canvas/session-channel.ts:35` feeds a projector; `services/core/streams/session-stream-delivery.ts` and `room-stream-delivery.ts` share stream delivery for transports. Room reconnect resends canvas state.                                                         | Partly correct. Implement once in shared stream delivery/projectors and support SSE and WebSockets. Room entry cursors and session projector cursors cannot serve as document-log cursors. An idle session without a projector needs replay from the channel log.                                                                                               |
| MCP apps refuse tools                                | `apps/client/src/layers/features/mcp-apps/model/bridge.ts:141` explicitly refuses `tools/call`.                                                                                                                                                                                | Confirmed. Add a namespaced DorkOS extension and advertise it; do not claim a new standard MCP Apps method or enable tools/call.                                                                                                                                                                                                                                |
| Serve isolation, token TTL, preview methods          | `features/canvas/lib/browser-url.ts` distinguishes isolated serve from external/preview sandbox; `services/workbench-serve/token.ts` uses `WORKBENCH.SIGNED_URL_TTL_MS`; preview listener/proxy owns per-port serving.                                                         | The architecture matches the handoff: serve is opaque, preview keeps its separate origin. Channel readiness requires successful instrumentation; direct fallback and CSP-blocked injection must show offline. A serving token is not a channel grant.                                                                                                           |
| Room entries are operator-authored via HTTP          | `apps/server/src/routes/rooms.ts:388` resolves caller before posting; `services/rooms/room-capabilities.ts:351` resolves verified agents before humans.                                                                                                                        | Qualify the original claim: an unauthenticated local fallback can be the operator; verified agent capability calls have another author. Never use an operator HTTP fallback for app events or this report.                                                                                                                                                      |

## Prioritization and fences

1. DOR-2663 and DOR-2660: independent containment fixes, each with regression
   proof. DOR-2663 blocks enabling channels in served documents.
2. DOR-2662: correct its threat model first; generation binding blocks stale and
   cross-frame traffic but cannot make same-page observations authoritative.
   Coordinate its handshake with channel instrumentation to avoid two lifecycle
   owners. Keep protocol keys separate.
3. DOR-2661: add a real full-app HMAC regression before changing parser order.
4. DOR-2665: this specification, then decomposition and independent implementation
   review. Queue/status semantics are mandatory in v1.
5. DOR-2664 and DOR-2666: separate HTTP trust and receipt-contract work. The channel
   must neither depend on caller-chosen human identity nor assume HTTP acceptance
   means completion.

## Related design disagreements

- Revision 2 permits self/log grants without a card, while conventions treat
  general routing as operator-ledger data. Limit that exception to verified
  opener → same owning agent within this document's existing scope; no global
  routing table write, cross-room route or permission increase follows from it.
- `doc:<id>` is not an existing room author kind. Keep a typed app-event entry
  attributed to a server-owned system author, with document provenance, and teach
  the room trigger path about authorized channel batches. Do not add an arbitrary
  new author-kind string or post a human-looking text entry.
- Grant UI was deferred to v2, but other-agent/room routes need an approval path
  before they can run. v1 uses existing approval cards and explicit grant
  capabilities; header controls are the deferred convenience.
- Generic “tick plus undo cancels” requires authoritative old state. Keep last
  desired state for generic coalescing; cancel only the typed checkbox operation
  when its verified baseline equals the final state.

## Report prepared for #dorkos

The authorized destination is local room `01M2JFKMZJCCNQ44EKCKRKEK64` (#dorkos),
resolved with a read-only room listing. No verified DorkOS agent credential is
available in this Codex chat. The local HTTP fallback would post as the operator,
so no report was sent through it. Send the following once through an authenticated
agent `post_to_room` capability when that identity is available:

> DOR-2665 now has a local SPECIFY artifact at specs/doc-channel/02-specification.md
> with source audit at 04-source-audit.md. Revision 2 is folded in. Corrections:
> the shared streams support SSE and WebSockets; a same-page nonce cannot prove
> shim authorship; relay's agent conversation is not the open canvas session;
> busy delivery needs durable outbox receipts; and granted app events need a
> narrow amendment to the no-turn-on-canvas-change ADR. The six related tickets
> remain supported by source inspection; DOR-2661 still needs a full-app signed
> JSON reproduction. The dashboard already retries and resends unacknowledged
> events, and its v0 writer does not preserve SDK envelope IDs. No production
> code or Linear state changed. Next: review the proposed ADRs and decompose v1.
