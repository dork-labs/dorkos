---
id: 260928-130908
title: Own terminal actions separately from request admission
status: proposed
created: 2026-09-28
spec: terminal-request-admission
superseded-by: null
---

# 260928-130908. Own terminal actions separately from request admission

## Status

Proposed from [terminal request admission](../specs/terminal-request-admission/02-specification.md), DOR-2481. Design only; no production adoption is claimed. This does not supersede the current restart mechanism or certify database/lock handoff.

## Context

Admin reset and restart currently acknowledge independently, then perform separate cleanup and terminal actions; signals use another entry guard. Sharing a cleanup promise would still leave competing deletion, spawn and exit continuations. Main HTTP and upgrade admission are separate seams, and stopping new requests cannot prove that admitted handlers, streams or detached work stopped writing.

## Decision

We will give main HTTP and upgrade admission one sticky root-owned boundary, with a final check after asynchronous upgrade authorization. We will reserve the entire terminal action for one synchronous, first-valid-operation owner, including response handoff, cleanup and the permitted terminal effects. We will implement admission independently first, without adding an unused terminal coordinator or claiming active-work drain. We will adopt exclusive destructive terminal actions only after DOR-2482 defines and verifies cleanup outcomes and database/lock/successor permissions; a resolved void promise or a timeout alone is insufficient.

## Consequences

### Positive

- New main-listener work has one exact refusal boundary, including late startup and upgrades pending authorization.
- Competing terminal requests cannot create independent action chains once the owner is adopted.
- Admission, operation exclusivity and safe destructive completion carry separate evidence rather than one overstated shutdown claim.

### Negative

- Existing requests, streams and other producers require their own drain or write-fence contracts.
- The first admission-only implementation does not solve reset/restart concurrency; complete adoption depends on DOR-2482.
- A failed operation retains terminal admission; automatic recovery and forced termination need a separate policy.
