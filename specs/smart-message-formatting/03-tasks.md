# Tasks: Smart Message Formatting

## Phase 1: Schema + Server

### Task 1: Add messageType fields to shared schema
**Files:** `packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`

Add `MessageTypeSchema` enum and three optional fields to `HistoryMessageSchema`:

In `packages/shared/src/schemas.ts`, add before `HistoryMessageSchema`:
```typescript
export const MessageTypeSchema = z
  .enum(['command', 'compaction'])
  .openapi('MessageType');

export type MessageType = z.infer<typeof MessageTypeSchema>;
```

Update `HistoryMessageSchema` to add three new optional fields:
```typescript
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

In `packages/shared/src/types.ts`, add `MessageType` to the export list.

**Acceptance criteria:**
- `MessageTypeSchema` is exported with values `'command'` and `'compaction'`
- `HistoryMessageSchema` includes optional `messageType`, `commandName`, `commandArgs`
- `MessageType` type is exported from types.ts
- `turbo typecheck` passes

---

### Task 2: Update transcript-reader to classify special message types
**Files:** `apps/server/src/services/transcript-reader.ts`

Update the `readTranscript()` method to detect and classify slash commands, compaction summaries, and task notifications.

**Changes to `readTranscript()`:**

1. Add a `pendingCommand` state variable before the `for` loop:
```typescript
let pendingCommand: { commandName: string; commandArgs: string } | null = null;
```

2. Add a helper method to the `TranscriptReader` class to extract command metadata from XML tags:
```typescript
private extractCommandMeta(text: string): { commandName: string; commandArgs: string } | null {
  const nameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const commandName = '/' + nameMatch[1].replace(/^\//, '');
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const commandArgs = argsMatch ? argsMatch[1].trim() : '';
  return { commandName, commandArgs };
}
```

3. In the user message handling section (where `text.startsWith('<local-command')` and `text.startsWith('<command-name>')` checks are), replace the existing skip logic and add new detection. The updated plain-string content section becomes:

```typescript
// Plain string content (normal user message)
const text = typeof msgContent === 'string' ? msgContent : '';

// Skip task notifications entirely
if (text.startsWith('<task-notification>')) {
  continue;
}

// Detect command metadata messages
if (text.startsWith('<command-message>') || text.startsWith('<command-name>')) {
  const meta = this.extractCommandMeta(text);
  if (meta) {
    pendingCommand = meta;
  }
  continue;
}

if (text.startsWith('<local-command')) {
  // local-command messages (like /compact stdout) consume any pending command
  pendingCommand = null;
  continue;
}

// If there's a pending command, this message is the expanded prompt
if (pendingCommand) {
  const { commandName, commandArgs } = pendingCommand;
  pendingCommand = null;
  const displayContent = commandArgs
    ? `${commandName} ${commandArgs}`
    : commandName;
  messages.push({
    id: parsed.uuid || crypto.randomUUID(),
    role: 'user',
    content: displayContent,
    messageType: 'command',
    commandName,
    commandArgs: commandArgs || undefined,
  });
  continue;
}

// Detect compaction summaries
if (text.startsWith('This session is being continued')) {
  messages.push({
    id: parsed.uuid || crypto.randomUUID(),
    role: 'user',
    content: text,
    messageType: 'compaction',
  });
  continue;
}

const cleanText = this.stripSystemTags(text);
if (!cleanText.trim()) continue;

messages.push({
  id: parsed.uuid || crypto.randomUUID(),
  role: 'user',
  content: cleanText,
});
```

**Acceptance criteria:**
- Command metadata messages (`<command-message>` or `<command-name>` prefix) set `pendingCommand` and are skipped
- The next user message after a command metadata message is emitted with `messageType: 'command'`, `commandName`, `commandArgs`, and concise `content`
- Messages starting with "This session is being continued" are emitted with `messageType: 'compaction'` and full content preserved
- Messages starting with `<task-notification>` are skipped entirely
- `<local-command` messages clear `pendingCommand` (no stale state)
- Normal messages remain completely unaffected
- `turbo typecheck` passes

---

### Task 3: Add transcript-reader tests for message classification
**Files:** `apps/server/src/services/__tests__/transcript-reader.test.ts`

Add new test cases to the existing `readTranscript()` describe block:

```typescript
it('classifies command messages with name and args', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-meta',
      message: {
        role: 'user',
        content: '<command-message>ideate</command-message>\n<command-name>/ideate</command-name>\n<command-args>Add settings screen</command-args>',
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-expansion',
      message: {
        role: 'user',
        content: '# Preflight\nYou are a product ideation assistant...',
      },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-cmd');

  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({
    id: 'cmd-expansion',
    role: 'user',
    content: '/ideate Add settings screen',
    messageType: 'command',
    commandName: '/ideate',
    commandArgs: 'Add settings screen',
  });
});

it('classifies command messages without args', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-meta',
      message: {
        role: 'user',
        content: '<command-message>compact</command-message>\n<command-name>/compact</command-name>',
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-expansion',
      message: {
        role: 'user',
        content: '# Compaction instructions...',
      },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-cmd-noargs');

  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({
    id: 'cmd-expansion',
    role: 'user',
    content: '/compact',
    messageType: 'command',
    commandName: '/compact',
    commandArgs: undefined,
  });
});

it('classifies compaction summaries with messageType compaction', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'comp-1',
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation. Here is a summary of what happened:\n\nWe discussed the architecture...',
      },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-compaction');

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    id: 'comp-1',
    role: 'user',
    messageType: 'compaction',
  });
  expect(messages[0].content).toContain('This session is being continued');
});

