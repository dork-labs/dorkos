---
number: 138
title: Dedicated tool_progress StreamEvent Type Over Extending tool_call_delta
status: draft
created: 2026-03-16
spec: tool-progress-streaming
superseded-by: null
---

# 138. Dedicated tool_progress StreamEvent Type Over Extending tool_call_delta

## Status

Draft (auto-extracted from spec: tool-progress-streaming)

## Context

The Claude Agent SDK emits `tool_progress` messages with intermediate text output during long-running tool execution (Bash commands, file searches, large reads). Our `sdk-event-mapper.ts` silently drops these events. We needed to decide how to model this in our StreamEvent schema: either reuse the existing `tool_call_delta` event type (adding a `progress` field to distinguish from input JSON) or create a dedicated `tool_progress` event type.

## Decision

Use a dedicated `tool_progress` StreamEvent type with its own `ToolProgressEventSchema` carrying `toolCallId` and `content`. Add a `progressOutput` field to `ToolCallPartSchema` for client-side accumulation, separate from the existing `input` and `result` fields.

## Consequences

### Positive

- Semantic clarity — each event type represents a single concern (input JSON vs progress output)
- Clean client handler — distinct switch case with no conditional logic to distinguish event subtypes
- Follows the pattern established by subagent lifecycle events (`subagent_started`/`subagent_progress`/`subagent_done`), maintaining consistency across the schema
- Future extensibility — can add metadata (byte count, progress percentage) without affecting `tool_call_delta`

### Negative

- One more entry in `StreamEventTypeSchema` enum (21 → 22 types)
- One more schema in the `StreamEventSchema` data union
- Marginally more code than extending the existing `tool_call_delta` handler
