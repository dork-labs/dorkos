---
slug: terminal-request-admission
number: 260928-130908
created: 2026-09-28
status: specified
---

# Terminal request admission and exclusive reset/restart ownership

**Status:** Specified — design only; implementation not selected
**Author:** Codex
**Date:** 2026-09-28
**Work item:** DOR-2481
**Audit base:** `f8df106324d29a2199bb07e2a1102a0b75df9de1`

## Overview

Stop new main-listener work once termination begins, and reserve reset, restart or signal stop for exactly one owner. The owner must cover acknowledgment, cleanup and the eventual terminal action, rather than sharing cleanup while leaving competing continuations free to delete or restart.

This specification separates a deployable admission-only change from the later exclusive terminal-action change. The latter depends on DOR-2482 deciding when cleanup outcomes permit database closure, deletion, lock release and successor launch. This document does not implement or certify that policy.

## Background / Problem Statement

At the audit base, reset and restart each return 200, then queue an independent `setImmediate` callback (`routes/admin.ts:276–299`). Reset invokes cleanup, closes the database and removes the data directory; both callbacks restart even after failure. Signals use a separate boolean (`index.ts:5704–5715`) and can exit while an accepted reset is still deleting. A shared cleanup promise does not serialize those later effects.

The main server is local to startup (`index.ts:5339`), and cleanup does not stop new HTTP or upgrade admission. Better Auth and signed webhooks run before ordinary API authentication; upgrades bypass Express entirely. DOR-2429 already gives the workspace reconciler a sticky, bounded lifetime. It does not make the rest of the server quiescent.

## Goals

1. Define the exact admission instant and refusal behavior for every main-listener request and upgrade.
2. Preserve the accepted admin acknowledgment while assigning one terminal operation synchronously.
3. Specify competing requests/signals, client disconnect, synchronous failure, rejected cleanup and hanging cleanup without duplicate effects.
4. Choose an explicit active-work contract and name what further evidence destructive handoff requires.
5. Provide acceptance tests and a smallest safe implementation sequence, with no production change in this design PR.

## Non-Goals

- All-process writer fencing, generic cancellation, aggregate shutdown budgets or cleanup error continuation.
- Database closure, lock release, safe reset deletion or successor readiness policy (DOR-2482).
- General startup rollback (DOR-2483), retention sweep ownership (DOR-2484), Cloud/Community contracts, runtime SDK behavior, desktop IPC lifecycle, CI changes or paid/live tests.
- A health/status endpoint that remains available during termination, or an operation queue/retry API.

## Technical Dependencies

Use the existing Express 5, Node HTTP and `ws` stack; no new package, flag or persistent schema. Existing security policies and supervisor refusal remain authoritative while running. ADR-0264 makes turns independent of POST completion, so HTTP drain cannot serve as turn drain.

DOR-2482 is **not a blocker for writing or merging this design**, or for the narrow admission-only implementation. It is a required design input before production adoption of exclusive reset/delete/successor actions. Do not mark that separate issue complete, ready or claimed as a side effect of this work.

## Detailed Design

### 1. Inventory and precise coverage

| Surface                                                                             | Future main admission gate                                         | Existing work after the boundary                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Main API, health, auth and signed webhooks                                          | Gate every HTTP method/path before body parsing or domain dispatch | Already-admitted handlers may finish or remain pending.     |
| Main `/mcp`, `/a2a`, agent cards, static assets and later mounts                    | Same app-wide gate; no path allowlist                              | Their already-started operations are not cancelled.         |
| Main SSE endpoints                                                                  | Reject new subscription requests                                   | Existing streams retain their existing cleanup behavior.    |
| Main WebSocket streams and terminal                                                 | Check upgrade entry and final acceptance                           | Existing sockets and commands are not drained by this gate. |
| Connector-runtime MCP loopback server                                               | Excluded: distinct listener (`index.ts:5162`)                      | DOR-2482/domain inventory must account for its work.        |
| Preview HTTP/WebSocket listeners                                                    | Excluded: distinct servers, existing preview cleanup unchanged     | Closing previews is not closing main ingress.               |
| Test fixture listener, background tasks, Relay, detached turns and in-process tools | Excluded producers                                                 | Need their own stop/drain or generation-fence evidence.     |

