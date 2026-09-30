---
id: 260929-140932
title: Authorize terminal effects from resource-specific cleanup evidence
status: proposed
created: 2026-09-29
spec: shutdown-handoff-outcomes
extractedFrom: shutdown-handoff-outcomes
superseded-by: null
---

# 260929-140932. Authorize terminal effects from resource-specific cleanup evidence

## Status

Proposed from [shutdown handoff outcomes](../specs/shutdown-handoff-outcomes/02-specification.md), DOR-2482. Admission is merged in [PR #2338](https://github.com/dork-labs/dorkos/pull/2338); this decision defines the separate handoff policy. Production adoption and the proposed laboratory remain unselected.

## Context

Root cleanup currently combines timer stops, cancellation requests, timeouts and swallowed failures behind void promises. Some composite closers release their own dependencies before work is proven complete. Main admission does not drain admitted or detached work, and the instance claim inside dorkHome cannot protect recursive deletion of that same directory.

## Decision

We will require resource-specific evidence for storage closure, authority release and successor launch, with one terminal operation owner and separate permission to exit the old process. We will use a proposed 30-second observation budget without treating timeout as drain, retain original failures, and continue only independent safe cleanup. We will split or withhold composite closers that release dependencies before their users are safe, and refuse automated reset until exclusion is proven to survive deletion. We will stop protected file reporters before handoff, retain later failures in memory, and use best-effort stderr only when its sink is proven safe. We will begin with a separately selected workspace/SQLite laboratory; production adoption remains unselected.

## Consequences

### Positive

- Named proof gates prevent one local fence, transport close or timeout from becoming an all-writer safety claim.
- Independent safe cleanup can continue without removing dependencies still used by unfinished work.
- Failures before and after authority release remain distinct; no retry, reopen, repeated deletion or invented successor readiness follows.
- The initial laboratory can prove narrow permission interpretation without landing an unused generic framework.

### Negative

- In-memory receipts may be lost at exit when no safe reporting sink exists; no output delivery is promised.
- A refused shutdown may leave an unavailable terminal process holding its database and lock until operator recovery; the observation budget is not an exit deadline.
- Current closers and resource census do not establish global permissions, so production handoff needs further separately selected proof.
- Automated reset remains unsupported by the proposed policy until its exclusion boundary survives deletion.
- Child-process, supervisor and late-startup behavior must be proved independently; forced exit is not a clean-handoff fallback.
