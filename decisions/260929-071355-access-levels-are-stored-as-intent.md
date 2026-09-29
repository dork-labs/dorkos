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

**The grant rows are re-derived from the level wherever DorkOS records the app's catalog.** DorkOS reads a catalog in two places, and records it as a review both times: the reconciliation preview (opening "Who can use it?" or the exact-actions editor), and `LevelFollower`, acting for the owner of the connection's way. `connection_level_follows` keeps when, and under which DorkOS version, each connection was last followed. The follower looks at boot and then every hour, and each pass reads only the connections not followed within the last 11 hours (the 12-hour interval less one tick) under the running version. So while DorkOS runs, no level goes more than 12 hours since its last follow, restarts included; and the first pass after an update reads every connection, so a classifier change a DorkOS release ships reaches existing levels at once. A connection whose read fails stays due and is tried again the next hour. The follower's review carries its own epoch and is recorded already consumed, so nobody can apply it; it exists so the newest review is always the newest catalog. Each follower review replaces that connection's older follower reviews in the same transaction, and a read that changes no level and finds the catalog (with what the service still offers) exactly as the newest review has it keeps no review at all, so they never pile up; an owner's review is never removed. A pass is bounded (at most 200 connections, one at a time, 60 seconds each), and one app that fails is logged and skipped. In the transaction that records a catalog, every level on the connection is re-derived: its grant set becomes exactly `accessLevelRevisionIds(catalog, level)` — every action still offered whose class `levelIncludes` covers. A new action of the class joins; an action reclassified out of it (read → write leaves Read; anything → destructive leaves every level) or no longer offered leaves. The same shared function (`packages/shared/src/connector-schemas.ts`) decides what a level covers when the owner grants it, when the server validates the grant, and when it is followed, so the three can never disagree. A selection that names a level must be exactly that level's set in the reviewed catalog, or it is refused; what is written is that level's set in the newest recorded catalog, so a review left open in another tab can never grant an action a newer read took out of the level (the answer names what was written, so that tab reloads).

**Why re-derive rather than check the level at authorization time.** Deriving the allowed set at each call would need every reader of grants (execution authorization, the agent's action list, request follow-ups, session access, the operator views) and hosted authority to understand levels. Hosted authority only understands exact revisions, so a DorkOS-account connection would have two answers to "what may this agent run" that could drift. Re-deriving keeps one source of truth for access (the grant rows) and one for intent (the level row), and rewrites the first from the second in the same transaction that records the catalog, so they cannot disagree about a catalog DorkOS has recorded. Classification is only ever known from a discovery; there is no newer truth for an authorization-time check to read.

**DorkOS-account connections stay consistent with hosted authority.** A level change there goes through the existing close-first staging (`stageAgentGrantReplacement`, `stageEveryAgentGrantReplacement`): what leaves stops at once, and what joins opens only once hosted authority applies the command. A subject whose last requested set already matches is left alone, so reading the catalog again stages nothing new; a subject hosted authority was never asked about (a level kept from the owner's own key when the way moved to a DorkOS account) is always staged. Without the synchronizer nothing changes locally either.

**A level the owner chose that hosted authority refuses for good ends.** When an owner's grant command is refused, by hosted authority or by a failure that will not be retried, while it is still the subject's latest, the subject's level ends in the same transaction that records the refusal. A command DorkOS staged on its own to follow the app (`connection_access_levels.follower_command_id`) is not the owner's choice: its refusal keeps the level, and the next read sends it again. Nor does this computer's link to the DorkOS account lapsing (a local `unauthorized`) end anything. Close-first staging already stopped what the level was leaving and never opened what it was adding, so the agent holds only what it held before; a level kept after that would promise access the agent does not have. The card then shows what the agent really holds, and choosing the level again sends it again. The card also never reads a level that holds no usable action as held.

**A level never brings back access taken away another way.** Every path that ends a subject's grants some other way ends its level in the same transaction: exact actions chosen for the agent, removing the agent's access or the agent, stopping sharing with every agent, moving a way to a DorkOS account, and disconnecting or removing the account. A level of an agent that is no longer registered is left alone.

**Migration 0132** turns each live grant that matches a level in the connection's newest review (every action still offered, by class) into that level; everything else stays exact actions. Read wins when an app has no write actions, since both levels are then one set. This includes a grant picked action by action that happened to equal the whole Read (or Read and write) set: nothing recorded tells the two apart, and the card already showed such a grant as "Read". From now on it widens with the app's new read actions like any Read grant.

This amends ADR 260928-121730's rule that "a Read grant keeps exactly the revisions it had": that still holds for exact actions, and no longer for a level, which follows the app by class.

## Consequences

### Positive

- The card shows the level the owner chose, whatever the app does to its actions. "Exact actions" appears only for access picked action by action.
- An agent on Read gains the app's new read actions without anyone re-choosing, and loses an action the moment DorkOS learns it now changes or deletes things.
- A level can never widen past its classes, and no destructive action ever joins one; tests pin each direction.
- Every-agent levels follow the same way; each change is recorded in Activity under "DorkOS".
- A classifier change shipped in a DorkOS release reaches every existing level at the next boot.

### Negative

- DorkOS learns about a catalog change only when it next reads the catalog, so for at most 12 hours while DorkOS runs (longer only while it is stopped, or while the service can't be reached) a level holds the actions it had, including one the service has since reclassified. This is the one remaining gap.
- Reading the catalog, at boot, on the interval or when the card opens, can change what agents hold (always within the level) and, on a DorkOS account, send a command to hosted authority.
- A refused level the owner chose ends rather than retrying on its own; the owner chooses it again. One DorkOS was following is sent again on every read until hosted authority accepts it.
- A level's set includes older revisions the service still offers under an earlier version, the same rule the card used before, so an agent can hold two revisions of one action while both are offered.
