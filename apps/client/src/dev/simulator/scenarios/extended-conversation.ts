import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';
import type { SubagentPart } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Turn 1: User asks about architecture
// ---------------------------------------------------------------------------

const USER_1 = createUserMessage({
  id: 'sim-ec-u1',
  content: 'I want to add real-time collaboration to our editor. Multiple users should be able to edit the same document simultaneously. What approach would you recommend?',
});

const ASST_1 = createAssistantMessage({
  id: 'sim-ec-a1',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const TEXT_1 = `Great question. Real-time collaboration is a complex problem with several well-established approaches. Let me explore your codebase first to understand the current architecture, then I'll recommend the best fit.`;

// ---------------------------------------------------------------------------
// Turn 1: Research
// ---------------------------------------------------------------------------

const GREP_TOOL = createToolCall({
  toolCallId: 'sim-ec-grep',
  toolName: 'Grep',
  input: JSON.stringify({ pattern: 'WebSocket|socket|ws', path: 'src/' }),
  status: 'pending',
});

const READ_TOOL = createToolCall({
  toolCallId: 'sim-ec-read1',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/services/document.ts' }),
  status: 'pending',
});

const READ_PKG = createToolCall({
  toolCallId: 'sim-ec-read2',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/package.json' }),
  status: 'pending',
});

const SUBAGENT_1: SubagentPart = {
  type: 'subagent',
  taskId: 'sim-ec-sub1',
  description: 'Research CRDT vs OT approaches for collaborative editing',
  status: 'running',
  toolUses: 8,
  lastToolName: 'WebSearch',
  durationMs: 15600,
};

const POST_RESEARCH = `\n\nAfter exploring the codebase and researching the options, here's my analysis:

## Three Main Approaches

### 1. Operational Transformation (OT)
The approach Google Docs uses. Operations (insert, delete) are transformed against concurrent operations to maintain consistency. Mature and well-understood, but the transformation logic is notoriously complex — Google's implementation took years to stabilize.

**Pros:** Battle-tested at scale, works with any document model
**Cons:** Complex transformation functions, centralized server required, hard to implement correctly

### 2. Conflict-free Replicated Data Types (CRDTs)
A newer approach where the data structure itself guarantees convergence without a central coordinator. Libraries like Yjs and Automerge make this practical.

**Pros:** Works peer-to-peer, no central server required, mathematically guaranteed convergence, simpler mental model
**Cons:** Higher memory overhead, document size can grow with edit history

### 3. Last-Write-Wins (LWW) with Locking
The simplest approach — lock sections of the document while someone is editing. Used by some simpler collaborative tools.

**Pros:** Dead simple to implement
**Cons:** Poor UX (users blocked from editing), doesn't feel truly real-time

## My Recommendation

Given your current architecture — you already use WebSockets for notifications and your document model is a tree structure — I'd recommend **Yjs (CRDT)**. Here's why:

1. Your existing WebSocket infrastructure can be extended for sync
2. Yjs has excellent React bindings and works with most editors
3. The document tree maps naturally to Yjs's shared types
4. It handles offline editing gracefully (important for your use case)

Want me to proceed with a Yjs-based implementation?`;

// ---------------------------------------------------------------------------
// Turn 2: User confirms, assistant plans
// ---------------------------------------------------------------------------

const USER_2 = createUserMessage({
  id: 'sim-ec-u2',
  content: 'Yes, go with Yjs. Can you start with the core sync infrastructure and a basic proof of concept?',
});

const ASST_2 = createAssistantMessage({
  id: 'sim-ec-a2',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const TEXT_2_INTRO = "Absolutely. I'll implement this in phases. First the WebSocket sync provider, then the React integration.\n\n";

const QUESTION_TOOL = createToolCall({
  toolCallId: 'sim-ec-question',
  toolName: 'AskUserQuestion',
  input: JSON.stringify({
    question: 'How should we handle user presence?',
  }),
  status: 'pending',
  interactiveType: 'question',
  questions: [
    {
      header: 'Presence',
      question: 'How should we display other users editing the document?',
      options: [
        { label: 'Colored cursors + names (Recommended)', description: 'Show each user\'s cursor position and name, Google Docs style' },
        { label: 'Avatar badges only', description: 'Show who is viewing but not cursor positions' },
        { label: 'No presence indicators', description: 'Keep it minimal, just sync the content' },
      ],
      multiSelect: false,
    },
  ],
});

const POST_QUESTION = "\n\nColored cursors it is. I'll include Yjs awareness protocol for presence. Let me start building the infrastructure.\n\n";

// Turn 2: Implementation
const WRITE_PROVIDER = createToolCall({
  toolCallId: 'sim-ec-write1',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/collab/sync-provider.ts', content: '...' }),
  status: 'pending',
});

const WRITE_HOOK = createToolCall({
  toolCallId: 'sim-ec-write2',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/collab/use-collaboration.ts', content: '...' }),
  status: 'pending',
});

const WRITE_CURSOR = createToolCall({
  toolCallId: 'sim-ec-write3',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/collab/CollaboratorCursors.tsx', content: '...' }),
  status: 'pending',
});

const WRITE_SERVER = createToolCall({
  toolCallId: 'sim-ec-write4',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/server/collab-handler.ts', content: '...' }),
  status: 'pending',
});

const POST_WRITES = `\n\nCore infrastructure is in place. Here's what I've created:

- **\`sync-provider.ts\`** — WebSocket provider that syncs Yjs documents between clients. Handles reconnection, initial state sync, and incremental updates. Uses binary encoding for minimal bandwidth.

- **\`use-collaboration.ts\`** — React hook that initializes the Yjs document, connects the sync provider, and manages presence awareness. Returns the shared document and a list of active collaborators.

- **\`CollaboratorCursors.tsx\`** — Renders colored cursor indicators for each remote user, with smooth position interpolation for a fluid feel.

- **\`collab-handler.ts\`** — Server-side WebSocket handler that broadcasts document updates between connected clients and persists the latest state to the database.

Let me install the required dependencies and run a quick test.\n\n`;

const BASH_INSTALL = createToolCall({
  toolCallId: 'sim-ec-bash1',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm add yjs y-websocket y-protocols lib0' }),
  status: 'pending',
  interactiveType: 'approval',
});

const BASH_TEST = createToolCall({
  toolCallId: 'sim-ec-bash2',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm vitest run src/collab/__tests__/ --reporter=verbose' }),
  status: 'pending',
});

// ---------------------------------------------------------------------------
// Turn 3: Testing and summary
// ---------------------------------------------------------------------------

const USER_3 = createUserMessage({
  id: 'sim-ec-u3',
  content: 'Looks great. Any edge cases or gotchas I should know about?',
});

const ASST_3 = createAssistantMessage({
  id: 'sim-ec-a3',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const FINAL_TEXT = `Good question. Here are the key edge cases and things to watch out for:

### Connection Handling
- **Reconnection**: The sync provider uses exponential backoff (1s, 2s, 4s, max 30s). During disconnection, edits are buffered locally and synced when reconnected. The CRDT guarantees they'll merge correctly.
- **Tab backgrounding**: Browsers throttle WebSocket connections in background tabs. The provider detects this and uses a longer heartbeat interval to avoid unnecessary reconnections.

### Data Considerations
- **Document size**: CRDTs grow over time as they track edit history. For documents with heavy editing, you'll want to periodically compact the Yjs document using \`Y.encodeStateAsUpdate()\` and reload from the compacted state.
- **Undo/redo**: Yjs provides \`UndoManager\` that tracks per-user undo stacks. This is already wired up in the hook — each user's undo history is independent.

### Presence Quirks
- **Stale cursors**: If a user closes their browser without a clean disconnect (crash, network drop), their cursor will persist for the awareness timeout period (30 seconds by default). I've set this to 15 seconds for a better UX.
- **Cursor colors**: I'm using a hash of the user ID to deterministically assign colors from a palette of 8 distinct colors. This means the same user always gets the same color across sessions.

### Performance
- **Large documents**: For documents over ~50KB of content, the initial sync can take 100-200ms. The provider shows a loading indicator during this time.
- **High concurrency**: Tested with up to 20 simultaneous editors — performance stays smooth. Beyond that, you'd want to implement update batching on the server.

### Security
- **Authorization**: The collab handler validates the user's session token before allowing WebSocket upgrade. Unauthorized connections are rejected immediately.
- **Rate limiting**: Update messages are rate-limited to 100/second per client to prevent abuse. This is well above normal typing speed.

The implementation handles all of these out of the box. The main thing you'll want to monitor in production is document size growth — set up an alert if any document exceeds 1MB of CRDT state.`;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** Long multi-turn conversation with extensive text, research, questions, and tool calls — designed to produce scrollable content. */
export const extendedConversation: SimScenario = {
  id: 'extended-conversation',
  title: 'Extended Conversation (Long)',
  description: 'Multi-turn architecture discussion with research, questions, and implementation',
  steps: [
    // Turn 1: User question
    { type: 'append_message', message: USER_1, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_1, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ec-a1', TEXT_1),
    { type: 'set_streaming', isTextStreaming: false },

    // Research tools
    { type: 'append_tool_call', messageId: 'sim-ec-a1', toolCall: GREP_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a1', toolCallId: 'sim-ec-grep', patch: { status: 'running' }, delayMs: 1200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a1',
      toolCallId: 'sim-ec-grep',
      patch: { status: 'complete', result: 'src/server/ws-handler.ts:4: import { WebSocketServer } from "ws";\nsrc/server/notifications.ts:12: ws.send(JSON.stringify(event));' },
      delayMs: 400,
    },

    { type: 'append_tool_call', messageId: 'sim-ec-a1', toolCall: READ_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a1', toolCallId: 'sim-ec-read1', patch: { status: 'running' }, delayMs: 1600 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a1',
      toolCallId: 'sim-ec-read1',
      patch: { status: 'complete', result: 'export interface Document {\n  id: string;\n  title: string;\n  content: TreeNode;\n  version: number;\n  updatedAt: Date;\n}\n\nexport interface TreeNode {\n  type: string;\n  children?: TreeNode[];\n  text?: string;\n}' },
      delayMs: 400,
    },

    { type: 'append_tool_call', messageId: 'sim-ec-a1', toolCall: READ_PKG, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a1', toolCallId: 'sim-ec-read2', patch: { status: 'running' }, delayMs: 1000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a1',
      toolCallId: 'sim-ec-read2',
      patch: { status: 'complete', result: '{\n  "dependencies": {\n    "express": "^5.0.0",\n    "ws": "^8.16.0",\n    "better-sqlite3": "^11.0.0"\n  }\n}' },
      delayMs: 400,
    },

    // Subagent research
    { type: 'append_part', messageId: 'sim-ec-a1', part: SUBAGENT_1, delayMs: 6000 },

    // Long analysis text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ec-a1', POST_RESEARCH),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle', delayMs: 600 },

    // Turn 2: User confirms approach
    { type: 'append_message', message: USER_2, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_2, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ec-a2', TEXT_2_INTRO),
    { type: 'set_streaming', isTextStreaming: false },

    // Question about presence
    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: QUESTION_TOOL },
    { type: 'set_waiting', isWaiting: true, waitingType: 'question', delayMs: 5000 },
    { type: 'set_waiting', isWaiting: false },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-question',
      patch: {
        status: 'complete',
        answers: { 'How should we display other users editing the document?': 'Colored cursors + names (Recommended)' },
      },
      delayMs: 600,
    },

    // Post-question text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ec-a2', POST_QUESTION),
    { type: 'set_streaming', isTextStreaming: false },

    // Write files
    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: WRITE_PROVIDER, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a2', toolCallId: 'sim-ec-write1', patch: { status: 'running' }, delayMs: 2400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-write1',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: WRITE_HOOK, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a2', toolCallId: 'sim-ec-write2', patch: { status: 'running' }, delayMs: 2000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-write2',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: WRITE_CURSOR, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a2', toolCallId: 'sim-ec-write3', patch: { status: 'running' }, delayMs: 1800 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-write3',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: WRITE_SERVER, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a2', toolCallId: 'sim-ec-write4', patch: { status: 'running' }, delayMs: 2200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-write4',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    // Post-writes explanation
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ec-a2', POST_WRITES),
    { type: 'set_streaming', isTextStreaming: false },

    // Install deps (approval)
    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: BASH_INSTALL },
    { type: 'set_waiting', isWaiting: true, waitingType: 'approval', delayMs: 4000 },
    { type: 'set_waiting', isWaiting: false },
    { type: 'update_tool_call', messageId: 'sim-ec-a2', toolCallId: 'sim-ec-bash1', patch: { status: 'running' }, delayMs: 3000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-bash1',
      patch: { status: 'complete', result: 'Added 4 packages in 3.2s\n\nyjs@13.6.0\ny-websocket@2.0.0\ny-protocols@1.0.6\nlib0@0.2.98' },
      delayMs: 600,
    },

    // Run tests
    { type: 'append_tool_call', messageId: 'sim-ec-a2', toolCall: BASH_TEST, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ec-a2', toolCallId: 'sim-ec-bash2', patch: { status: 'running' }, delayMs: 3000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ec-a2',
      toolCallId: 'sim-ec-bash2',
      patch: {
        status: 'complete',
        result: '✓ sync-provider connects and syncs (45ms)\n✓ sync-provider handles reconnection (120ms)\n✓ sync-provider buffers offline edits (32ms)\n✓ use-collaboration initializes document (18ms)\n✓ use-collaboration tracks presence (24ms)\n✓ CollaboratorCursors renders remote cursors (12ms)\n✓ collab-handler broadcasts updates (28ms)\n✓ collab-handler rejects unauthorized connections (8ms)\n\nTest Files  4 passed (4)\nTests       8 passed (8)\nDuration    0.29s',
      },
      delayMs: 400,
    },
    { type: 'set_status', status: 'idle', delayMs: 400 },

    // Turn 3: User asks about edge cases
    { type: 'append_message', message: USER_3, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_3, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ec-a3', FINAL_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
