---
number: 76
title: Separate Mesh Agent ULID (Routing) from SDK Session UUID (Conversation) with Dual-ID Traceability
status: proposed
created: 2026-03-04
spec: fix-relay-agent-routing-cwd
superseded-by: null
---

# 76. Separate Mesh Agent ULID (Routing) from SDK Session UUID (Conversation) with Dual-ID Traceability

## Status

Proposed

## Context

The relay subject `relay.agent.{agentId}` contains a Mesh ULID (e.g., `01JN4M2X5...`). The Claude
Agent SDK uses its own UUID (e.g., `550e8400-...`) as the session identifier for transcript storage
and conversation resumption. These two IDs serve different purposes but were conflated throughout
the codebase — variables were named `sessionId` even when they contained ULIDs, and relay context
blocks injected into agent prompts only exposed one of the two IDs.

This conflation caused the `RELAY_TOOLS_CONTEXT` to instruct agents to use `{theirSessionId}` in
relay subjects, which was incorrect — the correct value is the Mesh ULID, not the SDK UUID.

## Decision

Formalize a three-ID glossary:
- **agentId** — Mesh ULID; used for routing (`relay.agent.{agentId}`), Mesh lookups
- **sdkSessionId** — SDK UUID; used for conversation continuity, JSONL file naming
- **ccaSessionKey** — CCA's internal lookup key; equals agentId initially, then sdkSessionId after first message

The relay `<relay_context>` block injected into agent prompts includes both `Agent-ID` and
`Session-ID` fields. Trace spans use `agent:{agentId}/{sdkSessionId}` as `toEndpoint`.
All relay-related code renames `sessionId` variables that hold ULIDs to `agentId`.

## Consequences

### Positive

- Agents receive correct routing instructions — they use `agentId` in `relay_send` subjects.
- Debugging is easier with both IDs visible in context and traces.
- Naming audit prevents the conflation from re-emerging.

### Negative

- Rename of `extractSessionId()` to `extractAgentId()` is a breaking change inside the package
  (but the method is private, so no external impact).
- The glossary comment block adds ~20 lines to CCA but is critical for maintainability.
