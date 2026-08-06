---
number: 3
title: Use SDK JSONL Transcripts as Single Source of Truth
status: accepted
created: 2026-02-06
spec: claude-code-webui-api
superseded-by: null
---

# 0003. Use SDK JSONL Transcripts as Single Source of Truth

## Status

Accepted

(2026-08-06 audit) Scope narrowed by ADR-0310: SDK JSONL is the source of truth for the claude-code runtime only; other runtimes own their own storage.

## Context

The Claude Agent SDK stores all session data in JSONL files at `~/.claude/projects/{slug}/{sessionId}.jsonl`. These append-only transcripts contain every message, tool call, and approval. The system needed to decide whether to maintain a separate session store (database, in-memory cache) or derive all session state from the SDK's existing files. Users also interact with sessions from the CLI, and those sessions need to be visible in the web UI.

## Decision

We will use SDK JSONL transcript files as the single source of truth for all session data. The server has no separate session store. The `TranscriptReader` service scans JSONL files to build the session list, extracts metadata (title, preview, timestamps) from file content and stats, and reads full message history by parsing JSONL lines. Session ID equals the SDK session ID (UUID from the filename).

## Consequences

### Positive

- CLI-started and WebUI-started sessions are automatically visible to all clients
- No data duplication or synchronization logic between SDK storage and server storage
- Sessions survive server restarts with zero persistence code
- SDK's built-in `resume: sessionId` works directly without mapping layer

### Negative

- No structured queries (can't efficiently find "sessions from the last 24 hours" without scanning all files)
- Every session list or message history request reads from disk (mitigated by mtime-based metadata caching)
- Sessions can't be hidden or archived; deleting means removing the JSONL file
- Concurrent writes from multiple clients to the same session required adding session locking separately
