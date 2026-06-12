---
number: 44
title: Adapter Metadata Contract — AdapterManifest Self-Declaration with ConfigField Descriptors
status: accepted
created: 2026-02-27
spec: adapter-catalog-management
superseded-by: null
---

# 44. Adapter Metadata Contract — AdapterManifest Self-Declaration with ConfigField Descriptors

## Status

Accepted

Absorbs ADR-0045 (Adapters Self-Declare Metadata via AdapterManifest).

## Context

The adapter catalog needs two tightly coupled things: (1) display metadata (name, description, icon, setup instructions) for the catalog UI, and (2) dynamic form rendering for each adapter's config fields. These are documented together because `ConfigField[]` arrays live inside `AdapterManifest` — they're the same contract.

For metadata: this could live in a central catalog file or be declared by each adapter. Research into VS Code extensions, n8n nodes, and Raycast extensions shows self-declaration keeps metadata colocated with code and eliminates sync problems.

For forms: three approaches were considered — serializing Zod schemas to JSON Schema, enriching Zod with `.meta()` annotations, or a parallel `ConfigField[]` descriptor array. Research across VS Code, Grafana, n8n, Home Assistant, Raycast, and Backstage shows descriptor arrays consistently outperform schema serialization for form rendering.

## Decision

Each adapter (built-in or npm plugin) exports a static `AdapterManifest` containing display metadata and a `ConfigField[]` array. Built-in adapters export named constants (e.g., `TELEGRAM_MANIFEST`); plugin adapters export a `getManifest()` function. The server's `AdapterManager` aggregates all manifests into a catalog endpoint. No separate catalog file is maintained.

`ConfigField` descriptors are plain, JSON-serializable objects with UI-specific fields (`type: 'password'`, `placeholder`, `showWhen`, `section`) that Zod schemas cannot express. The Zod schema remains the single source of truth for server-side validation; the `ConfigField[]` array is the single source of truth for client-side form rendering.

## Consequences

### Positive

- Metadata stays in sync with adapter code — no separate catalog to maintain
- Community adapters automatically get setup wizards if they export a manifest
- ConfigField descriptors are fully JSON-serializable with no Zod dependency on the client
- First-class support for sensitive fields, conditional visibility, section grouping, placeholder text
- npm plugin adapters can export manifests without depending on DorkOS's Zod version

### Negative

- Adapter developers must provide both metadata and ConfigField descriptors (small additional effort per adapter)
- Slight duplication between ConfigField keys and Zod schema keys (mitigated by tests verifying alignment)
- Plugin manifest extraction requires runtime validation since external packages are untrusted
