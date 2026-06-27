---
number: 296
title: Tracker adapters are generated from a contract, not bundled
status: draft
created: 2026-06-26
spec: flow-marketplace-package
superseded-by: null
---

# 296. Tracker adapters are generated from a contract, not bundled

## Status

Draft (auto-extracted from spec: flow-marketplace-package)

## Context

The `/flow` engine has exactly one tracker adapter (`linear-adapter`), and it is welded to our specific
setup (Linear via MCP + Composio, the `DOR` team, the `personal` account). Most adopters need a
different tracker (Jira, GitHub Issues) or a different wiring of the same one, so a bundled adapter is
close to useless to them. The generic engine trusts the adapter to emit correct `WorkItem[]`; a subtly
wrong adapter would corrupt dispatch silently.

## Decision

Do not bundle a concrete tracker adapter. Ship an **adapter contract** (a `SPEC.md` + the `WorkItem`
schema + the 13 capability verbs + a `scripts/validate-adapter.mjs` conformance test), a
`building-adapters` skill, and reference adapters (starting with Linear-MCP and Linear-Composio). The
adopter's concrete adapter is generated into their own repo at `/flow:init` and must pass the conformance
test before it is used (generate-and-verify). The plugin remains a single unit; the adapter is
user-owned code conforming to the contract.

## Consequences

### Positive

- Maximally portable: works for any tracker the adopter's agent can reach; no config-templating gymnastics.
- The conformance test makes a generated adapter safe to trust; the generic engine stays tracker-agnostic (G8).
- One artifact to maintain (the contract + builder), not N hand-written adapters.

### Negative

- First-run is heavier than installing a prebuilt adapter (mitigated by reference adapters for common cases).
- The adopter owns adapter code that must be re-validated when the contract version changes.
