# Smart Message Formatting

**Slug:** smart-message-formatting
**Author:** Claude Code
**Date:** 2026-02-12
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** When slash commands are run, the chat history currently displays the full expanded prompt (the entire skill definition with all its instructions) as the user message, rather than a concise representation like `/spec:decompose specs/auto-hide-tool-calls/02-specification.md`. Additionally, other "system" message types (compaction summaries, task notifications, local command output) should receive similar treatment.

**Assumptions:**
- The JSONL transcript format is stable — slash commands always use `<command-message>`, `<command-name>`, `<command-args>` XML tags
- We want to show *something* for slash commands (not skip them entirely as we do now)
- Compaction summaries ("This session is being continued...") are valuable context but should be visually distinct from regular conversation
- Task notifications (`<task-notification>`) are internal plumbing and should remain hidden
- The solution should be extensible for future "special message" types

**Out of scope:**
- Changing how the SDK stores messages in JSONL
- Changing how slash commands are invoked/sent during live streaming
- Real-time slash command rendering during streaming (only affects history)

---

## 2) Pre-reading Log

- `apps/server/src/services/transcript-reader.ts`: Main transcript parser. Lines 256-258 and 380-381 skip `<command-name>` and `<local-command` prefixed messages. Line 565 strips `<system-reminder>` tags. The expanded prompt (next message after command tags) is NOT filtered — this is the message that leaks through.
- `apps/client/src/components/chat/MessageItem.tsx`: User messages rendered as plain text at line 85. No special handling for any message subtype.
- `apps/client/src/components/chat/MessageList.tsx`: Virtualizer-based list. Uses `computeGrouping()` for visual grouping.
- `packages/shared/src/schemas.ts`: `HistoryMessageSchema` has `id`, `role`, `content`, `toolCalls`, `parts`, `timestamp`. No `type` or `subtype` field for message classification.
- Session `451a201c-7a89-4109-b260-86a483286599` JSONL: Contains 12 slash commands, 5 compaction summaries, 5 task notifications, and multiple `<local-command-stdout>` messages.

---

## 3) Codebase Map

**Primary components/modules:**
- `apps/server/src/services/transcript-reader.ts` — Parses JSONL, currently filters command messages and returns `HistoryMessage[]`
- `apps/client/src/components/chat/MessageItem.tsx` — Renders individual messages (user = plain text, assistant = markdown + tool calls)
- `apps/client/src/components/chat/MessageList.tsx` — Virtualizer-based message list with grouping logic
- `packages/shared/src/schemas.ts` — Zod schemas for `HistoryMessage` and related types
- `packages/shared/src/types.ts` — Re-exports types from schemas

**Shared dependencies:**
- `@lifeos/shared` — Types flow from schemas → server (output) → client (consumption)
- `StreamingText` / `Streamdown` — Only used for assistant messages, not user
- `motion/react` — Entrance animations in MessageItem

**Data flow:**
JSONL file → `TranscriptReader.readTranscript()` → `HistoryMessage[]` → HTTP GET `/api/sessions/:id/messages` → Client `useChatSession` → `MessageList` → `MessageItem`

**Potential blast radius:**
- `transcript-reader.ts` — Logic changes to parsing
- `schemas.ts` / `types.ts` — New optional field on `HistoryMessage`
- `MessageItem.tsx` — New rendering branch for special message types
- Tests: `transcript-reader.test.ts`, `MessageItem` tests (if any)

---

## 4) Root Cause Analysis

### The Problem: TWO consecutive messages per slash command

When a user runs a slash command like `/ideate "Add settings screen"`, the SDK creates **two** user messages in the transcript:

1. **Command metadata message** (currently skipped):
   ```
   <command-message>ideate</command-message>
   <command-name>/ideate</command-name>
   <command-args>Add settings screen</command-args>
   ```

2. **Expanded prompt** (currently shown as-is):
   ```
   # Preflight > Discovery > Plan

   **Task Brief:** Add settings screen
   ...
   [12,000+ characters of skill instructions]
   ```

The server correctly skips message #1 (line 380: `startsWith('<command-name>')`) but message #2 — the giant expanded prompt — passes through because it starts with `# Preflight` (normal text). It becomes a massive user message bubble in the UI.

**The fix requires:**
1. Detect that message #2 is a skill expansion (it immediately follows a `<command-message>` message)
2. Instead of showing message #2, synthesize a concise representation from message #1's metadata
3. Or: merge both messages into a single message with `type: 'command'` metadata

### Additional problematic messages

