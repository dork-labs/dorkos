---
number: 139
title: Route Chat Adapter Approvals via Relay Message Bus
status: proposed
created: 2026-03-18
spec: slack-tool-approval
superseded-by: null
---

# 0139. Route Chat Adapter Approvals via Relay Message Bus

## Status

Proposed

## Context

Chat adapters (Slack, Telegram) need to route tool approval responses back to the Claude Code runtime to resolve pending `canUseTool()` promises. The adapters live in `packages/relay/` and have no direct access to `runtime.approveTool()`. Three approaches were considered: relay message bus pub/sub, HTTP API callbacks to the server, and direct callback injection into adapters.

## Decision

Use the relay message bus with a dedicated subject namespace (`relay.system.approval.{agentId}`). Chat adapters publish approval responses to this subject. The CCA adapter subscribes to `relay.system.approval.>` and calls `runtime.approveTool()` to resolve the deferred promise.

## Consequences

### Positive

- Adapters remain fully decoupled — no dependency on server HTTP layer or runtime internals
- Consistent with existing relay patterns (`relay.system.pulse.{scheduleId}`)
- Works for any future adapter that needs to send approvals (webhook, Discord, etc.)
- Sub-millisecond in-process latency for the relay publish hop

### Negative

- One additional hop compared to direct callback injection
- CCA adapter must subscribe to a new subject namespace and wire `approveTool()` through `AgentRuntimeLike`
