---
id: 260923-223907
title: An action's permission area is declared on the action, and the compiler is the census
status: draft
created: 2026-09-23
spec: agent-permissions
superseded-by: null
---

# 260923-223907. An action's permission area is declared on the action, and the compiler is the census

## Status

Draft (extracted from spec: agent-permissions). Replaces the explicit tool-group lists and the implicit hierarchy of `0071` (trace follows relay, binding follows adapter) as part of `260923-223904`.

## Context

The permission model (`260923-223904`) needs every agent action placed in an area, or explicitly left out. The ideation listed each area's capability ids inside the area registry. The codebase's standing rule for per-tool facts is one fact per tool, in one place, with no list restating it (`mcp-tool-tiers.ts`, DOR-499), and a separate list drifts silently the first time someone adds a capability.

## Decision

We will put membership on the action. `CapabilityDefinition.area: PermissionAreaId | null` is a **required** field (replacing `toolGroup?`), and every `MCP_TOOL_TIERS` entry carries the same required `area`. `null` means always allowed and must come with an `areaNote` saying why. The area registry holds only each area's label, description, floor flag and preset values; the client reads each area's actions from `GET /api/permissions`, derived from the live registry. A census test walks every registry domain and the tool table: every action has an area or a note, no area is empty, no area has only reads, every floor-area action has card fields. The `MCP_TOOL_GATE_GROUPS` family in `mcp-tool-groups.ts` is deleted.

## Consequences

### Positive

- Adding a capability without deciding its area is a type error, not a silent gap.
- One per-tool table carries tier, title, area and card fields.
- The client holds no list that can drift from the server.

### Negative

- Every one of the roughly 116 actions (74 capabilities, 42 hand-registered tools) must be touched to declare `area`, and phase 1 ships most of them as `null` with a note until phase 3 assigns them.
- An action's area is static; an action whose risk depends on its input needs an explicit escalation hook (`areaForInput`, used only by `operator.config_patch`).
