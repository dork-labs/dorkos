---
slug: terminal-request-admission
number: 260928-130908
created: 2026-09-28
status: ideation
---

# Terminal request admission and exclusive reset/restart ownership

**Slug:** terminal-request-admission
**Author:** Codex
**Date:** 2026-09-28
**Work item:** DOR-2481
**Audit base:** `f8df106324d29a2199bb07e2a1102a0b75df9de1`

## 1) Intent & Assumptions

Design a terminal admission boundary and one owner of an accepted reset, restart or signal stop. Deliver a specification and review, not production behavior. The operator selected this bounded design after DOR-2429 merged as PR #2262.

- Recheck code rather than treating the older ownership inventory as current line references.
- Preserve DOR-2429's workspace-only guarantee, including its synchronous fence before unrelated cleanup awaits and its five-second bounded disposal.
- DOR-2482 owns cleanup outcomes, writer quiescence, database closure, instance-lock release and successor handoff. A successful request drain alone cannot authorize those actions.
- DOR-2483 owns general partial-start rollback. DOR-2484 owns marketplace retention lifetime.
- No production edits, new service contracts, paid tests, deployments, desktop lifecycle changes or broad root rewrite in this task.

## 2) Pre-reading Log

- `apps/server/src/routes/admin.ts:256–300`: reset and restart acknowledge independently, defer separate cleanup continuations and restart even after cleanup errors.
- `apps/server/src/index.ts:4670–4677,5595–5715`: admin receives raw cleanup; signal-only boolean does not serialize admin actions; lock release precedes reset's database close.
- `apps/server/src/index.ts:5339–5347`: main listener is startup-local; upgrades have a separate entry point.
- `apps/server/src/app.ts:185–349`: signed ingress and Better Auth precede the ordinary session gate; an API-only or late middleware fence misses work.
- `apps/server/src/services/core/streams/upgrade-router.ts:213–308`: authorization awaits before `handleUpgrade`; Express middleware cannot fence this seam.
- `apps/server/src/routes/__tests__/admin.test.ts:315–345`: tests currently accept reset followed by restart; exclusivity deliberately changes those expectations.
- `specs/central-workspace-disposal/root-ownership.md`: historical inventory and explicit exclusions, not current root-wide guarantees.
- ADR-0061, ADR-0264, ADR `260726-234120`, ADR `260805-041016`: spawn/exit, detached turns, supervisor ownership and one upgrade router constrain the design.

## 3) Codebase Map

Main HTTP entry → early webhook/auth handlers → body parsing/session checks → API/MCP/A2A/static mounts. Main upgrade entry → origin/credential/route authorization → WebSocket acceptance. Admin → independent cleanup/delete/restart today; signals → separate guarded cleanup/exit today.

The connector-runtime MCP loopback listener and per-preview listeners are separate servers. Existing HTTP handlers, SSE streams, upgraded sockets, detached turns, scheduler/Relay callbacks and in-process tools have independent lifetimes. Closing the main admission boundary cannot certify their completion.

No configuration or persistent schema change is proposed. The future owner belongs under `services/core/lifecycle/`, middleware under `middleware/`; no new service domain is needed. Root, app construction, upgrade routing and admin dependencies are the selected future composition seams.

## 4) Problem Evidence

Hold reset's deferred cleanup or deletion, then accept restart or deliver a signal. Today's code can schedule another cleanup and another terminal continuation. Memoizing only `shutdownServices()` leaves both post-cleanup continuations alive. Separately, requests and upgrades can still enter while cleanup is running.

These are code-traced races, not a claim that a live destructive reset was exercised. Existing tests mock process/filesystem effects and do not establish root-wide handoff safety.

## 5) Research

| Option                                                  | Benefit                                             | Limitation / decision                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Memoize cleanup only                                    | Small change; avoids duplicate closers              | Does not own deletion, successor spawn or exit. Reject as the complete solution.                                                     |
| Close the HTTP server and await its callback            | Stops listening and observes connections            | Upgrades, detached work and pending startup remain separate; a long-lived stream can delay the callback. Reject as a writer barrier. |
| Broad cancel/teardown framework                         | Could eventually cover all producers                | Requires domain cancellation and dependency proofs. Belongs to DOR-2482 and domain follow-ons.                                       |
| Sticky main admission plus one terminal-operation owner | Defines an exact boundary and a single action chain | Requires an explicit failure/handoff contract before destructive adoption. Recommend staged implementation.                          |

No external dependency research is needed for this design: it adds no library and relies on no claimed Node connection-drain guarantee. Implementation must verify the supported Node versions when changing listener closure behavior.

## 6) Decisions

| Decision                | Choice                                                                                                | Rationale                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Admission scope         | Main Express listener and its single upgrade router                                                   | Covers new main-listener work without claiming every process producer stopped.                  |
| Active work             | Do not cancel, destroy or wait for existing requests/streams in the admission-only slice              | Response completion and socket closure do not prove a handler or detached turn stopped writing. |
| Terminal ownership      | First valid synchronous reservation wins the entire action chain                                      | Prevents independent reset, restart and signal continuations.                                   |
| HTTP acknowledgment     | Reserve first; hand response off locally; run once even if caller disconnects                         | Delivery cannot be guaranteed, but accepted consent cannot become a second operation.           |
| Failure                 | Sticky failure, retained cause, no implicit retry or action escalation                                | A cleanup exception must not be reinterpreted as permission to spawn or delete.                 |
| Implementation ordering | Admission-only slice first; destructive terminal ownership adoption after DOR-2482's handoff contract | Makes the dependency honest and keeps the next code change bounded.                             |

Cloud and Community owners confirmed no active listener/admin/root writer overlaps. Their future managed-listener and stream-authorization designs do not establish writer quiescence. No unresolved product choice is needed to specify this boundary; implementation authorization remains separate.
