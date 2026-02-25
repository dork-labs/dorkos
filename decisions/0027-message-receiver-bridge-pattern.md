---
number: 27
title: Use MessageReceiver as Relay-to-AgentManager Bridge
status: proposed
created: 2026-02-25
spec: relay-convergence
superseded-by: null
---

# 0027. Use MessageReceiver as Relay-to-AgentManager Bridge

## Status

Proposed (auto-extracted from spec: relay-convergence)

## Context

Relay convergence requires that messages published to subjects like `relay.agent.{sessionId}` and `relay.system.pulse.{scheduleId}` trigger AgentManager sessions. RelayCore handles message routing and delivery, but it doesn't know about AgentManager or Claude SDK sessions. A bridge service is needed to subscribe to agent-targeted subjects and translate Relay deliveries into AgentManager calls.

## Decision

Create a MessageReceiver service that subscribes to `relay.agent.>` and `relay.system.pulse.>` via RelayCore. When messages arrive, it extracts session context from the envelope, calls `agentManager.ensureSession()` and `agentManager.sendMessage()`, then publishes response StreamEvents back to the sender's `replyTo` subject. The MessageReceiver is initialized after both RelayCore and AgentManager are available.

## Consequences

### Positive

- Clean separation: RelayCore handles routing, MessageReceiver handles application logic
- Single point of entry for all agent interactions via Relay
- Consistent trace recording at the MessageReceiver boundary
- Follows the existing subsystem integration pattern (ADR 0017)

### Negative

- Adds another service to the initialization chain with ordering dependencies
- Agent execution errors must be handled and communicated back through Relay envelopes
- Must coordinate with session locking to prevent concurrent writes
