---
number: 45
title: Adapters Self-Declare Metadata via AdapterManifest
status: draft
created: 2026-02-27
spec: adapter-catalog-management
superseded-by: null
---

# 45. Adapters Self-Declare Metadata via AdapterManifest

## Status

Draft (auto-extracted from spec: adapter-catalog-management)

## Context

The adapter catalog needs display metadata (name, description, icon, category, setup instructions) and config schema descriptors for each adapter type. This metadata could live in a central catalog file maintained separately from adapter code, or it could be declared by each adapter alongside its implementation. A central catalog would require manual synchronization whenever an adapter changes. Self-declaration keeps metadata colocated with the code it describes, following the same pattern used by VS Code extensions (package.json contributes), n8n nodes (ICredentialType), and Raycast extensions (manifest preferences).

## Decision

Each adapter (built-in or npm plugin) exports a static `AdapterManifest` object containing display metadata and `ConfigField[]` descriptors. Built-in adapters export named constants (e.g., `TELEGRAM_MANIFEST`). Plugin adapters export a `getManifest()` function from their module. The server's `AdapterManager` aggregates all manifests into a catalog endpoint. No separate catalog file is maintained.

## Consequences

### Positive

- Metadata stays in sync with adapter code — no separate catalog to maintain
- Community adapters automatically get setup wizards if they export a manifest
- Adding a new built-in adapter is self-contained: implement the adapter, declare the manifest, done
- The manifest is validated at load time with a Zod schema

### Negative

- Adapter developers must provide metadata (small additional effort per adapter)
- Plugin manifest extraction requires runtime validation since external packages are untrusted
