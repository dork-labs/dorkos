---
number: 87
title: Runtime Owns Session Storage
status: proposed
created: 2026-03-06
spec: agent-runtime-abstraction
superseded-by: null
---

# 87. Runtime Owns Session Storage

## Status

Proposed

## Context

Session data in DorkOS is currently derived entirely from Claude SDK JSONL transcript files at `~/.claude/projects/`. TranscriptReader, TranscriptParser, and SessionBroadcaster are all tightly coupled to this file format. A separate SessionStore interface was considered to decouple storage from execution, but different agent backends have fundamentally different storage formats and mechanisms.

## Decision

Session storage methods (`listSessions`, `getMessageHistory`, `watchSession`, etc.) live on the `AgentRuntime` interface. Each runtime implementation manages its own storage format internally. `ClaudeCodeRuntime` encapsulates TranscriptReader, TranscriptParser, and SessionBroadcaster as internal services.

## Consequences

### Positive

- Each runtime fully owns its data format — no leaky abstractions
- JSONL parsing, file watching, and byte-offset reading stay encapsulated in ClaudeCodeRuntime
- Future runtimes can use databases, APIs, or any storage mechanism without affecting the interface

### Negative

- Session queries go through the runtime even when they're purely read operations (slight indirection)
- If two runtimes need similar storage patterns, the logic can't easily be shared (acceptable tradeoff — YAGNI)
