---
number: 77
title: relay_send_async Fire-and-Poll Pattern for Long-Running Agent Tasks
status: proposed
created: 2026-03-05
spec: relay-async-query
superseded-by: null
---

# 77. relay_send_async Fire-and-Poll Pattern for Long-Running Agent Tasks

## Status

Proposed

## Context

relay_send_and_wait has a 120 s (now 600 s) hard timeout, but real agent-to-agent tasks can take 20+ minutes. Agents delegating long-running work via relay_send_and_wait silently time out with no result and no progress visibility. Three patterns were evaluated: (1) raising relay_send_and_wait's timeout indefinitely, (2) a dedicated fire-and-poll dispatch tool, and (3) a full job store with relay_job_status. The synchronous blocking model of relay_send_and_wait is fundamentally incompatible with 20-minute tasks regardless of timeout value — blocking an agent for 20 minutes on a synchronous tool call wastes the agent's entire context window and prevents concurrent work.

## Decision

Add a dedicated `relay_send_async` MCP tool that returns immediately with `{ messageId, inboxSubject }` where `inboxSubject` is an ephemeral `relay.inbox.dispatch.{UUID}` endpoint. The calling agent polls `relay_inbox()` for incremental progress events and a final `{ type: 'agent_result', done: true }` message. The caller is responsible for cleanup via `relay_unregister_endpoint()`. This is the fire-and-poll pattern recommended by Google's A2A protocol for long-horizon agent work. relay_send_and_wait remains unchanged for tasks under 10 minutes.

## Consequences

### Positive

- Agent A retains control during Agent B's execution — can do other work, check progress, or cancel
- No blocking: relay_send_async returns in milliseconds regardless of Agent B's task duration
- Composable with existing relay_inbox tool — no new polling infrastructure needed
- Clean mental model: relay_send=fire-forget, relay_send_and_wait=short-sync, relay_send_async=long-async
- No server-side job store complexity for MVP

### Negative

- Caller must implement polling loop (more complex agent orchestration)
- Dispatch inboxes accumulate on disk until explicitly cleaned up (no server-side TTL in MVP)
- Progress delivery is best-effort (server restart loses in-flight dispatch state)
