# Document Channel Integration Guide

## Overview

Document channels correlate durable app inputs with current document authority and original runtime work. This guide describes the integration contract and its supported boundaries.

## Verification Scope

The sanitized native consumer and browser subjects have qualified saved-operation recovery, canonical restart, partial acknowledgement, correlated replies, and retained editing state. Focused server and client controls cover route approval, replay, writer and checkbox authority, and protected cross-target delivery. These results retain their tested source and layer; they are not a claim that one final whole-server verification launch passed.

Protected cross-agent Relay delivery currently supports Claude Code. Unsupported targets wait or expire under the existing policy. Session-owned MCP Apps support the Doc extension; Room-owned MCP Apps refuse it because their original source binding is unavailable. Personal database upgrades and production consumer migration are outside this verification. Release and shipment readiness remain separate.

## Key Files

| Concept                             | Location                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Closed public data schemas          | `packages/shared/src/canvas-channel-schemas.ts`                                                    |
| Physical frame identity             | `packages/shared/src/canvas-doc-frame-wire.ts`                                                     |
| Frame page interface                | `apps/server/src/services/canvas/doc-frame-shim.ts`                                                |
| Original document operations        | `apps/server/src/services/canvas/doc-channel/service.ts`                                           |
| Current native operation engine     | `apps/server/src/services/canvas/doc-channel/current/current-operation-engine.ts`                  |
| Original Room acquisition and start | `apps/server/src/services/canvas/doc-channel/operations/room-current-operation.ts`                 |
| Original due scheduler              | `apps/server/src/services/canvas/doc-channel/operations/room-due-scheduler.ts`                     |
| Sanitized consumer proof            | `apps/e2e/fixtures/doc-channel-consumer/` and `apps/e2e/tests/canvas/doc-channel-consumer.spec.ts` |
| Runtime contract                    | [Runtime authoring guide](adding-a-runtime.md)                                                     |
| Relay adapter lifecycle             | [Relay adapter guide](relay-adapters.md)                                                           |

## When to Use What

| Situation                                  | Mechanism                                                               | Evidence required                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Hosted page notifies a saved app operation | Real injected frame interface and original current HTTP owner           | Durable writer receipt plus exact channel acceptance                                                               |
| Unknown channel response                   | Inspect retained receipt for original ID                                | Current document identity and retained receipt, not a generic404                                                   |
| Runtime starts work                        | Original current operation engine and registered runtime                | Native acquisition, preparation, commit, and first-start boundary                                                  |
| Runtime completes                          | Original producer's observed stream                                     | Exact source/batch/generation correlation                                                                          |
| App handles input                          | Original downstream `app.ack`                                           | Exact selected `eventIds`; completion alone is insufficient                                                        |
| Toggle and Undo avoid a turn               | Original writer witness with active canonical lease and native pair CAS | Both durable receipts, current physical baseline, pair-only batches, no commit/start/spend                         |
| Standalone client                          | Dedicated bearer authority and bounded fetch stream                     | Current document-only authority and atomic filtered cutover; qualified native HTTP and standalone browser subjects |

## Core Patterns

### Keep acknowledgement state separate

This complete pure reducer illustrates UI state only. It creates no server authority or dispatch receipt.

```typescript
export type OperationState = {
  operationId: string;
  fileSaved: boolean;
  notificationRecorded: boolean;
  runtimeCompleted: boolean;
  appOutcome?: 'handled' | 'rejected';
};

export function applyAcknowledgement(
  operations: readonly OperationState[],
  ack: { eventIds: readonly string[]; outcome: 'handled' | 'rejected' }
): OperationState[] {
  const selected = new Set(ack.eventIds);
  return operations.map((operation) =>
    selected.has(operation.operationId) ? { ...operation, appOutcome: ack.outcome } : operation
  );
}
```

Parse the entire original downstream envelope before calling a reducer. Never filter malformed IDs into an apparently valid partial acknowledgement.

### Preserve original owners

The same opened physical Db must own the store, authorization, grants, principals, and native Room construction. Register the actual returned RoomService before actor resolution or mounted routes. Invoke the captured native, file-writer, checkbox-writer, and due-scheduler stops before awaiting their joins. Attempt every independent cancellation and preserve the first raw cause. Close the owning Db and remove the temporary root only after positive drains; retain them when closure is uncertain. Clear singleton pointers only when they still equal that exact owner.

Current producer diagnostics use `readServiceOriginalRoomScenarioEvidence(service, documentId, batchId, generation)`. Derive the tuple from the original retained delivery and store batch. The returned count describes the provider boundary only; missing evidence is UNKNOWN. It cannot issue an actor, prove a current grant, or replace a native start receipt.

### Read with the exact token scope

All paths below are relative to `/api/canvas/token/docs/:id`. They require the same bearer header and omit cookies.