| Message Type | Current Behavior | Desired Behavior |
|---|---|---|
| `<command-name>/<command-message>/<command-args>` | Skipped entirely | Show as concise `/command args` |
| Expanded skill prompt (follows command) | Shown as giant text blob | Replace with the concise command above |
| Compaction summary ("This session is being continued...") | Shown as normal user message | Show as a collapsed system notice |
| `<task-notification>` | Shown as user message with XML tags | Hide or show as subtle system indicator |
| `<local-command-caveat>` | Skipped | Keep skipped |
| `<local-command-stdout>` | Skipped | Keep skipped |

---

## 5) Research

### Approach 1: Server-side message classification with `type` field

Add an optional `type` field to `HistoryMessage`:
```typescript
type?: 'text' | 'command' | 'compaction' | 'system'
```

The server detects special messages during transcript parsing and sets the type + transforms content:
- Command messages: Extract `commandName` and `commandArgs` from XML tags, set `type: 'command'`, set content to `/commandName args`
- Skip the expanded prompt that follows
- Compaction summaries: Detect "This session is being continued" prefix, set `type: 'compaction'`

**Pros:**
- Clean separation of concerns — server classifies, client renders
- Type-safe — client can switch on `message.type`
- Extensible — easy to add new types
- No XML parsing on the client

**Cons:**
- Requires schema change (shared package)
- Server needs "lookahead" or state tracking to correlate command message with its expansion

### Approach 2: Client-side content sniffing

Keep the server as-is (or with minimal changes), and have the client detect special messages by inspecting content:
- If content starts with `# Preflight` or `# Decompose Specification` → it's a skill expansion, show collapsed
- If content starts with "This session is being continued" → compaction

**Pros:**
- No server/schema changes
- Quick to implement

**Cons:**
- Fragile — depends on content format that could change
- Business logic in the rendering layer
- Can't access the command metadata (name/args) since it's in a different message
- Not extensible

### Approach 3: Server-side with `messageType` discriminated union (Recommended)

Add a `messageType` discriminated union to `HistoryMessage`:
```typescript
messageType?:
  | { type: 'command'; commandName: string; commandArgs?: string }
  | { type: 'compaction'; summary?: string }
```

This is more structured than a flat `type` string. The server:
1. Tracks state while parsing — when it sees a `<command-message>` line, it stores the metadata
2. The *next* user message (the expanded prompt) gets tagged with `messageType: { type: 'command', commandName: '/ideate', commandArgs: '...' }`
3. The content field becomes the concise display text (e.g., the user's original input), or is left as the expanded prompt for an optional "expand" button
4. Compaction summaries get `messageType: { type: 'compaction' }`

**Pros:**
- Strongly typed with discriminated union
- Server handles all classification logic
- Client renders based on `messageType.type` switch
- Extensible — add new types to the union
- Preserves the full expanded prompt in `content` if needed for expand/collapse

**Cons:**
- Most complex to implement
- Requires schema change

### Recommendation

**Approach 3 (discriminated union)** is the most sound. However, Approach 1 is nearly as good and simpler. Given that we may want additional metadata per type (command needs name+args, compaction may want token count), the discriminated union is worth the small extra complexity.

A pragmatic middle ground: start with Approach 1 (flat `type` string + metadata fields) since it's simpler and covers 90% of needs, then evolve to Approach 3 if needed.

**Simplest viable approach:**
- Add `messageType?: string` to `HistoryMessage` (values: `'command'`, `'compaction'`, undefined for normal)
- Add `commandName?: string` and `commandArgs?: string` to `HistoryMessage`
- Server sets these during parsing
- Client switches rendering based on `messageType`

---

## 6) Clarification

1. **Should we show the expanded prompt at all?** Options:
   - (a) Show only the concise `/command args` representation (simplest)
   - (b) Show concise with an "expand" button to reveal the full skill prompt
   - (c) Show concise + a truncated preview (first ~2 lines)

2. **How should compaction summaries appear?** Options:
   - (a) Collapsed single-line system notice: "Context compacted" with expand to see summary
   - (b) Full text but with distinct visual styling (muted, smaller, system-style)
   - (c) Hidden entirely (like command messages are now)

3. **Should `/compact` appear in chat history?** It's a meta-command that triggers compaction. Currently skipped. Options:
   - (a) Keep it skipped (it produces the compaction summary separately)
   - (b) Show it as a command invocation like other slash commands

4. **Task notifications (`<task-notification>`)** — these are agent completion notifications that currently leak through. Should they:
   - (a) Stay hidden
   - (b) Show as a subtle "Agent completed: [summary]" indicator

5. **Scope for this feature** — should we implement all message types at once, or start with slash commands only and iterate?
