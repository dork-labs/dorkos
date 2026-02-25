---
number: 7
title: Adopt cmdk for Searchable Combobox Patterns
status: proposed
created: 2026-02-21
spec: pulse-ui-overhaul
superseded-by: null
---

# 7. Adopt cmdk for Searchable Combobox Patterns

## Status

Proposed (auto-extracted from spec: pulse-ui-overhaul)

## Context

The Pulse timezone selector uses a native `<select>` with 400+ options — an unusable interaction pattern. The app needs a searchable combobox component for timezone selection and potentially other large option sets in the future. cmdk is the standard shadcn/ui Command component library, already used in `@dorkos/web` (v1.1.1), and integrates with Radix UI Popover for dropdown positioning.

## Decision

Add cmdk to `@dorkos/client` and create a shared `Command` component in `shared/ui/command.tsx` following the standard shadcn pattern. Use the Popover + Command combination for any searchable select/combobox needs (timezone picker is the first use case).

## Consequences

### Positive

- Standard shadcn pattern — consistent with the broader ecosystem
- Already proven in the monorepo (`@dorkos/web`)
- Supports fuzzy search, grouping, keyboard navigation out of the box
- Reusable for future combobox needs (e.g., model selection, user search)

### Negative

- New dependency (~4KB gzip)
- Creates a new shared UI component that needs to be maintained
- Adds complexity vs. a simple native `<select>` for small option lists
