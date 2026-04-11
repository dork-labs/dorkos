---
number: 230
title: Use `agent` (not `agent-template`) as Marketplace Package Type
status: proposed
created: 2026-04-06
spec: marketplace-01-foundation
extractedFrom: marketplace-01-foundation
superseded-by: null
---

# 230. Use `agent` (not `agent-template`) as Marketplace Package Type

## Status

Proposed

## Context

The marketplace registry uses a `type` field on each package entry to determine the install flow. One of the four package types represents installable agents — the user picks one, and DorkOS clones the repo + scaffolds a new agent workspace. This is what existing template-downloader.ts already does for the 7 built-in templates.

The brief considered three names for this type:

- `agent-template` — Technically accurate (these ARE templates that get cloned). Avoids overloading "agent" with mesh agents (runtime instances). But less user-friendly: "install an Agent Template" feels indirect.
- `agent` — Cleaner. Aligns with the Agent App Store framing (Vision 1 in the parent ideation): users install "an Agent" the same way iOS users install "an App". Distinguished from runtime mesh agents by context (registry entries vs. mesh registry).
- `agent-app` — Doubles down on Agent App Store framing. Distinct from both "agent" and "template". Brand-leaning but unfamiliar.
- Aliases (both `agent` and `agent-template`) — Maximum flexibility but creates two terms users will encounter.

## Decision

Use `agent` as the registry type value for installable agent packages.

The browse UI displays "Agents" as the type filter. Users see "install Code Reviewer" as installing an Agent, not a template. The mesh agent overload is resolved by context: marketplace package types live in `.dork/manifest.json` and `marketplace.json`; runtime mesh agents live in `.dork/agent.json` and the mesh registry. The two never appear in the same field.

## Consequences

### Positive

- User-facing language is direct: "install an Agent"
- Aligns with the Agent App Store framing (Vision 1) — the marketplace's primary product is whole agents, not plugins
- Browse UI can lead with Agents as the headline category
- Marketing positions DorkOS as "the App Store for AI agents" without contradicting product terminology

### Negative

- "Agent" is now slightly overloaded — a marketplace `agent` type produces a mesh `agent` runtime instance
- Documentation must clarify the distinction in places where both concepts appear
- If we ever introduce another type that produces an agent at runtime, naming will need refinement
