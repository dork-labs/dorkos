---
slug: smart-message-formatting
---

# Specification: Smart Message Formatting

## Overview

When viewing session history, slash commands currently display their full expanded skill prompt (often 10,000+ characters of internal instructions) as a regular user message. Instead, they should display as a concise `/command-name args` representation. Additionally, compaction summaries ("This session is being continued...") should appear as collapsed system notices, and task notifications should be hidden.

This requires changes across three layers: shared schema (add `messageType` field), server transcript parsing (classify messages), and client rendering (render special message types with distinct UI).

## User Decisions

1. Show only the concise `/command args` representation — no expand button, no preview of expanded prompt
2. Compaction summaries: collapsed single-line "Context compacted" with expand to see the summary
3. `/compact` command: keep it skipped (the compaction summary is shown separately)
4. Task notifications: stay hidden
5. Implement all message types at once

## Technical Design

### Approach: Flat `messageType` field with optional metadata

Add optional fields to `HistoryMessage`:

```typescript
messageType?: 'command' | 'compaction'
commandName?: string    // e.g. "/ideate"
commandArgs?: string    // e.g. "Add settings screen"
```

Why flat fields instead of a discriminated union: simpler Zod schema, simpler client consumption, and we only have two special types. If more types emerge with complex metadata, we can evolve to a union later.

### Server-side: Transcript Reader Changes

The core challenge is that slash commands produce **two consecutive** user messages:
1. Command metadata: `<command-message>ideate</command-message>\n<command-name>/ideate</command-name>\n<command-args>...</command-args>`
2. Expanded prompt: The full skill instructions (starts with `# Preflight` or similar)

**Algorithm:**
1. When parsing user messages, if content matches `<command-message>` pattern:
   - Extract `commandName` and `commandArgs` from XML tags
   - Store in a `pendingCommand` variable
   - Skip this message (don't emit it — same as current behavior)
2. On the **next** user message (the expanded prompt):
   - If `pendingCommand` is set, this is the expansion — emit a message with:
     - `messageType: 'command'`
     - `commandName` and `commandArgs` from the pending command
     - `content` set to the concise display string: `/commandName commandArgs` (or just `/commandName` if no args)
   - Clear `pendingCommand`
3. For compaction summaries (content starts with "This session is being continued"):
   - Emit with `messageType: 'compaction'`
   - Keep full content for expand/collapse
4. For task notifications (content starts with `<task-notification>`):
   - Skip entirely (don't emit)

**Edge cases:**
- Command metadata message with `<command-message>` that starts with `<command-name>` instead — the existing `startsWith('<command-name>')` check already catches this. Need to also detect messages starting with `<command-message>`.
- The `pendingCommand` state is reset if a non-expansion message is encountered
- Some commands have no following expansion (e.g., `/compact` produces `<local-command-stdout>` instead) — `pendingCommand` is consumed/cleared at next message regardless

### Client-side: MessageItem Changes

Add rendering branches for special message types:

1. **Command messages** (`messageType === 'command'`):
   - Render with a subtle slash-command style: monospace font, slightly muted appearance
   - Display: `> /ideate Add settings screen` (content field already formatted by server)
   - No expand button — just the concise command

2. **Compaction messages** (`messageType === 'compaction'`):
   - Render as a system divider/notice line
   - Default: collapsed single line like `--- Context compacted ---`
   - Clicking expands to show the full summary text
   - Visually distinct: centered, muted text, horizontal rules, smaller font

3. **Normal messages** (no `messageType`): unchanged behavior

### Schema Changes

In `packages/shared/src/schemas.ts`, update `HistoryMessageSchema`:

```typescript
export const MessageTypeSchema = z
  .enum(['command', 'compaction'])
  .openapi('MessageType');

export const HistoryMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    toolCalls: z.array(HistoryToolCallSchema).optional(),
    parts: z.array(MessagePartSchema).optional(),
    timestamp: z.string().optional(),
    messageType: MessageTypeSchema.optional(),
    commandName: z.string().optional(),
    commandArgs: z.string().optional(),
  })
  .openapi('HistoryMessage');
```

The `ChatMessage` interface in `use-chat-session.ts` needs matching fields.

## Implementation Phases

### Phase 1: Schema + Server (3 files)

1. **`packages/shared/src/schemas.ts`** — Add `MessageTypeSchema`, `messageType`, `commandName`, `commandArgs` to `HistoryMessageSchema`

2. **`apps/server/src/services/transcript-reader.ts`** — Update `readTranscript()`:
   - Add `pendingCommand` state variable tracking `{ commandName, commandArgs }` or null
   - Add detection for `<command-message>` prefix (in addition to existing `<command-name>` check)
   - Add XML tag parsing helper to extract command name and args
   - When command metadata detected: populate `pendingCommand`, skip message
   - When next user message arrives and `pendingCommand` is set: emit as command message
   - Detect compaction summaries by prefix "This session is being continued"
   - Detect and skip task notifications by prefix `<task-notification>`

3. **`apps/server/src/services/__tests__/transcript-reader.test.ts`** — Add tests for:
   - Command messages parsed correctly with name and args
   - Expanded prompt following command is replaced (not shown)
   - Commands without args work
   - Compaction summaries get `messageType: 'compaction'`
   - Task notifications are hidden
   - Normal messages unaffected

### Phase 2: Client (2 files)

4. **`apps/client/src/hooks/use-chat-session.ts`** — Add `messageType?`, `commandName?`, `commandArgs?` to `ChatMessage` interface. Map from `HistoryMessage` in the history-loading code.

5. **`apps/client/src/components/chat/MessageItem.tsx`** — Add rendering branches:
   - Command: monospace, muted, chevron indicator, show content (which is `/name args`)
   - Compaction: collapsible system divider with muted centered text

### Phase 3: Verify

6. Test with the real session `451a201c-7a89-4109-b260-86a483286599` — load it in the UI and verify:
   - Slash commands appear as concise one-liners
   - Compaction summaries appear as collapsed dividers
   - Task notifications are gone
   - Normal messages look the same

## Acceptance Criteria

- [ ] Slash commands display as concise `/commandName args` in chat history
- [ ] No expanded skill prompts visible anywhere in the chat
- [ ] Compaction summaries display as a collapsed "Context compacted" line
- [ ] Clicking a compaction notice expands to show the full summary
- [ ] Task notifications are hidden from chat history
- [ ] Normal user and assistant messages are completely unaffected
- [ ] All existing transcript-reader tests still pass
- [ ] New tests cover command, compaction, and task-notification parsing

## File Change Summary

| File | Change |
|------|--------|
| `packages/shared/src/schemas.ts` | Add `MessageTypeSchema`, 3 new optional fields to `HistoryMessageSchema` |
| `apps/server/src/services/transcript-reader.ts` | Add command/compaction/task-notification detection in `readTranscript()` |
| `apps/server/src/services/__tests__/transcript-reader.test.ts` | New test cases |
| `apps/client/src/hooks/use-chat-session.ts` | Add fields to `ChatMessage`, map from history |
| `apps/client/src/components/chat/MessageItem.tsx` | Rendering branches for command + compaction types |
