---
number: 246
title: Defer Personality Configuration to Post-Creation Settings
status: draft
created: 2026-04-11
spec: standardize-agent-creation-flow
superseded-by: null
---

# 0246. Defer Personality Configuration to Post-Creation Settings

## Status

Draft (auto-extracted from spec: standardize-agent-creation-flow)

## Context

The agent creation dialog included collapsible personality trait sliders (`TraitSliders` component) allowing users to configure agent personality during creation. This added complexity to the creation flow without clear user benefit — the common case is creating an agent quickly and configuring it later. The existing `AgentDialog` (agent settings) already provides full personality/identity/tools configuration.

## Decision

Remove personality sliders from the creation dialog entirely. Agent personality is configured post-creation via the agent settings view (`AgentDialog`). The creation dialog collects only the minimum: name, location, and optionally a template. This follows the "create fast, configure later" pattern established by Vercel (zero-config deploy) and Linear (title-only issue creation).

## Consequences

### Positive

- Creation dialog is simpler and faster to use
- Fewer fields reduces cognitive load during the path-selection moment
- Consistent with calm tech principle: "don't demand attention"
- TraitSliders import removed from creation feature module (smaller bundle for dialog)

### Negative

- Users who want to set personality upfront must now do it in two steps (create, then open settings)
- Templates that include personality traits will apply them silently without user review during creation
