---
number: 147
title: Extend Transcript Parser to Extract Error/Subagent/Hook Parts
status: archived
created: 2026-03-19
spec: streaming-message-integrity
superseded-by: null
---

# 0147. Extend Transcript Parser to Extract Error/Subagent/Hook Parts

## Status

Draft (auto-extracted from spec: streaming-message-integrity)

## Context

The transcript parser (`transcript-parser.ts`) only extracts three JSONL block types: `thinking`, `text`, and `tool_use`. Error, subagent, hook, and tool progress blocks are silently skipped. When users load past sessions from disk, these parts are permanently lost because the JSONL doesn't contain them (the SDK doesn't persist them). This data loss occurs even before the streaming phase.

The `MessagePartSchema` discriminated union in `packages/shared/src/schemas.ts` already defines all these types — the parser just needs to handle them.

## Decision

Add block handlers for error, subagent, and hook JSONL blocks in the transcript parser. Map them to `ErrorPart`, `SubagentPart`, and `HookPart` using defensive field access (`block.field ?? fallback`). This fixes data loss when loading past sessions from disk.

## Consequences

### Positive

- Fixes data loss when loading past sessions (error/subagent/hook parts now visible)
- Reuses existing Zod schemas (no schema changes needed)
- Defensive field access handles missing JSONL fields gracefully
- Same data recovery path works for both current sessions (via streaming) and past sessions (via disk load)
- Orthogonal to the streaming ID reconciliation fix

### Negative

- Requires understanding exact JSONL field names from the SDK (block.error_type vs block.errorType, etc.)
- Assumes the SDK persists these block types to JSONL (may vary by SDK version)
- Field name assumptions may need adjustment if SDK format changes
