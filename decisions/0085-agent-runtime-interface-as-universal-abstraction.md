---
number: 85
title: Use AgentRuntime Interface as Universal Abstraction
status: proposed
created: 2026-03-06
spec: agent-runtime-abstraction
superseded-by: null
---

# 85. Use AgentRuntime Interface as Universal Abstraction

## Status

Proposed

## Context

DorkOS is tightly coupled to the Claude Agent SDK. AgentManager is both the abstraction and the implementation — a monolithic class that every service imports directly. The existing ClaudeCodeAdapter (Relay) has a clean `AgentManagerLike` interface, but it only covers ~40% of Claude Code interactions. The remaining 60% (direct API, session storage, model listing) bypass any abstraction layer entirely.

## Decision

Extract a universal `AgentRuntime` interface from the existing AgentManager public API and the Relay adapter's `AgentManagerLike` interface. All server routes and services interact with agent backends exclusively through this interface via a `RuntimeRegistry`. The Claude Agent SDK becomes an implementation detail encapsulated inside `ClaudeCodeRuntime implements AgentRuntime`.

## Consequences

### Positive

- Any agent backend (OpenCode, Aider) can be added by implementing a single interface
- Zero SDK imports outside the runtime implementation — clean dependency boundary
- Routes, Relay adapters, and client code become runtime-agnostic
- Existing `StreamEvent` type serves as the universal wire format (already well-designed)

### Negative

- File moves create a large diff with potential merge conflicts for in-flight branches
- One extra Map lookup per request (negligible performance impact)
- Runtime-specific features (MCP tools, permission modes) require capability detection rather than direct access
