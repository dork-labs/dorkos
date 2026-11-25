---
number: 111
title: Top-Level Adapter Label Field
status: archived
created: 2026-03-11
spec: adapter-binding-ux-overhaul
superseded-by: null
---

# 111. Top-Level Adapter Label Field

## Status

Draft (auto-extracted from spec: adapter-binding-ux-overhaul)

## Context

Users need to distinguish between multiple adapter instances of the same type (e.g., two Telegram bots). The adapter config structure stores per-instance data as `{ id, type, enabled, config: Record<string, unknown> }`. The label could live inside the `config` record or as a top-level field.

## Decision

Store `label` as a top-level optional field on the adapter instance config, alongside `id`, `type`, and `enabled` — not inside the `config` record.

## Consequences

### Positive

- Clean separation between adapter-specific configuration (bot tokens, modes) and DorkOS-level metadata (label, ID, enabled)
- Label is accessible without parsing adapter-specific config
- No migration needed — existing configs without `label` default to `undefined`
- Consistent pattern if more DorkOS-level metadata fields are added later

### Negative

- Requires updating the adapter config type definition
- Two places to look for "adapter configuration" — top-level fields vs the config record
