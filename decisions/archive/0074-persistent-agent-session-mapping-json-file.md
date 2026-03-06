---
number: 74
title: Persist Agent Session Mapping in JSON File for Cross-Restart Continuity
status: draft
created: 2026-03-04
spec: fix-relay-agent-routing-cwd
superseded-by: null
---

# 74. Persist Agent Session Mapping in JSON File for Cross-Restart Continuity

## Status

Draft (auto-extracted from spec: fix-relay-agent-routing-cwd)

## Context

ClaudeCodeAdapter uses the Mesh agent ULID (extracted from `relay.agent.{agentId}`) as the session
lookup key when calling `AgentManager.ensureSession()`. The Claude SDK assigns a real UUID to the
session on the first message. This ULID→UUID mapping was stored only in `AgentManager`'s in-memory
Map. On server restart, the mapping was lost; the next relay message would trigger a resume failure
and start a fresh conversation, breaking continuity.

The BindingRouter already uses an identical pattern — persisting its session map to
`{relayDir}/sessions.json` via atomic tmp+rename writes — which survives server restarts.

## Decision

Introduce `AgentSessionStore` (`apps/server/src/services/relay/agent-session-store.ts`) following
the BindingRouter pattern. Store maps `agentId (ULID) → { sdkSessionId, createdAt, updatedAt }` in
`~/.dork/relay/agent-sessions.json`. CCA reads the persisted SDK UUID before creating a session;
after the stream drains, it writes back any updated SDK UUID.

## Consequences

### Positive

- Relay agent-to-agent conversations survive server restarts.
- Pattern is consistent with BindingRouter — no new persistence mechanisms introduced.
- Stale entries (deleted JSONL files) are handled gracefully via AgentManager's resume-failure retry.

### Negative

- File I/O on every relay message completion (one async write per message per agent).
- A corrupt `agent-sessions.json` must be handled gracefully (empty state fallback).