it('skips task notification messages entirely', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'Hello' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'task-1',
      message: {
        role: 'user',
        content: '<task-notification>Task 1 completed</task-notification>',
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: 'Continue working' },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-task');

  expect(messages).toHaveLength(2);
  expect(messages[0].content).toBe('Hello');
  expect(messages[1].content).toBe('Continue working');
});

it('handles command-name prefix without command-message wrapper', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-meta',
      message: {
        role: 'user',
        content: '<command-name>/review</command-name>\n<command-args>PR #42</command-args>',
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-expansion',
      message: {
        role: 'user',
        content: '# Review instructions...',
      },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-cmd-alt');

  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({
    id: 'cmd-expansion',
    role: 'user',
    content: '/review PR #42',
    messageType: 'command',
    commandName: '/review',
    commandArgs: 'PR #42',
  });
});

it('clears pending command on local-command messages', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'cmd-meta',
      message: {
        role: 'user',
        content: '<command-name>/compact</command-name>',
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'local-cmd',
      message: {
        role: 'user',
        content: '<local-command-stdout>Compaction complete</local-command-stdout>',
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'Next question' },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-local');

  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe('Next question');
  expect(messages[0].messageType).toBeUndefined();
});

it('leaves normal messages unaffected by message type classification', async () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'What is the weather?' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I cannot check the weather.' }],
      },
    }),
  ].join('\n');

  (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(lines);
  const messages = await transcriptReader.readTranscript('/vault', 'session-normal');

  expect(messages).toHaveLength(2);
  expect(messages[0].messageType).toBeUndefined();
  expect(messages[1].messageType).toBeUndefined();
});
```

**Acceptance criteria:**
- All 7 new test cases pass
- All existing transcript-reader tests continue to pass
- Run with: `npx vitest run apps/server/src/services/__tests__/transcript-reader.test.ts`

---

## Phase 2: Client Rendering

### Task 4: Add messageType fields to ChatMessage and map from history
**Files:** `apps/client/src/hooks/use-chat-session.ts`

Update the `ChatMessage` interface and the history-seeding `useEffect` to propagate `messageType`, `commandName`, and `commandArgs`.

1. Update the `ChatMessage` interface:
```typescript
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
  parts: MessagePart[];
  timestamp: string;
  messageType?: 'command' | 'compaction';
  commandName?: string;
  commandArgs?: string;
}
```

2. In the `useEffect` that seeds history (around line 102), update the mapping to include the new fields. Inside `setMessages(history.map(m => { ... }))`, add the new fields to the returned object:
```typescript
return {
  id: m.id,
  role: m.role,
  content: derived.content,
  toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : undefined,
  parts,
  timestamp: m.timestamp || '',
  messageType: m.messageType,
  commandName: m.commandName,
  commandArgs: m.commandArgs,
};
```

**Acceptance criteria:**
- `ChatMessage` interface has optional `messageType`, `commandName`, `commandArgs` fields
- History messages with `messageType` preserve the field through to the messages state
- `turbo typecheck` passes

---

### Task 5: Render command and compaction message types in MessageItem
**Files:** `apps/client/src/components/chat/MessageItem.tsx`

Add rendering branches for `command` and `compaction` message types in the `MessageItem` component.

1. Add a `useState` import (already imported) for the compaction expand state.

2. Inside the `MessageItem` component, before the return statement, add:
```typescript
const [compactionExpanded, setCompactionExpanded] = useState(false);
```

3. Replace the user message rendering branch. Currently:
```tsx
{isUser ? (
  <div className="whitespace-pre-wrap break-words">{message.content}</div>
) : (
```

Replace with:
```tsx
{isUser ? (
  message.messageType === 'command' ? (
    <div className="font-mono text-sm text-muted-foreground">
      {message.content}
    </div>
  ) : message.messageType === 'compaction' ? (
    <div className="w-full">
      <button
        onClick={() => setCompactionExpanded(!compactionExpanded)}
        className="flex items-center gap-2 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <div className="h-px flex-1 bg-border/40" />
        <ChevronRight className={cn(
          'size-3 transition-transform duration-200',
          compactionExpanded && 'rotate-90'
        )} />
        <span>Context compacted</span>
        <div className="h-px flex-1 bg-border/40" />
      </button>
      {compactionExpanded && (
        <div className="mt-2 text-xs text-muted-foreground/60 whitespace-pre-wrap">
          {message.content}
        </div>
      )}
    </div>
  ) : (
    <div className="whitespace-pre-wrap break-words">{message.content}</div>
  )
) : (
```

**Acceptance criteria:**
- Command messages render with monospace font and muted color, showing concise `/name args`
- Compaction messages render as a centered "Context compacted" divider line with expand chevron
- Clicking the compaction divider toggles the full summary text
- Normal user messages render exactly as before (plain `whitespace-pre-wrap`)
- Assistant messages are completely unaffected
- No visual regressions for standard messages

---

## Phase 3: Verification

### Task 6: Manual verification with real session data
Load the UI and verify with a real session that contains slash commands and compaction summaries. Confirm:
- Slash commands appear as concise one-liners (e.g., `/ideate Add settings screen`)
- No expanded skill prompts are visible
- Compaction summaries appear as collapsed "Context compacted" dividers
- Clicking a compaction notice expands to show the full summary
- Task notifications are not visible
- Normal messages look the same as before
