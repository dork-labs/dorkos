import type { ChatMessage, ToolCallState, HookState } from '@/layers/features/chat/model/chat-types';
import type { PendingFile } from '@/layers/features/chat/model/use-file-upload';
import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import type { TaskItem, QuestionItem, SubagentPart, ErrorPart } from '@dorkos/shared/types';

/** Shared mock session ID for playground demos that require a session context. */
export const MOCK_SESSION_ID = 'playground-session-001';

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
  running_with_progress: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'pnpm vitest run --reporter=verbose' }),
    status: 'running',
    progressOutput:
      '✓ src/utils.test.ts (3 tests) 12ms\n' +
      '✓ src/auth.test.ts (5 tests) 45ms\n' +
      '✓ src/api/sessions.test.ts (8 tests) 123ms\n' +
      '✗ src/api/agents.test.ts > AgentManager > handles timeout\n' +
      '  AssertionError: expected 408 to equal 504\n' +
      '    at Object.<anonymous> (src/api/agents.test.ts:47:18)\n' +
      '✓ src/hooks/use-theme.test.ts (2 tests) 8ms\n' +
      '⠋ Running src/components/ChatPanel.test.tsx...',
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
  complete_long_result: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'cat apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts' }),
    status: 'complete',
    result: Array.from({ length: 200 }, (_, i) => `${String(i + 1).padStart(4, ' ')}│ ${'import { foo } from "bar";  // line content here that makes this realistic output'.slice(0, 60 + (i % 20))}`).join('\n'),
  }),
};

export const TOOL_CALLS_EXTENDED: Record<string, ToolCallState> = {
  task_get: createToolCall({
    toolName: 'TaskGet',
    input: JSON.stringify({ taskId: '3' }),
    status: 'complete',
    result: '{ "id": "3", "subject": "Write unit tests", "status": "pending" }',
  }),
  notebook_edit: createToolCall({
    toolName: 'NotebookEdit',
    input: JSON.stringify({ notebook_path: '/notebooks/analysis.ipynb', new_source: 'df.describe()' }),
    status: 'complete',
    result: 'Cell updated.',
  }),
  enter_plan_mode: createToolCall({
    toolName: 'EnterPlanMode',
    input: JSON.stringify({}),
    status: 'complete',
  }),
  exit_plan_mode: createToolCall({
    toolName: 'ExitPlanMode',
    input: JSON.stringify({}),
    status: 'complete',
  }),
  tool_search: createToolCall({
    toolName: 'ToolSearch',
    input: JSON.stringify({ query: 'slack message send' }),
    status: 'complete',
    result: 'Found 3 tools: mcp__slack__send_message, mcp__slack__read_channel, mcp__slack__list_channels',
  }),
  list_mcp_resources: createToolCall({
    toolName: 'ListMcpResourcesTool',
    input: JSON.stringify({ server: 'context7' }),
    status: 'complete',
    result: '3 resources found',
  }),
  read_mcp_resource: createToolCall({
    toolName: 'ReadMcpResourceTool',
    input: JSON.stringify({ server: 'context7', uri: 'docs://react/hooks/useState' }),
    status: 'complete',
    result: 'useState documentation content...',
  }),
};

