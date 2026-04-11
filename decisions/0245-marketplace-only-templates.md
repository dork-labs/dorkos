---
number: 245
title: Marketplace-Only Agent Templates
status: draft
created: 2026-04-11
spec: standardize-agent-creation-flow
superseded-by: null
---

# 0245. Marketplace-Only Agent Templates

## Status

Draft (auto-extracted from spec: standardize-agent-creation-flow)

## Context

The agent creation template picker had three sources: built-in templates (hardcoded catalog fetched via `useTemplateCatalog`), Dork Hub marketplace packages, and custom GitHub URLs. The built-in catalog duplicated what the marketplace now provides, required separate maintenance, and added unnecessary complexity to the template picker UI (inner tabs with category filters).

## Decision

Delete the built-in template catalog entirely (hook, server endpoint, and UI). Marketplace agent packages become the sole template source in the creation dialog. Custom GitHub URL input is retained but moved into an "Advanced" collapsible disclosure for power users.

## Consequences

### Positive

- Single source of truth for templates (marketplace)
- Simpler TemplatePicker component (no inner tabs, no category filters)
- Less code to maintain (delete `use-template-catalog.ts` and server endpoint)
- Custom URL remains available for power users without cluttering the default view

### Negative

- Users without marketplace sources configured see an empty template picker
- Templates can no longer ship with the application itself (must be published to a marketplace)
- Slight discoverability reduction for custom GitHub URL (now behind Advanced toggle)