Desktop and remote clients using the main listener inherit the main gate. The desktop supervisor still owns its lifecycle. Managed remote-listener isolation proposed by the Cloud owner is not added to this slice.

### 2. Sticky main admission

Create one passive `MainRequestAdmission` instance at root scope, before startup can await. Inject the same object into `createApp` and `attachUpgradeRouter`. `close()` flips a monotonic state synchronously, is idempotent, and never reopens. Tests may construct a fresh instance; production must not recreate one after closure.

Install the Express gate first, before CORS, first-contact callbacks, host/auth handlers, signed ingress and parsers. While open it simply calls `next()` and preserves all existing downstream security behavior. Admission occurs at this check, not at TCP accept, body completion or route invocation. Each keep-alive request is checked separately.

Once closed, every new HTTP request receives a generic 503 JSON response with stable code `SERVER_STOPPING`, `Cache-Control: no-store`, `Connection: close` and `X-Content-Type-Options: nosniff`. Suggested message: “The server is stopping. Try again after it restarts.” Do not expose the chosen operation, paths, user identity or cleanup failure. No `Retry-After` promise: a stop may have no successor. OPTIONS and health have no terminal exemption; cross-origin callers may see a network error because the refusal precedes CORS. Running-state CORS and authentication remain unchanged.

An HTTP request that passed this gate before closure is admitted even if later waiting in auth or body parsing. It may still reach a route. Admin must therefore independently check terminal ownership after validation prerequisites and before consuming a token or reserving an action. An admission check is not a general downstream write fence.

At upgrade entry, reject a closed gate using a plain 503 handshake refusal and destroy/end the unaccepted socket through the existing refusal helper. Do not perform an upgrade just to send a close frame during termination. After asynchronous credential and route authorization settles, check the same gate again immediately before **any** `handleUpgrade`, including a close-frame refusal. A pending authorization is not an admitted WebSocket. On closure, do not invoke its `open` callback. An upgrade already accepted before closure remains outside this gate's drain contract. Running-state origin, authentication, route claims and close-frame semantics are unchanged.

### 3. Admission-only root wiring and late startup

At the first synchronous statements of ordinary cleanup and startup-error cleanup, close main admission, then invoke the existing workspace disposal in the same turn before any unrelated await. Keep the existing workspace disposal outcome/error behavior and its five-second deadline. No listener drain or acknowledgment wait may move workspace fencing behind a potentially hanging operation.

Late app construction and upgrade attachment receive the already-closed instance. Check closure immediately before the main `app.listen` call so startup resumed after a terminal signal cannot open a new main listener. A narrowly owned listener registration handles the race where listening was already initiated: record the main server as soon as created, and request its close if terminal before/on listening. Do not treat the close callback as a barrier or wait for it before workspace disposal. Suppress that listener callback's startup announcements/registrations when terminal. This is a main-listener guard, not a retrofit of rollback or late-acquisition handling across all startup services; DOR-2483 owns that wider work.

For an already-listening server the admission-only slice may keep it bound and return 503 until the existing terminal path exits. It must not introduce active socket destruction or await `server.close()`; the complete connection disposal policy belongs with DOR-2482. The late-listener closure above only prevents a listener acquired after terminal state from becoming a serving resource.

### 4. One terminal-operation owner

The later production slice adds one passive root-owned `TerminalOperationOwner`, shared by admin and signals and holding the same admission instance:

`open → reserved(kind) → running → completed | failed`

Kinds are `reset`, `restart`, `stop`. Reserve and close admission synchronously; store one operation identity and one stable completion promise before scheduling or awaiting. Terminal states stay terminal. Do not queue, replace, upgrade, downgrade or retry a request. Completion is an observed operation result, not a claim that a replacement process is ready.