| Method and path                  | Purpose                      | Bound                                                                            |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `POST /events`                   | Submit public upstream input | Authenticate before parsing; 16 KiB body limit.                                  |
| `GET /channel?since=0&limit=200` | Replay authorized events     | Limit 1–200; native type/direction filters precede the limit.                    |
| `GET /events/:eventId`           | Inspect one authorized event | Filtered, missing, or pruned data is unconfirmed, not proof of document absence. |
| `GET /stream?since=0`            | Fetch-based event stream     | `doc.event` frames use `docSeq`; `reset` gives the retention boundary.           |
| `OPTIONS` on the same leaves     | Browser preflight            | Authorization and Content-Type headers; no credentials.                          |

Authorized bearer responses allow cross-origin access without credentials. Host and DNS-rebinding guards still apply. Every actual stream frame repeats current expiry, revocation, source, grant, and permission checks. Reset and event writes both obey response backpressure. Disconnect closes the exact owned stream.

The ordinary operator route `POST /api/canvas/docs/:id/tokens/:tokenId/revoke` retains normal host/session authority. It rejects bearer authority. The current operator source also exposes `POST /api/canvas/docs/:id/tokens`, accepting `{ request, approvedGrantIds }`. The request document ID must match the path, approved grant IDs must be unique, and the original operator/native issuance gate rechecks current authority. It returns the secret once with token metadata. A document bearer cannot mint or revoke tokens, and issuance does not create a route grant. These authenticated operator routes are distinct from the bearer CORS surface. The original controls browser qualified token mint, ephemeral reveal/clear, and genuine revocation.

## Reserved editor and state boundaries

The injected page interface exposes `status`, `emit`, `on`, and read-only `state`. Public `emit` refuses `doc.*`, `state.*`, `selection.ask`, `md.task.toggled`, `event.status`, and `app.ack`. Do not document a file save or selection as a public page emit. The dedicated authenticated editor selection and document-save paths are integrated in source. Their original browser subjects passed. Checkbox subjects separately preserve inverse Undo and the draft, selection, focus, scroll, and earlier Undo across a held acknowledgement. Neither permits an ordinary page to emit reserved events.

### Authenticated editor selection

`Transport.askCanvasDocSelection(request)` calls `POST /api/canvas/docs/:id/editor/selection`. The strict request contains `documentId`, `expectedGeneration`, stable `eventId`, `expectedFileHash`, `sourceGeneration`, ordered nonoverlapping UTF-16 `ranges`, and `selectedText`. There must be 1–32 ranges; each end exceeds its start. Selected text is untrusted context, bounded to 8 KiB UTF-8 within the existing 16 KiB JSON request cap.

The original native source supplies the canonical selected slices. The server repeats current source, file hash, generation, range, and operator checks. A recorded receipt does not prove agent delivery. Delivery requires the actual declaration and approved `selection.ask` route; admission, FIRST, and application acknowledgement remain separate.

### Document-bound ordinary saves

The existing `Transport.writeFile(cwd, path, content, options)` accepts `options.documentSave: { documentId, expectedGeneration, eventId, expectedFileHash }`. Existing file baseline fields and the 1 MiB body cap remain. The editor captures generation from original management metadata before the first write; it never silently falls back to a generic save for a document-bound file.

Only the original writer's changed, read-back, closed save can complete `doc.saved`. A changed result requires a recorded document receipt. A no-op emits nothing; identical operation recovery may return a duplicate receipt. Conflict and failed completion create no replacement event.

Filesystem change and SQLite event storage are not atomic. The file may change before notification storage fails. On an unknown result, the UI retains the exact old baseline, content, generation, and operation ID. **Retry original save** repeats that operation. If no receipt committed, the old-baseline retry can conflict with the changed file; it must not fabricate a saved event. Newer queued drafts remain unsaved until an explicit later save, and checkbox writes stay blocked while the original save is unconfirmed.

### Explicit expired-batch review

`Transport.replayCanvasDocBatch({ documentId, expectedGeneration, eventId, batchId, expectedBatchGeneration, grantId })` calls `POST /api/canvas/docs/:id/manage/replay`. The UI offers it only for an actual `replayAvailable` candidate after explicit review. That flag is display DATA; the server repeats fresh original actor, source, grant, transport, and complete retained-input checks.

The original engine permits only expired, never-admitted session or genuine native Room batches. Acknowledgement, admission, consumption, and uncertainty evidence refuse replay. One stable operation creates one new batch generation while retaining original input IDs; an identical retry returns the existing operation. Original backlog, reservation, physical-source, and final SQL gates still apply. A pending or duplicate response is not FIRST, completion, or `app.ack`.

