---
number: 203
title: Include UI Control Methods in v1 ExtensionAPI for Phase 4 Readiness
status: draft
created: 2026-03-26
spec: ext-platform-03-extension-system
superseded-by: null
---

# 203. Include UI Control Methods in v1 ExtensionAPI for Phase 4 Readiness

## Status

Draft (auto-extracted from spec: ext-platform-03-extension-system)

## Context

The ExtensionAPI could be either lean (registration + state + storage only) or include UI control methods (`executeCommand`, `openCanvas`, `navigate`). VS Code's lesson: once an API is public, it's hard to remove — so smaller is safer. However, Phase 4 (Agent-Built Extensions) follows immediately and agents will need to control the UI from day one. Deferring UI control would force a breaking API change between Phase 3 and Phase 4.

## Decision

Include `executeCommand(command)`, `openCanvas(content)`, and `navigate(path)` in the v1 ExtensionAPI (13 methods + 1 field total). These wrap the already-implemented Phase 1 dispatcher and router. Defer `transport`, `useQuery`, `secrets`, and `permissions` to v2.

## Consequences

### Positive

- Phase 4 agent-built extensions can control the UI without an API version bump
- No breaking change between Phase 3 and Phase 4
- The underlying dispatcher and canvas are already implemented and stable

### Negative

- Larger API surface to stabilize and maintain
- UI control methods are power features that could be misused by poorly-written extensions
- Risk of API commitment to patterns that may evolve (mitigated by wrapping existing stable primitives)
