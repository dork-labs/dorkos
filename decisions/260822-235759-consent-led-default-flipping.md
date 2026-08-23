---
id: 260822-235759
title: Full power by default is consent-led — the door's accept writes the flips, never a migration
status: proposed
created: 2026-08-22
spec: full-power-defaults
superseded-by: null
amends: null
---

# 260822-235759. Full power by default is consent-led — the door's accept writes the flips, never a migration

## Status

Proposed — extracted from spec `full-power-defaults`.

## Context

DorkOS is flipping its posture so the default path leads to full autonomy: autonomy as the default trust stop, open mesh, standing grants, unattended surfaces at the operator's level, `canInitiate` pre-selected. The obvious implementation — change the schema defaults and seed a config migration — would turn these on for every install silently. That collides with the safe-defaults posture (ADR 260727-181825, "absence is not consent"), with the server's own `428 AUTONOMY_ACK_REQUIRED` gate, and with the brand's no-dark-patterns filter.

## Decision

"Default" means the recommended, pre-selected, one-click path — not a silent write. Consent-gated capabilities flip only inside the accept handler of one consent door (onboarding stage for new users, one-time modal for existing users), through the same gated surfaces a person would use by hand (`PATCH /api/config` carrying the standing acknowledgment; `PUT /api/mesh/topology/access`). Declining records the answer (`ui.fullPowerDecidedAt` + `ui.fullPowerChoice`) and changes nothing, and the door never re-asks. Only settings whose flip grants no capability and relaxes no bound (`persistentSession`, `scheduler.maxConcurrentRuns`) may change as plain schema defaults + migration.

## Consequences

- The 428 consent contract never weakens; no client, migration, or upgrade path can produce an unacknowledged autonomous install.
- Existing users' configs are byte-identical until they answer the door; support can always distinguish "chose full power" from "was upgraded".
- The cost is a real one-time interruption (one modal) for existing users — accepted deliberately; the moments rail bounds it to one modal per launch.
- Any future "unlock X by default" work inherits this shape: add it to the door (or a new moment), never to a migration.
