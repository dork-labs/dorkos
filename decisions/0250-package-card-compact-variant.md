---
number: 250
title: PackageCard Compact Variant for Template Picker
status: draft
created: 2026-04-11
spec: create-agent-two-step-flow
superseded-by: null
---

# 250. PackageCard Compact Variant for Template Picker

## Status

Draft (auto-extracted from spec: create-agent-two-step-flow)

## Context

The Create Agent wizard's template picker step needs to display marketplace agent templates in a grid. The existing TemplatePicker uses custom inline card markup (simple name + description + check indicator) that differs visually from the marketplace PackageCard component. This creates visual inconsistency between the marketplace browse experience and the creation flow, and duplicates card rendering logic.

## Decision

Add a `variant` prop to the existing marketplace `PackageCard` component rather than creating a new template card component. The `compact` variant hides the author row and install button, uses smaller padding (p-4 vs p-6), and makes the entire card a single click target. This follows the FSD cross-feature UI composition rule — `features/agent-creation` renders `features/marketplace`'s PackageCard component.

## Consequences

### Positive

- Visual consistency: templates look the same in marketplace and creation flow
- No new component to maintain — single source of truth for package display
- Follows existing Shadcn variant pattern (cva or conditional props)
- FSD-compliant cross-feature UI composition

### Negative

- PackageCard gains complexity (variant prop, conditional rendering)
- Tight coupling between marketplace and agent-creation features at the UI level
