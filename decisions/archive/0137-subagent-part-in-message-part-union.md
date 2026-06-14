---
number: 137
title: Add SubagentPart to MessagePart Discriminated Union
status: draft
created: 2026-03-16
spec: subagent-lifecycle-visibility
superseded-by: null
---

# 137. Add SubagentPart to MessagePart Discriminated Union

## Status

Draft (auto-extracted from spec: subagent-lifecycle-visibility)

## Context

The `MessagePartSchema` in `packages/shared/src/schemas.ts` is a Zod discriminated union on the `type` field, currently containing `TextPart` and `ToolCallPart`. This union defines the structure of assistant message content for both live streaming and history rendering. Adding subagent lifecycle visibility requires representing subagent blocks inline alongside text and tool call parts in the message stream.

Two approaches were considered: (A) model subagent blocks as a special `ToolCallPart` variant with a sentinel `toolName`, reusing the existing union member; (B) add a new `SubagentPart` discriminant to the union, giving subagent blocks their own type and schema.

## Decision

Add `SubagentPartSchema` as a third member of the `MessagePartSchema` discriminated union with `type: 'subagent'`. SubagentPart carries subagent-specific fields (`taskId`, `description`, `status`, `toolUses`, `lastToolName`, `durationMs`, `summary`) that don't map to ToolCallPart's fields. The `deriveFromParts()` function skips SubagentParts (they are neither text nor tool calls). `AssistantMessageContent` dispatches SubagentParts to a dedicated `SubagentBlock` component.

## Consequences

### Positive

- Clean separation of concerns — SubagentPart has its own schema, its own component, and its own rendering path
- Type-safe discrimination — TypeScript narrows `part.type === 'subagent'` correctly
- Sets precedent for adding future part types (e.g., ThinkingPart for extended thinking) without overloading ToolCallPart

### Negative

- Every consumer of `MessagePartSchema` must handle the new discriminant or explicitly skip it (e.g., `deriveFromParts`)
- History reconstruction from JSONL transcripts must eventually account for SubagentPart (deferred to follow-up work)
- Adding a third union member is a breaking change for any external consumer that exhaustively pattern-matches on `MessagePart.type`
