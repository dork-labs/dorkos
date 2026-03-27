---
number: 175
title: Use A2A Protocol as External Gateway Only
status: proposed
created: 2026-03-22
spec: a2a-channels-interoperability
superseded-by: null
---

# 175. Use A2A Protocol as External Gateway Only

## Status

Proposed

## Context

DorkOS needs external agent interoperability. A2A (Google/Linux Foundation, 150+ orgs) is the emerging standard for agent-to-agent communication over HTTP with JSON-RPC 2.0. DorkOS already has Relay for internal messaging — a NATS-style pub/sub broker with Maildir persistence, circuit breakers, backpressure, and namespace isolation. A2A uses direct HTTP connections between agents, scaling O(n^2) with the number of participants. Relay scales O(n) via broker-mediated pub/sub. Replacing Relay with A2A would sacrifice reliability primitives that DorkOS agents depend on (dead letter queues, persistent mailboxes, subject-based routing).

## Decision

Adopt A2A as an external-facing gateway that translates to Relay internally. Do not replace Relay with A2A for internal agent communication. The A2A gateway exposes an Agent Card and JSON-RPC endpoint for external agents, but all inbound A2A requests translate to `relayCore.publish()` calls. Relay remains the sole internal transport. External agents interact via A2A; internal agents never need A2A awareness.

## Consequences

### Positive

- **Preserves Relay's reliability primitives** — Persistence, backpressure, dead letter queues, and circuit breakers remain intact for internal communication
- **Adds ecosystem interoperability** — External agents from any A2A-compliant platform can communicate with DorkOS agents
- **No internal disruption** — Existing agents and adapters continue using Relay unchanged
- **Agents don't need A2A awareness** — The gateway handles all protocol translation transparently
- **O(n) scaling preserved** — Internal communication stays broker-mediated regardless of external connections

### Negative

- **Two protocol layers for external communication** — A2A requests must be translated to Relay messages, adding a translation hop
- **Translation overhead** — Mapping between A2A task lifecycle (submitted/working/completed) and Relay message patterns adds complexity
- **Dual evolution burden** — Must maintain the translation layer as both A2A protocol and Relay internals evolve independently
- **Potential semantic mismatch** — A2A's task-centric model differs from Relay's message-centric model; edge cases may require careful mapping
