---
number: 69
title: Agent Context Config Section Independent from Feature Flags
status: proposed
created: 2026-03-04
spec: agent-tool-context-injection
superseded-by: null
---

# 69. Agent Context Config Section Independent from Feature Flags

## Status

Proposed

## Context

Tool context blocks are gated on feature availability (e.g., relay must be enabled for `<relay_tools>`). The question was whether the config toggle should be coupled to the feature flag (relay on = relay context on, no independent control) or independent (relay can be on but context suppressed). Three approaches were considered: (1) always-on feature-flag gated, (2) dedicated independent config section, (3) per-agent manifest capability gating.

## Decision

Add a dedicated `agentContext` section to `UserConfigSchema` with boolean toggles (`relayTools`, `meshTools`, `adapterTools`), all defaulting to true. Each context block requires BOTH the feature to be available AND the config toggle to be on. This gives power users visibility into what context their agents receive and the ability to suppress specific blocks without disabling the underlying feature. Config toggles use `!== false` checks for backward compatibility with config files that predate the section.

## Consequences

### Positive

- Power users can see and control what context their agents receive
- Independent from feature flags — relay can be enabled for tools but context suppressed if it causes issues
- All-default-true means zero friction for normal users
- Config API (GET/PATCH) supports the new section automatically via the existing Zod validation pipeline

### Negative

- Adds a new config section that most users will never touch
- Dual gating (feature flag AND config) adds a minor layer of complexity to the context builder