/** Create a hook state with sensible defaults. */
export function createHookState(
  overrides: Partial<HookState> = {}
): HookState {
  return {
    hookId: nextId('hook'),
    hookName: 'pre-commit-lint',
    hookEvent: 'PreToolUse',
    status: 'running',
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

export const TOOL_CALLS_WITH_HOOKS: Record<string, ToolCallState> = {
  hook_running: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'git commit -m "feat: add auth"' }),
    status: 'running',
    hooks: [
      createHookState({
        hookName: 'pre-commit-lint',
        hookEvent: 'PreToolUse',
        status: 'running',
      }),
    ],
  }),
  hook_success: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'git commit -m "feat: add auth"' }),
    status: 'complete',
    result: '[main abc1234] feat: add auth',
    hooks: [
      createHookState({
        hookName: 'pre-commit-lint',
        hookEvent: 'PreToolUse',
        status: 'success',
        stdout: 'All files passed linting.',
      }),
    ],
  }),
  hook_error: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'git push origin main' }),
    status: 'complete',
    result: 'Push completed.',
    hooks: [
      createHookState({
        hookName: 'pre-push-tests',
        hookEvent: 'PreToolUse',
        status: 'error',
        stderr: 'FAIL src/auth.test.ts\n  ✗ should validate JWT token (12ms)\n    Expected: 200\n    Received: 401',
        exitCode: 1,
      }),
    ],
  }),
  hook_cancelled: createToolCall({
    toolName: 'Write',
    input: JSON.stringify({ file_path: '/src/config.ts', content: '...' }),
    status: 'complete',
    result: 'File written.',
    hooks: [
      createHookState({
        hookName: 'validate-config',
        hookEvent: 'PostToolUse',
        status: 'cancelled',
      }),
    ],
  }),
  multi_hooks: createToolCall({
    toolName: 'Bash',
    input: JSON.stringify({ command: 'npm publish' }),
    status: 'complete',
    result: 'Published @dorkos/cli@1.2.0',
    hooks: [
      createHookState({
        hookName: 'pre-publish-lint',
        hookEvent: 'PreToolUse',
        status: 'success',
        stdout: 'Lint passed.',
      }),
      createHookState({
        hookName: 'pre-publish-tests',
        hookEvent: 'PreToolUse',
        status: 'success',
        stdout: '42 tests passed.',
      }),
      createHookState({
        hookName: 'post-publish-notify',
        hookEvent: 'PostToolUse',
        status: 'error',
        stderr: 'ECONNREFUSED: Slack webhook unreachable',
        exitCode: 1,
      }),
    ],
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

export const SUBAGENT_PARTS: Record<string, SubagentPart> = {
  running: {
    type: 'subagent',
    taskId: 'subagent-running',
    description: 'Exploring codebase for authentication patterns',
    status: 'running',
    toolUses: 7,
    lastToolName: 'Grep',
    durationMs: 12400,
  },
  complete: {
    type: 'subagent',
    taskId: 'subagent-complete',
    description: 'Research best practices for JWT auth',
    status: 'complete',
    toolUses: 12,
    durationMs: 45000,
    summary: 'Found 3 viable approaches. Recommended: RS256 with rotating keys.',
  },
  error: {
    type: 'subagent',
    taskId: 'subagent-error',
    description: 'Run integration test suite',
    status: 'error',
    toolUses: 2,
    durationMs: 8500,
    summary: 'Process exited with code 1: ECONNREFUSED localhost:5432',
  },
  minimal: {
    type: 'subagent',
    taskId: 'subagent-minimal',
    description: 'Quick file search',
    status: 'running',
  },
};

export const ERROR_PARTS: Record<string, ErrorPart> = {
  max_turns: {
    type: 'error',
    message: 'Agent exceeded the maximum number of turns (25)',
    category: 'max_turns',
  },
  execution_error: {
    type: 'error',
    message: 'Anthropic API returned 500: Internal Server Error',
    category: 'execution_error',
    details:
      'Error: API request failed with status 500\n  at ClaudeClient.sendMessage (sdk/client.ts:142)\n  at AgentLoop.step (sdk/agent.ts:89)\n  at AgentLoop.run (sdk/agent.ts:45)',
  },
  budget_exceeded: {
    type: 'error',
    message: 'Session cost ($2.47) exceeded budget limit ($2.00)',
    category: 'budget_exceeded',
  },
  output_format_error: {
    type: 'error',
    message: 'Failed to produce valid JSON after 3 retries',
    category: 'output_format_error',
  },
  uncategorized: {
    type: 'error',
    message: 'Something went wrong during processing.',
  },
};

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
  {
    header: 'Deploy',
    question: 'Where should we deploy?',
    options: [
      { label: 'Vercel', description: 'Edge-first, zero-config deploys' },
      { label: 'Fly.io', description: 'Run containers close to users' },
      { label: 'Self-hosted', description: 'Docker on your own infra' },
    ],
    multiSelect: false,
  },
];

export const TOOL_CALL_MULTI_QUESTION: ToolCallState = createToolCall({
  toolName: 'AskUserQuestion',
  input: JSON.stringify({ questions: SAMPLE_QUESTIONS }),
  status: 'pending',
  interactiveType: 'question',
  questions: SAMPLE_QUESTIONS,
});

/** Assistant message with multi-question tool call for showcase use. */
export const SAMPLE_MESSAGE_MULTI_QUESTION: ChatMessage = createAssistantMessage({
  content: 'I have a couple of questions before proceeding.',
  toolCalls: [TOOL_CALL_MULTI_QUESTION],
  parts: [
    { type: 'text', text: 'I have a couple of questions before proceeding.' },
    {
      type: 'tool_call',
      toolCallId: TOOL_CALL_MULTI_QUESTION.toolCallId,
      toolName: TOOL_CALL_MULTI_QUESTION.toolName,
      input: TOOL_CALL_MULTI_QUESTION.input,
      status: 'pending',
      interactiveType: 'question',
      questions: TOOL_CALL_MULTI_QUESTION.questions,
    },
  ],
});

const MULTI_SELECT_QUESTION: QuestionItem[] = [
  {
    header: 'Integrations',
    question: 'Which integrations should we enable?',
    options: [
      { label: 'Slack', description: 'Team messaging and notifications' },
      { label: 'GitHub', description: 'Issue tracking and PR automation' },
      { label: 'Linear', description: 'Project management sync' },
      { label: 'Discord', description: 'Community channel updates' },
    ],
    multiSelect: true,
  },
];

export const TOOL_CALL_MULTI_SELECT_QUESTION: ToolCallState = createToolCall({
  toolName: 'AskUserQuestion',
  input: JSON.stringify({ questions: MULTI_SELECT_QUESTION }),
  status: 'pending',
  interactiveType: 'question',
  questions: MULTI_SELECT_QUESTION,
});

/** Assistant message with a multi-select question for showcase use. */
export const SAMPLE_MESSAGE_MULTI_SELECT: ChatMessage = createAssistantMessage({
  content: 'Which integrations would you like?',
  toolCalls: [TOOL_CALL_MULTI_SELECT_QUESTION],
  parts: [
    { type: 'text', text: 'Which integrations would you like?' },
    {
      type: 'tool_call',
      toolCallId: TOOL_CALL_MULTI_SELECT_QUESTION.toolCallId,
      toolName: TOOL_CALL_MULTI_SELECT_QUESTION.toolName,
      input: TOOL_CALL_MULTI_SELECT_QUESTION.input,
      status: 'pending',
      interactiveType: 'question',
      questions: TOOL_CALL_MULTI_SELECT_QUESTION.questions,
    },
  ],
});

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