Admin retains all existing desktop refusal, host/session security, body validation and rate limiting. In an already-admitted handler, check owner availability before token consumption; for reset, check availability, consume the valid single-use token and reserve in one synchronous turn with no await. Invalid confirmation/token must never close admission. A competitor that reaches admin after another reservation and passes the preceding desktop, rate-limit and body-validation controls gets 409 `TERMINAL_OPERATION_IN_PROGRESS`, schedules zero effects and does not consume its reset token. Those preceding controls retain their 409/429/400 refusals; terminal ownership is checked before consuming a reset token. A request that reaches the closed app gate gets the generic 503 instead; do not add a special admin-path bypass to manufacture 409. Reset preparation admitted earlier must recheck ownership before minting. Desktop refusal still precedes router rate limiting and reservation; in terminal state the outer generic gate may respond first.

The accepted request keeps the existing 200 acknowledgment shape. Register the one-shot continuation before sending it; hand the response to `res.end`/`json` locally, then schedule the winner once. Do not wait indefinitely for a network `finish` event or assert delivery to the client. A synchronous response write failure or connection abort does not release a valid reservation; schedule the same winner once and observe errors. Invalid/unaccepted requests retain no operation. Duplicate callback delivery cannot run the chain twice.

A first signal reserves `stop` and begins its chain without an HTTP acknowledgment. A signal arriving during reserved/running/completed/failed admin work observes the existing outcome and cannot independently exit, spawn or alter the winner's kind. Repeated signals have no “force exit” escalation in this protocol; OS-level forced termination remains outside its guarantees.

Only the winning operation may invoke the authorized cleanup/action chain. Memoizing `shutdownServices` while retaining independent admin callbacks is forbidden. Admin dependencies become a request/reserve interface to the root owner; raw cleanup, database close, filesystem deletion, spawn and exit no longer remain independently callable terminal continuations there. Keep low-level effects injectable for tests and confined to existing architecture boundaries.

### 5. Failure and DOR-2482 handoff dependency

Capture synchronous throws and promise rejections into the winner's retained failed result, log once, and attach rejection observation immediately. Never reopen admission or start a second chain. A never-settling closer leaves the operation running and competitors refused; this spec invents no global timeout or forced action. A timeout race is not evidence of cancellation.

The future owner requires DOR-2482's explicit per-operation permission to proceed beyond cleanup. The contract must distinguish an authorized handoff from failed/unfinished cleanup; absent authorization, **no database close, directory deletion, lock release or successor action may be inferred from a resolved `Promise<void>`**. Because today's cleanup releases the lock internally and admin restarts after errors, merely wrapping those functions cannot meet that contract. Do not ship the full exclusive destructive chain until DOR-2482 resolves and tests this seam. Preserve the current code in this design PR, rather than hiding a behavior change behind a new wrapper.

DOR-2482 must provide concrete answers for finite admitted handlers, existing SSE/WS, detached turns, separate listeners and background writers. For each, choose await completion, cooperative cancellation with observed completion, or a proven late-write fence; specify deadline/failure behavior and database/lock ordering. HTTP response `finish`/`close`, an empty socket set or main-listener closure cannot certify these outcomes. The accepted terminal admin request must be excluded from any future self-drain wait so it cannot wait for its own terminal operation.

### 6. Active-request contract selected here

**Admission-only phase:** allow previously admitted work to proceed under existing behavior; do not cancel, destroy, count response completion as work completion, or wait for it before the workspace fence. This deliberately adds no all-writer safety claim and changes no existing reset deletion policy. Tests must demonstrate a held admitted request/stream survives admission closure, and a later request is refused.

**Full terminal-action phase:** no destructive handoff until DOR-2482's explicit completion/fence conditions hold. This is a dependency, not a fake drain implemented with `server.close()` or a guessed grace period. No default deadline is chosen in DOR-2481 because it would decide DOR-2482's failure policy without its evidence.

### 7. Suggested file boundaries

- `services/core/lifecycle/main-request-admission.ts`: passive sticky state, no effects.
- `middleware/terminal-admission.ts`: HTTP refusal, shared state injection.
- Existing `services/core/streams/upgrade-router.ts`: entry/final checks around the actual upgrade seam.
- `index.ts` and `app.ts`: one owner and narrow listener registration/wiring.
- Later `services/core/lifecycle/terminal-operation-owner.ts` plus `routes/admin.ts`: exclusive operation protocol after the DOR-2482 contract is ready.

