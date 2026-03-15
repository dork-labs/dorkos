---
number: 131
title: Binding-Level Permissions Over Adapter-Level Permissions
status: draft
created: 2026-03-15
spec: relay-panel-redesign
superseded-by: null
---

# 131. Binding-Level Permissions Over Adapter-Level Permissions

## Status

Draft (auto-extracted from spec: relay-panel-redesign)

## Context

No permissions exist on adapters or bindings. Kai's agents can initiate outbound messages to any connected platform with no guard rails — his primary safety concern for overnight autonomous runs. The relay-panel-redesign spec analyzed whether permissions belong on adapters (protocol bridges) or bindings (routing rules that intersect adapter, chat, and agent). Adapters represent a platform connection shared across many bindings; placing permissions there would apply them globally to all agents and chats on that platform, which is too coarse. Bindings are the unit where adapter, chat, and agent intersect — the correct place for routing policy.

## Decision

Add three permission fields to `AdapterBindingSchema` in `packages/shared/src/relay-adapter-schemas.ts`: `canInitiate` (default `false`), `canReply` (default `true`), and `canReceive` (default `true`). Enforce these permissions server-side in `BindingRouter` at the two routing decision points — inbound delivery and outbound reply — and when an agent publishes without a preceding inbound context. All fields use Zod defaults, making the addition backward compatible with existing bindings stored on disk.

## Consequences

### Positive

- Conservative default (`canInitiate: false`) prevents overnight agent spam without any user configuration.
- Permissions compose naturally with the existing binding resolution algorithm (ADR-0047) — they apply after a binding is resolved, not before.
- Backward compatible: existing bindings on disk parse correctly with Zod defaults applied, requiring no migration.
- Permissions are surfaced in the UI only when they deviate from defaults, keeping the common case noise-free.

### Negative

- Three new fields on every binding object, increasing schema surface.
- Requires server-side enforcement logic in `BindingRouter` for all three routing paths (inbound, reply, agent-initiated).
