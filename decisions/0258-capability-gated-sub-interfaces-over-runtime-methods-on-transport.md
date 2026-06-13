---
number: 258
title: Capability-Gated Sub-Interfaces for Runtime-Specific Transport Methods
status: proposed
created: 2026-04-16
spec: codex-runtime-adapter-prework
superseded-by: null
---

# 0258. Capability-Gated Sub-Interfaces for Runtime-Specific Transport Methods

## Status

Proposed

## Context

The shared `Transport` interface in `packages/shared/src/transport.ts` contains Claude-specific leakage: `reloadPlugins` (a Claude plugin-model concept), `getModels` documented as "Claude models", `McpServerEntry.status` documented as "reported by the Claude Agent SDK", and a `'claudeai'` config scope string literal. Three options were considered: keep methods and have non-supporting runtimes no-op, rename to runtime-neutral names with capability-gated documentation, or remove them from the universal surface and expose them via capability-gated sub-interfaces.

## Decision

Remove runtime-specific methods from the universal `Transport` surface. For Claude plugin reload, introduce a capability-gated sub-interface that the client only uses when `capabilities.supportsPlugins` is true. Claude-specific docstrings on shared methods (e.g., `getModels`) are re-worded to be runtime-agnostic. This applies more broadly: any future runtime-specific capability is exposed as its own typed sub-interface, never as a no-op method on the universal transport.

## Consequences

### Positive

- The universal `Transport` surface stays clean of runtime-specific leakage, reducing mental load for client-side consumers.
- TypeScript prevents accidental calls against non-supporting runtimes — the capability check unlocks the typed sub-interface.
- New runtime-specific features can be added without polluting the shared contract.

### Negative

- Clients that previously called `reloadPlugins` unconditionally need migration to the capability-gated pattern.
- More types to maintain (one sub-interface per capability class) compared to a flat method list.
- The `DirectTransport` (embedded Obsidian plugin) must expose the same capability map as `HttpTransport` so sub-interfaces resolve identically in both adapters.
