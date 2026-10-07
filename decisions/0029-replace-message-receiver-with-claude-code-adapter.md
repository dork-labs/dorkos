---
number: 29
title: Replace MessageReceiver with ClaudeCodeAdapter
status: accepted
created: 2026-02-25
spec: relay-runtime-adapters
superseded-by: null
supersedes: 0027
---

# 29. Replace MessageReceiver with ClaudeCodeAdapter

## Status

Accepted

Supersedes: ADR-0027 (Use MessageReceiver as Relay-to-AgentManager Bridge)

## Context

Spec 5 (Relay Convergence) introduced `MessageReceiver` as a bridge between the Relay message bus and AgentManager. It subscribes to `relay.agent.>` and `relay.system.pulse.>` subjects and dispatches to agent sessions. However, this bridge exists alongside the `AdapterRegistry` system used by external adapters (Telegram, webhook), creating two separate dispatch mechanisms. Both do conceptually the same thing — receive Relay messages and dispatch them to a target — but use different patterns.

## Decision

Replace `MessageReceiver` entirely with `ClaudeCodeAdapter`, a proper `RelayAdapter` implementation that handles both `relay.agent.>` and `relay.system.pulse.>` subjects. This unifies all Relay dispatch under the single `AdapterRegistry` pattern. The adapter ports all existing MessageReceiver logic (trace recording, Pulse run lifecycle, response publishing) into the adapter interface.

## Consequences

### Positive

- One dispatch mechanism for all adapters — no confusion about "which component handles what"
- Adding new runtime adapters (Codex, OpenCode) follows the same pattern
- ClaudeCodeAdapter benefits from AdapterRegistry's lifecycle management (start/stop, error isolation)

### Negative

- Larger blast radius during implementation (removing MessageReceiver and all its references)
- ClaudeCodeAdapter is more complex than a simple adapter since it handles two subject patterns
