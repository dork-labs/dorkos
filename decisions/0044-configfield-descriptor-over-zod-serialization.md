---
number: 44
title: Use ConfigField Descriptor Array Over Zod Serialization for Adapter Forms
status: draft
created: 2026-02-27
spec: adapter-catalog-management
superseded-by: null
---

# 44. Use ConfigField Descriptor Array Over Zod Serialization for Adapter Forms

## Status

Draft (auto-extracted from spec: adapter-catalog-management)

## Context

The adapter catalog needs to render dynamic setup forms on the client from server-side config schemas. Each adapter type has different config fields (Telegram needs a bot token, Webhook needs inbound/outbound URLs and secrets). Three approaches were considered: serializing Zod schemas to JSON Schema, enriching Zod with .meta() annotations, or defining a parallel ConfigField[] descriptor array. Research across VS Code, Grafana, n8n, Home Assistant, Raycast, and Backstage showed that the descriptor array pattern (used by n8n's INodeProperties and Raycast's preferences) consistently outperforms schema serialization for form rendering.

## Decision

Each adapter exports a `ConfigField[]` array alongside its Zod validation schema. The descriptor is a plain, JSON-serializable object with UI-specific fields (`type: 'password'`, `placeholder`, `showWhen`, `section`) that Zod schemas and JSON Schema cannot express. The Zod schema remains the single source of truth for server-side validation. The ConfigField array is the single source of truth for client-side form rendering.

## Consequences

### Positive

- ConfigField descriptors are fully JSON-serializable with no Zod dependency on the client
- First-class support for sensitive fields, conditional visibility, section grouping, and placeholder text
- npm plugin adapters can export manifests without depending on DorkOS's Zod version
- The UI contract is explicit and decoupled from validation internals

### Negative

- Slight duplication between ConfigField keys and Zod schema keys (mitigated by tests that verify alignment)
- Adapter developers must maintain two parallel definitions (descriptor + schema) for their config
