---
number: 99
title: MessageContext for Prop Drilling Elimination
status: draft
created: 2026-03-09
spec: chat-message-theming
superseded-by: null
---

# 99. MessageContext for Prop Drilling Elimination

## Status

Draft (auto-extracted from spec: chat-message-theming)

## Context

`MessageItem` receives 6 props (`sessionId`, `isStreaming`, `activeToolCallId`, `onToolRef`, `focusedOptionIndex`, `onToolDecided`) that it does not use directly — it passes them through to `ToolApproval`, `QuestionPrompt`, and other sub-components. This prop drilling grows with each new interactive message type. Stream Chat React uses the same pattern (MessageContext wrapping each message's sub-components).

## Decision

Introduce `MessageContext` (React Context) provided by `MessageItem` and consumed by sub-components (`AssistantMessageContent`, which passes values to `ToolApproval` and `QuestionPrompt`). The context value is memoized with individual field dependencies to prevent unnecessary re-renders. The public `MessageItem` props API is unchanged — `MessageList` still passes the same props.

## Consequences

### Positive

- Sub-components access what they need via `useMessageContext()` without prop drilling
- Adding new shared values (e.g., future `selectedMessageId`) requires no prop changes in intermediate components
- Follows established pattern (Stream Chat, Radix primitives)

### Negative

- Adds indirection — values are no longer visible in the component's prop signature
- Context re-renders must be carefully controlled via memoization
- `useMessageContext()` throws if used outside `MessageProvider` — requires provider in test wrappers
