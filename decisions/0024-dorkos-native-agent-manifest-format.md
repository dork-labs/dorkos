---
number: 24
title: Use DorkOS-Native Agent Manifest at .dork/agent.json
status: proposed
created: 2026-02-24
spec: mesh-core-library
superseded-by: null
---

# 24. Use DorkOS-Native Agent Manifest at .dork/agent.json

## Status

Proposed (auto-extracted from spec: mesh-core-library)

## Context

Agent registration needs a manifest file written to each agent's project directory. We considered the Linux Foundation A2A Agent Card standard (`.well-known/agent.json`), a custom format at `.dork/agent.json`, or A2A-aligned content in a DorkOS path. The A2A standard's `.well-known/` directory is defined by RFC 8615 for HTTP URI well-known locations — it doesn't apply to local filesystem discovery. A2A Agent Cards also include HTTP-specific fields (url, provider) that aren't relevant for local agents.

## Decision

Use `.dork/agent.json` with DorkOS-native fields: id (ULID), name, description, runtime, capabilities[], behavior, budget, registeredAt, registeredBy. The `.dork/` namespace is DorkOS's directory for project-level state. Future interoperability with A2A can be achieved via a `toAgentCard()` conversion function without changing the on-disk format.

## Consequences

### Positive

- Clean separation: DorkOS manifest has exactly the fields Mesh needs, no unused HTTP fields
- `.dork/` namespace is already established as DorkOS's project directory
- Zod schema validates the full manifest, catching issues at registration time
- Future A2A interop via conversion function avoids coupling to an evolving standard

### Negative

- Not directly compatible with A2A tooling that expects `.well-known/agent.json`
- Requires a conversion layer if A2A interop is needed later
- DorkOS-specific format means agents are only discoverable by DorkOS (by design)