Native checkbox receipts confirm the writer effect under the original source/version guards. Event acceptance, native admission/start, runtime completion, and selected `app.ack` remain distinct. The current MCP capability names are `ui.send_canvas_event` / `canvas_send` and `ui.patch_canvas_state` / `canvas_patch_state`; an ordinary tool caller cannot manufacture the original Room responder authority.

State patches use stable `eventId`, `expectedStateRev`, and only `set`/`remove` operations. The `{ receipt, stateRev }` result does not prove UI rendering. Hosted bound state comes from the original authorized scope stream (`canvas_channel_snapshot` and live document notifications), not a synthetic HTTP response or an app-supplied snapshot. A retention reset must be observed for the exact document/scope; reconnect requires positive old-connection closure and new-connection delivery while retaining the mounted draft.

The standalone token stream instead emits filtered `doc.event` rows and a `reset` carrying only document ID, retention floor, and high watermark. It exposes neither full state/routing snapshots nor private viewer identities. A bearer acceptance receipt cannot stand in for an app acknowledgement, and a token reset cannot stand in for a widget state snapshot.

## Anti-Patterns

| Avoid                                                                         | Use instead                                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ❌ Build `window.dorkos` inside a test                                        | ✅ Drive the real preview/frame host and host-owned handshake                             |
| ❌ Count a stored acceptance as a started turn                                | ✅ Observe original native commit/first-start and producer output separately              |
| ❌ Turn absent scenario evidence into0                                        | ✅ Keep UNKNOWN until the original tuple yields evidence                                  |
| ❌ Replay or resend uncertain admitted work automatically                     | ✅ Inspect its original retained receipt under current document identity                  |
| ❌ Restore a principal from persisted data or a runtime type string           | ✅ Use the genuine constructor-owned principal/acquisition lane                           |
| ❌ Cancel mixed comment/toggle work because the checkbox returned to baseline | ✅ Require exact pair-only batches, both affected deliveries, and native cancellation CAS |
| ❌ Give Relay transport ownership of app retries                              | ✅ Retain one dispatch owner and the original operation ID                                |

## Integration Procedure

1. Start with a sanitized temporary vault and a fixed paid-safe TestMode runtime. Do not inherit provider credentials or a personal home.
2. Record stable operation ID, canonical request hash, one physical file effect, distinct writer receipt, and pending handoff before success.
3. Use genuine current document access and the original frame/HTTP/native assembly. Preserve birth and canonical owning scope through held awaits.
4. Observe exact writer effects, retained events, batch identities, original starts, completion, and selected acknowledgements. Each proves a different fact.
5. Retire every owned listener, stream, scheduler, child, and database. Memoize retirement before callbacks. Attempt cleanup peers and preserve the first raw cause, including `undefined`.
6. Run targeted, type, lint, browser, visual, and aggregate checks only in the coordinated validation window. A source packet or passing collection is not execution acceptance.

The consumer proof must include lost writer response/retry, save-before-ingest reload, busy accepted-unclaimed restart, canonical owning-target continuation, exact partial acknowledgements, correlated replies, and zero duplicate dispatch. Retention reset, revocation, reconnect, and downstream replay must preserve the iframe, focused draft, caret, selection, scroll, Undo, and unseen indicators.

Repeat these subjects through native checkbox, permission-bound MCP app extensions, standalone fetch-SSE, and bound widgets. MCP extension permission must match the hosting document/generation and source; `tools/call` remains refused. Standalone expiry/revocation must be checked before each write and after held awaits. Token data must never enter URL/log/content/state/storage, scope snapshots, or private viewer identities.

## Recovery Boundaries

| Observation                                       | What must remain explicit                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A page closes before acceptance                   | Its in-memory notification queue can be lost; recover from durable writer handoff                              |
| A write response disappears after replacement     | Inspect retained writer evidence; do not repeat a physical effect                                              |
| A retained receipt is outside the retention floor | Absence cannot justify automatic repeat                                                                        |
| An accepted batch changes canonical owner         | Preserve original IDs and receipt through the existing atomic lifecycle rebind; quarantine unsafe claimed work |
| A bearer document source or grant changes         | Refuse stale token authority; issue a new token after current approval. Applied alias DATA is not authority    |
| A cleanup callback throws                         | Drain independent peers and retain the original first raw cause                                                |
| An external editor changes the subject            | Refuse stale baseline; a prior file check does not eliminate external-editor races                             |

Token schema inputs and exports must remain in the normal DB generator configuration. Generate migrations through the original journal; never add fixture-only DDL or select a migration index manually. Keep native scope, HTTP, revoke, and manifest-close controls in integrated validation. Retain the exact source and subject for each result; a focused result does not establish a different host or deployment.

The generic outward-action cap is a separate unresolved boundary. Signed webhook regression belongs to DOR-2661; no Doc Channel test claims it fixed. The independent DOR-2660–2664/2666 changes retain their own receipts and gates. No fixture proves that a personal or production LifeOS consumer has migrated.
