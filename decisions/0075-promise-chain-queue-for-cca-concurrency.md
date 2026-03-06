---
number: 75
title: Use Per-AgentId Promise Chain Queue for CCA Concurrency Serialization
status: proposed
created: 2026-03-04
spec: fix-relay-agent-routing-cwd
superseded-by: null
---

# 75. Use Per-AgentId Promise Chain Queue for CCA Concurrency Serialization

## Status

Proposed

## Context

The Claude Agent SDK throws "Already connected to a transport" if two `query()` calls run
concurrently on the same session object. ClaudeCodeAdapter reuses a single session per agent
(keyed by agentId), so concurrent relay messages to the same target agent would crash the SDK.
Two viable approaches were considered:

1. **Per-(sender→target) sessions**: Session key = `agentId:fromEndpoint`. Natural isolation,
   no queue needed. Downside: N×M session proliferation, loss of conversation continuity.
2. **Per-agentId promise chain**: A `Map<agentId, Promise<void>>` where each new message
   chains onto the previous promise via `.then()`. Messages serialize naturally without explicit
   queue data structures.

## Decision

Use a per-agentId promise chain (option 2). The implementation is a `Map<string, Promise<void>>`
where each incoming message chains onto the head: `current.then(() => processMessage())`. The chain
naturally serializes messages to the same agent while allowing parallel processing across different
agents.

## Consequences

### Positive

- Prevents "Already connected to a transport" crashes from concurrent relay messages.
- Preserves single-session conversation continuity per agent.
- Cross-agent messages still run in parallel — no global serialization bottleneck.
- Implementation is minimal (~10 lines), no external queue library needed.

### Negative

- If one message in the chain takes very long (slow agent), subsequent messages queue behind it.
- Queue depth is not bounded — a pathological flood of messages to one agent accumulates in memory.
  The existing concurrency semaphore (`maxConcurrent`) provides a coarse bound but not per-agent.
- No priority support; all messages to the same agent are strictly FIFO.
