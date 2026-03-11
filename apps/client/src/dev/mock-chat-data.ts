import type { ChatMessage, ToolCallState } from '@/layers/features/chat/model/chat-types';
import type { PendingFile } from '@/layers/features/chat/model/use-file-upload';
import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import type { TaskItem, QuestionItem } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix = 'mock') {
  return `${prefix}-${++idCounter}`;
}

/** Create a user message with sensible defaults. */
export function createUserMessage(
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  const id = nextId('user');
  const content = overrides.content ?? 'Hello, can you help me?';
  return {
    id,
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create an assistant message with sensible defaults. */
export function createAssistantMessage(
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  const id = nextId('asst');
  const content = overrides.content ?? 'Sure, I can help with that.';
  return {
    id,
    role: 'assistant',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a tool call with sensible defaults. */
export function createToolCall(
  overrides: Partial<ToolCallState> = {}
): ToolCallState {
  return {
    toolCallId: nextId('tc'),
    toolName: 'Read',
    input: JSON.stringify({ file_path: '/src/index.ts' }),
    status: 'complete',
    ...overrides,
  };
}

/** Create a task item with sensible defaults. */
export function createTaskItem(
  overrides: Partial<TaskItem> = {}
): TaskItem {
  return {
    id: nextId('task'),
    subject: 'Implement feature',
    status: 'pending',
    ...overrides,
  };
}

/** Create a pending file with sensible defaults. */
export function createPendingFile(
  overrides: Partial<PendingFile> = {}
): PendingFile {
  const id = nextId('file');
  return {
    id,
    file: new File(['content'], overrides.file?.name ?? 'document.txt', {
      type: overrides.file?.type ?? 'text/plain',
    }),
    status: 'pending',
    progress: 0,
    ...overrides,
  };
}

/** Create a queue item with sensible defaults. */
export function createQueueItem(
  overrides: Partial<QueueItem> = {}
): QueueItem {
  return {
    id: nextId('q'),
    content: 'Follow-up message',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pre-built variant sets
// ---------------------------------------------------------------------------

export const TOOL_CALLS: Record<string, ToolCallState> = {
  pending: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'npm test' }),
    status: 'pending',
  }),
  running: createToolCall({
    toolName: 'Read',
    input: JSON.stringify({ file_path: '/src/components/App.tsx' }),
    status: 'running',
  }),
  complete: createToolCall({
    toolName: 'Edit',
    input: JSON.stringify({
      file_path: '/src/utils.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    }),
    status: 'complete',
    result: 'File edited successfully.',
  }),
  error: createToolCall({
    toolName: 'Write',
    input: JSON.stringify({ file_path: '/readonly/file.ts', content: '...' }),
    status: 'error',
    result: 'EACCES: permission denied',
  }),
};

export const TOOL_CALL_APPROVAL: ToolCallState = createToolCall({
  toolName: 'Bash',
  input: JSON.stringify({ command: 'rm -rf node_modules && npm install' }),
  status: 'pending',
  interactiveType: 'approval',
});

export const TOOL_CALL_QUESTION: ToolCallState = createToolCall({
  toolName: 'AskUserQuestion',
  input: JSON.stringify({
    question: 'Which testing framework do you prefer?',
  }),
  status: 'pending',
  interactiveType: 'question',
  questions: [
    {
      header: 'Framework',
      question: 'Which testing framework should we use?',
      options: [
        { label: 'Vitest', description: 'Fast, Vite-native test runner' },
        { label: 'Jest', description: 'Battle-tested, widely adopted' },
        { label: 'Playwright', description: 'Browser-based E2E testing' },
      ],
      multiSelect: false,
    },
  ],
});

export const SAMPLE_TASKS: TaskItem[] = [
  createTaskItem({
    subject: 'Set up project structure',
    status: 'completed',
    activeForm: 'Setting up project structure',
  }),
  createTaskItem({
    subject: 'Implement authentication service',
    status: 'in_progress',
    activeForm: 'Implementing authentication service',
    description: 'Add JWT-based auth with refresh tokens',
  }),
  createTaskItem({
    subject: 'Write unit tests for auth',
    status: 'pending',
    description: 'Cover login, logout, and token refresh flows',
  }),
  createTaskItem({
    subject: 'Add rate limiting middleware',
    status: 'pending',
  }),
];

export const SAMPLE_MESSAGES: ChatMessage[] = [
  // Plain text user message
  createUserMessage({
    content: 'Can you refactor the authentication module to use JWT tokens?',
  }),

  // Assistant with markdown + code
  createAssistantMessage({
    content: `I'll refactor the authentication module to use JWT tokens. Here's the plan:

1. Replace session-based auth with JWT
2. Add token refresh logic
3. Update the middleware

\`\`\`typescript
import jwt from 'jsonwebtoken';

export function generateToken(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {
    expiresIn: '15m',
  });
}
\`\`\`

Let me start by updating the auth service.`,
  }),

  // Command message
  createUserMessage({
    content: '/review src/auth.ts',
    messageType: 'command',
    commandName: 'review',
    commandArgs: 'src/auth.ts',
  }),

  // Compaction message
  createUserMessage({
    content: 'Previous messages have been summarized to save context.',
    messageType: 'compaction',
  }),

  // Message with file attachments (encoded in content)
  createUserMessage({
    content:
      'Here is the config file I mentioned.\n\n[File: config.json (uploaded)]',
  }),

  // Assistant with tool calls
  createAssistantMessage({
    content: "I'll read the existing auth implementation first.",
    toolCalls: [TOOL_CALLS.complete],
    parts: [
      { type: 'text', text: "I'll read the existing auth implementation first." },
      {
        type: 'tool_call',
        toolCallId: TOOL_CALLS.complete.toolCallId,
        toolName: 'Edit',
        input: TOOL_CALLS.complete.input,
        result: TOOL_CALLS.complete.result,
        status: 'complete',
      },
    ],
  }),

  // Assistant with approval pending
  createAssistantMessage({
    content: 'I need to run the test suite to verify the changes.',
    toolCalls: [TOOL_CALL_APPROVAL],
    parts: [
      { type: 'text', text: 'I need to run the test suite to verify the changes.' },
      {
        type: 'tool_call',
        toolCallId: TOOL_CALL_APPROVAL.toolCallId,
        toolName: TOOL_CALL_APPROVAL.toolName,
        input: TOOL_CALL_APPROVAL.input,
        status: 'pending',
        interactiveType: 'approval',
      },
    ],
  }),

  // Assistant with question
  createAssistantMessage({
    content: 'I have a question about your preferences.',
    toolCalls: [TOOL_CALL_QUESTION],
    parts: [
      { type: 'text', text: 'I have a question about your preferences.' },
      {
        type: 'tool_call',
        toolCallId: TOOL_CALL_QUESTION.toolCallId,
        toolName: TOOL_CALL_QUESTION.toolName,
        input: TOOL_CALL_QUESTION.input,
        status: 'pending',
        interactiveType: 'question',
        questions: TOOL_CALL_QUESTION.questions,
      },
    ],
  }),
];

export const SAMPLE_QUESTIONS: QuestionItem[] = [
  {
    header: 'Framework',
    question: 'Which testing framework should we use?',
    options: [
      { label: 'Vitest', description: 'Fast, Vite-native test runner' },
      { label: 'Jest', description: 'Battle-tested, widely adopted' },
    ],
    multiSelect: false,
  },
  {
    header: 'Features',
    question: 'Which features do you want to enable?',
    options: [
      { label: 'Dark mode', description: 'Support for dark theme' },
      { label: 'Notifications', description: 'Push notification support' },
      { label: 'Analytics', description: 'Usage tracking' },
    ],
    multiSelect: true,
  },
];

export const SAMPLE_FILES: PendingFile[] = [
  createPendingFile({
    file: new File(['hello'], 'readme.md', { type: 'text/markdown' }),
    status: 'pending',
    progress: 0,
  }),
  createPendingFile({
    file: new File(['data'], 'report.csv', { type: 'text/csv' }),
    status: 'uploading',
    progress: 45,
  }),
  createPendingFile({
    file: new File(['done'], 'config.json', { type: 'application/json' }),
    status: 'uploaded',
    progress: 100,
    result: { savedPath: '/uploads/config.json', originalName: 'config.json', filename: 'config.json', size: 4, mimeType: 'application/json' },
  }),
  createPendingFile({
    file: new File(['err'], 'huge.bin', { type: 'application/octet-stream' }),
    status: 'error',
    progress: 12,
    error: 'File too large (max 10 MB)',
  }),
  createPendingFile({
    file: new File(['img'], 'screenshot.png', { type: 'image/png' }),
    status: 'pending',
    progress: 0,
  }),
];

export const SAMPLE_QUEUE: QueueItem[] = [
  createQueueItem({ content: 'Then add error handling to the auth endpoint' }),
  createQueueItem({ content: 'Finally, update the API docs' }),
  createQueueItem({ content: '/test src/auth.test.ts' }),
];
