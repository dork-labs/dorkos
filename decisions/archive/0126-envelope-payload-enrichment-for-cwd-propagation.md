---
number: 126
title: Enrich Envelope Payload with Binding CWD in BindingRouter
status: archived
created: 2026-03-14
spec: relay-adapter-streaming-fixes
superseded-by: null
---

# 126. Enrich Envelope Payload with Binding CWD in BindingRouter

## Status

Draft (auto-extracted from spec: relay-adapter-streaming-fixes)

## Context

When BindingRouter routes inbound messages from `relay.human.*` to `relay.agent.{sessionId}`, it creates the agent session with the binding's `projectPath` but does not attach it to the republished envelope payload. The agent handler resolves CWD via `payloadCwd ?? context.agent.directory` — both are undefined because BindingRouter doesn't set either. This causes agents to operate in the server's default directory instead of the bound project directory. We considered two approaches: enriching the payload upstream (in BindingRouter) or adding a session-level CWD lookup downstream (in agent-handler).

## Decision

Enrich the envelope payload with `cwd: binding.projectPath` in BindingRouter before republishing to `relay.agent.{sessionId}`. The agent handler already reads `payloadCwd` from the payload, so zero changes are needed downstream. This follows the standard routing enrichment pattern — the router knows the binding context and injects it for consumers.

## Consequences

### Positive

- Zero changes needed in agent-handler (already reads `payloadCwd`)
- Follows established routing enrichment pattern
- CWD is explicit in the payload, making it observable in logs and traces
- Complementary to spec 108 (fix-relay-cwd-passthrough) which fixes downstream extraction

### Negative

- Mutates the payload before republishing (standard practice for routing enrichment, but worth noting)
- If `binding.projectPath` is stale or invalid, the error surfaces in the agent handler rather than the router