These are proposed locations, not new files in this design PR. Do not commit unused helper implementations between phases. No public config, persistence or runtime SDK API changes are needed.

## User Experience

One valid reset or restart receives the existing acknowledgment. Competing actions receive an error instead of claiming another restart was accepted. A terminating server stops accepting new work; existing clients may see a 503 or a connection error and reconnect through their existing behavior. Do not report a reset as completed merely because it was accepted. Desktop-managed refusals and the reset confirmation/token ceremony remain intact.

## Testing Strategy

These are **acceptance tests to implement**, not passing evidence from this design PR. Use real loopback HTTP/WebSocket boundaries and real owner objects; fake only destructive filesystem/process effects and domain callbacks. Give each test a purpose comment, a positive control, and exact effect counts. Use deferred promises/events, not sleeps or negative polling that can pass before anything ran.

| ID  | Boundary / scenario                                                                                                                                             | Required observation                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Real Express app, before/after close, late-mounted route, reused keep-alive connection                                                                          | Positive requests reach handlers; every later request is refused with zero handler calls.                                                                                                                                                                                                |
| A2  | Auth, signed webhook, API, MCP, A2A, health, SSE, static and OPTIONS                                                                                            | Gate is before each dispatch/parser; running-state auth/origin refusals remain intact; terminal generic refusal does not reveal state. Enumerate actual mounts, not only a hardcoded test list.                                                                                          |
| A3  | Hold an admitted handler and an existing SSE stream; close gate; send a second request                                                                          | First work remains active and can finish; second cannot enter. Explicitly proves the exclusion rather than claiming drain.                                                                                                                                                               |
| A4  | Real upgrade, both credential postures; request after closure (including unknown route), then pause credential authorization and separately route authorization | Arriving after closure: 503 and zero credential/route authorization calls. Release pending authorization after closure: no `handleUpgrade`, no `open`, no upgraded close-frame refusal, whether authorization allows or denies. Positive controls open exactly one socket while running. |
| A5  | Close before app/listener construction; terminal transition during pending listen                                                                               | Same closed instance reaches both seams; no late serving listener or startup announcement; workspace fence precedes any awaited cleanup.                                                                                                                                                 |
| T1  | reset/reset, restart/restart, both reset/restart orders                                                                                                         | Exactly one valid winner, one cleanup/action chain, no competitor token consumed.                                                                                                                                                                                                        |
| T2  | signal first, admin first, repeated signal during reserved acknowledgment, running delete and failure                                                           | All callers observe one operation; no competing deletion, spawn or exit.                                                                                                                                                                                                                 |
| T3  | Invalid reset token/body, desktop mode, normal rate limits                                                                                                      | No reservation or admission close for invalid requests; desktop/rate-limit/body controls retain precedence before terminal ownership, including already-admitted competitors. Revise current tests that intentionally expect multiple accepted terminal requests.                        |
| T4  | Hold response handoff; disconnect/write failure; duplicate deferred callback                                                                                    | Reservation precedes acknowledgment; chain starts once after local handoff attempt, never before; disconnect does not reopen or duplicate.                                                                                                                                               |
| T5  | Cleanup sync throw, reject, hang; delete/spawn failure after permitted handoff                                                                                  | Stable identity/cause, one observed failure, sticky admission; no automatic retry or unapproved effect. Inject permitted handoff separately so mocks cannot certify DB safety.                                                                                                           |
| T6  | Actual root adoption and real owner + admin/router + signals                                                                                                    | One shared instance, no raw competing continuations; AST wiring supplements behavioral tests but is not full-server lifetime proof.                                                                                                                                                      |
| D1  | DOR-2482 destructive handoff                                                                                                                                    | Real held writers cannot mutate after the claimed fence; no DB close/delete/lock release/successor without authorized outcome. Owned and implemented with DOR-2482.                                                                                                                      |

