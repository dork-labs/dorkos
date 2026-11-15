---
id: 261115-194346
title: Deliver peer messages to room seats through a bounded aside inbox
status: accepted
created: 2026-11-15
spec: agent-teams-seat-asides
superseded-by: null
---

# 261115-194346. Private seat messages through bounded asides

## Status

Approved design, extracted from agent-teams-seat-asides; root authorized implementation after prerequisite PR#3809 and PR#3810 review/opening.

## Context

Room seats can DM agents but refuse chat-id answers. Ordinary chat dispatch lacks the room's placement, claim, budget and bridge reply-root semantics. Existing spin-off reports use private asides but are same-agent-only and have unbounded process-local chains. Dorian authorized replies and unsolicited private seat writes, with body-free room traces, while rejecting bridge switches and unattended-run changes.

## Decision

Keep ordinary origin policy closed and introduce an explicit server-only seat delivery route with pinned room/member scope and durable receipts. A bounded FIFO inbox launches defused private asides, preserving immutable sender carry and current room restrictions without turning provenance into a whole-level cap. Unsolicited admission atomically records a constant local body-free trace; replies validate stored sender/recipient rows. Stale scope fails without rerouting and interrupted receipt rows fail honestly after restart.

The origin exception is narrow: existing ordinary origins and room turns stay eligible; relay-binding/null historical origins additionally need the current exact server-owned bridge/ledger tuple. Known unattended or external-event origins remain refused. The tuple is revalidated through placement and genuine native rekeys. This preserves actual adoption without asserting a separate durable adoption receipt or allowing arbitrary database writes in the threat model.

## Consequences

### Positive

- Room budgets, membership, placement, freshness and bridge initiate-consent remain authoritative.
- Registered agents can reach seats without broad origin switches or hidden private prompting.
- Explicit route ownership prevents recovery from adopting aside work into plain dispatch.

### Negative

- Internal route/scope schema and admission transaction require focused migration/lifecycle tests.
- Fixed queue defaults25/1000 and1h are resource safeguards, not measured ideal sizes.
- Queued work interrupted by restart fails rather than automatically replaying; senders can retry.
- Existing DOR-4148 restart provenance and tool-read gaps remain separate work.
