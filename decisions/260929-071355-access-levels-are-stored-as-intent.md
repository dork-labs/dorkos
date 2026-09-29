---
id: 260929-071355
title: Access levels are stored as intent and follow the app, never wider than their class
status: accepted
created: 2026-09-29
spec: connections-health
superseded-by: null
amends: 260928-121730
---

# 260929-071355. Access levels are stored as intent and follow the app, never wider than their class

## Status

Accepted (DOR-2506, design record `specs/connections-health/design-decisions.md` §2 principle 6 and §3 H7).

## Context

The access card offers two levels, "Read" and "Read and write" (ADR 260928-121730: `read` actions, plus `write`; `destructive` is in no level). Until now a level was saved as the exact operation revisions it covered that day, and the card read a grant back as "Read" only while it still matched today's Read set. Operation revisions are immutable and their identity includes the classification, so every new action, new toolkit version or reclassification made a "Read" grant stop matching. The owner then saw "Exact actions" (or "Custom access", or "Every agent has exact actions chosen now") that they never chose, and the agent never gained the app's new read actions (audit §1 #16).

The owner's promise is different: "Read" means every action this app lets agents read, now and as the app changes, and never more than that.

## Decision

**A level is stored as the owner's intent.** A new table, `connection_access_levels`, keeps one row per subject (a named agent, or every agent) and connection with the chosen level. The grant rows in `connection_operation_grants` stay exactly what they were: the one thing authorization, the agent's action list, and hosted authority read. A subject with grants and no level row holds exact actions, which stay exactly as chosen, as before.

**The grant rows are re-derived from the level at the one place DorkOS records the app's catalog.** The reconciliation preview (opening "Who can use it?" or the exact-actions editor) discovers the complete catalog and records its revisions. In that same transaction, every level on the connection is re-derived: its grant set becomes exactly `accessLevelRevisionIds(catalog, level)` — every action still offered whose class `levelIncludes` covers. A new action of the class joins; an action reclassified out of it (read → write leaves Read; anything → destructive leaves every level) or no longer offered leaves. The same shared function (`packages/shared/src/connector-schemas.ts`) decides what a level covers when the owner grants it, when the server validates the grant, and when it is followed, so the three can never disagree. A selection that names a level must be exactly that level's set in the reviewed catalog, or it is refused.

**Why re-derive rather than check the level at authorization time.** Deriving the allowed set at each call would need every reader of grants (execution authorization, the agent's action list, request follow-ups, session access, the operator views) and hosted authority to understand levels. Hosted authority only understands exact revisions, so a DorkOS-account connection would have two answers to "what may this agent run" that could drift. Re-deriving keeps one source of truth for access (the grant rows) and one for intent (the level row), and rewrites the first from the second in the same transaction that records the catalog, so they cannot disagree about a catalog DorkOS has recorded. Classification is only ever known from a discovery; there is no newer truth for an authorization-time check to read.

**DorkOS-account connections stay consistent with hosted authority.** A level change there goes through the existing close-first staging (`stageAgentGrantReplacement`, `stageEveryAgentGrantReplacement`): what leaves stops at once, and what joins opens only once hosted authority applies the command. A subject whose last requested set already matches is left alone, so reading the catalog again stages nothing new. Without the synchronizer nothing changes locally either.

**A level never brings back access taken away another way.** Every path that ends a subject's grants some other way ends its level in the same transaction: exact actions chosen for the agent, removing the agent's access or the agent, stopping sharing with every agent, moving a way to a DorkOS account, and disconnecting or removing the account. A level of an agent that is no longer registered is left alone.

**Migration 0129** turns each live grant that matches a level in the connection's newest review (every action still offered, by class) into that level; everything else stays exact actions. Read wins when an app has no write actions, since both levels are then one set.

This amends ADR 260928-121730's rule that "a Read grant keeps exactly the revisions it had": that still holds for exact actions, and no longer for a level, which follows the app by class.

## Consequences

### Positive

- The card shows the level the owner chose, whatever the app does to its actions. "Exact actions" appears only for access picked action by action.
- An agent on Read gains the app's new read actions without anyone re-choosing, and loses an action the moment DorkOS learns it now changes or deletes things.
- A level can never widen past its classes, and no destructive action ever joins one; tests pin each direction.
- Every-agent levels follow the same way; each change is recorded in Activity under "DorkOS".

### Negative

- DorkOS learns about catalog changes only when it reads the catalog, which today happens when someone opens "Who can use it?" or the exact-actions editor. Until then a level holds the actions it had, including one the service has since reclassified. A periodic catalog read would close that gap and is not part of this decision.
- Merely opening the card can change what agents hold (always within the level) and, on a DorkOS account, send a command to hosted authority.
- A level's set includes older revisions the service still offers under an earlier version, the same rule the card used before, so an agent can hold two revisions of one action while both are offered.
