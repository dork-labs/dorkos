---
id: 260923-223904
title: One permission model for agent actions, areas with three states, a default and per-agent overrides
status: draft
created: 2026-09-23
spec: agent-permissions
superseded-by: null
---

# 260923-223904. One permission model for agent actions, areas with three states, a default and per-agent overrides

## Status

Draft (extracted from spec: agent-permissions). When accepted it will supersede `260828-123331` (the first hard tool filter at `registry.invoke`, no global twin), `260726-171347` (tool-group toggles gate context, not access) and `0071` (implicit tool-group hierarchy). Their statuses flip when this ADR is accepted, not while it is a draft.

## Context

An agent's powers were set by four unrelated mechanisms: the per-agent `roomsManage` tool-group gate (fails closed, no global default, no approval path), the per-agent tier ceiling, the global and per-agent context switches (`agentContext.*Tools`, `enabledToolGroups.{tasks,relay,mesh,adapter}`) that only hid docs and never refused a call, and login-only standing grants. None could be set once for everyone. On an install where the person chose Full power, DorkBot still could not make a room and handed the job back ("turn on Manage rooms and tell me to go again").

## Decision

We will replace all four with one model. Actions belong to plain-language **areas** (Rooms, Tasks & schedules, Other agents, Messages, Chat connections, Tools & packages, DorkOS settings, and three floor areas). Each area takes one of three states, **Blocked, Ask, Allowed**, set by **one default for everyone** (a frozen preset, Careful, Balanced or Full power, plus a person's changes on top) and **per-agent overrides**, with per-action overrides where risk differs. One pure resolver in `@dorkos/shared/permissions` decides, with the order agent action > agent area > default action > default area > preset; an install that has not chosen a preset resolves through an "Unchanged" table that reproduces today's behaviour. Blocked hides the area's tools from every runtime's tool list and refuses direct calls, reads included. Files & commands is the one justified exception: it keeps the runtime's trust stops, but shares the rows, overrides and audit trail. Every permission change is written by one service, through person-only routes, and recorded as one `permission.changed` Activity event.

## Consequences

### Positive

- One rule a reader can find in the source, one place to set it for everyone, and a visible list of the agents that differ.
- Full power really gives agents more room; the phase 1 outcome (DorkBot's `create_room` runs on Full power) is a test.
- Blocked finally means blocked on every runtime, not only claude-code's system prompt.
- The generic agent PATCH, which today lets any local program write `roomsManage: true`, can no longer carry any permission.

### Negative

- A large retirement across four phases: config migrations, a permanent read-time fold of legacy manifest fields, a boot sweep, and two dropped tables or columns.
- Mapping the old "supervised" pick to Careful makes some areas ask where they ran before; announced in the changelog.
- Preset tables are frozen: changing a shipped value later needs a protective config migration.
- Every gated call on an area action reads the agent's manifest fresh from disk.