Mutation controls: omit Express fence; omit upgrade entry fence; remove final post-auth check; move root close behind an await; inject separate admission objects; reserve after response scheduling; allow a loser to consume a token; leave independent signal exit; reinterpret cleanup rejection as authorized handoff. Each intended boundary test must go red against a green, nonzero baseline. Do not execute real `fs.rm`, `process.exit`, child spawning, live service calls or paid inference to prove these races.

## Performance Considerations

One synchronous state read per HTTP request and two per upgrade attempt. No request buffer, persistent record or polling loop. The admission-only phase introduces no extra shutdown delay. Long-lived connections remain a known independent lifetime, not a hidden timeout cost.

## Security Considerations

The terminal gate never authorizes an operation. Running-state host/origin/session/rate/token controls remain mandatory. Generic pre-auth 503 reveals no selected operation or credentials. Avoid a route allowlist that Express case/trailing-slash behavior could bypass. A caller disconnect cannot mint a second destructive consent. The terminal owner is process-local coordination, not a cross-process lock; DOR-2482 must still prove successor handoff.

## Documentation

Keep this specification, its ideation and proposed ADR indexed. Future implementation must update the admin dependency contract and relevant developer shutdown documentation without asserting all-writer drain. Preserve the historical DOR-2429 receipt; reference it rather than rewriting its guarantee. Record accepted design and implementation evidence separately.

## Implementation Phases

1. **Admission-only implementation recommendation:** after design review and operator selection, one bounded PR adds the shared main admission state, early HTTP gate, both upgrade checks and narrow root/late-listener wiring, with A1–A5 and mutation controls. Preserve all current cleanup/action order and active-work behavior. No terminal coordinator or unused helper lands yet. This improves admission only, not reset concurrency.
2. **DOR-2482 design dependency:** define and review writer outcomes, cleanup permissions and DB/lock/successor ordering. Recheck current owners, including separate listeners and startup acquisitions. Do not silently expand phase 1 to solve them.
3. **Exclusive operation adoption:** after that contract is concrete, one cohesive PR adopts the terminal owner across admin and signals, removes independent continuations, and includes T1–T6 plus D1 evidence with its owner. No intermediate deployment can claim safe destructive handoff from a void cleanup promise.

Next action is DECOMPOSE the admission-only phase if selected. DOR-2481 is a design deliverable; merging it does not implement any phase.

## Open Questions

- ~~Should main listener closure imply all writers drained?~~ **(RESOLVED)** No. Admission and transport completion do not cover handlers, detached turns or other listeners. DOR-2482 supplies writer evidence.
- ~~Can shared cleanup alone serialize reset/restart?~~ **(RESOLVED)** No. One owner must retain the complete terminal action chain.
- ~~What if acknowledgment delivery fails?~~ **(RESOLVED)** Keep the accepted reservation; run once after the local response handoff attempt. Never claim network delivery or reopen consent.
- ~~Should this task choose cleanup timeout and successor policy?~~ **(RESOLVED)** No. The full destructive adoption is gated on DOR-2482; the admission-only phase is independently specified and makes the exclusion explicit.

## Related ADRs

- ADR-0061: existing production spawn-and-exit mechanism; this spec does not accept its historical “old process fully exits before new one takes over” consequence as proof of safe lock/database handoff.
- ADR `260726-234120`: supervisor owns desktop lifecycle; router refusal remains.
- ADR-0264 and ADR `260805-041016`: detached turn lifetime, durable streams and single upgrade router remain.
- Proposed ADR `260928-130908`: [Own terminal actions separately from request admission](../../decisions/260928-130908-own-terminal-actions-separately-from-request-admission.md).

## References

- [Ideation](01-ideation.md)
- [DOR-2429 specification](../central-workspace-disposal/02-specification.md) and [ownership inventory](../central-workspace-disposal/root-ownership.md)
- [DOR-2481](https://linear.app/dorkspace/issue/DOR-2481), [DOR-2482](https://linear.app/dorkspace/issue/DOR-2482), [DOR-2483](https://linear.app/dorkspace/issue/DOR-2483), [DOR-2484](https://linear.app/dorkspace/issue/DOR-2484)
