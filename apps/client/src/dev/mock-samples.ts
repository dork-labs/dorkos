import type { ChatMessage, ToolCallState } from '@/layers/features/chat/model/chat-types';
import type { PendingFile } from '@/layers/features/chat/model/use-file-upload';
import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import type { TaskItem, QuestionItem, BackgroundTaskPart, ErrorPart } from '@dorkos/shared/types';
import {
  createAssistantMessage,
  createUserMessage,
  createToolCall,
  createTaskItem,
  createPendingFile,
  createQueueItem,
} from './mock-factories';
import { TOOL_CALLS, TOOL_CALL_APPROVAL, TOOL_CALL_QUESTION } from './mock-tool-calls';

// ---------------------------------------------------------------------------
// Subagent parts
// ---------------------------------------------------------------------------

export const BACKGROUND_TASK_PARTS: Record<string, BackgroundTaskPart> = {
  running: {
    type: 'background_task',
    taskId: 'task-running',
    taskType: 'agent',
    status: 'running',
    startedAt: Date.now(),
    description: 'Exploring codebase for authentication patterns',
    toolUses: 7,
    lastToolName: 'Grep',
    durationMs: 12400,
  },
  complete: {
    type: 'background_task',
    taskId: 'task-complete',
    taskType: 'agent',
    status: 'complete',
    startedAt: Date.now() - 45000,
    description: 'Research best practices for JWT auth',
    toolUses: 12,
    durationMs: 45000,
    summary: 'Found 3 viable approaches. Recommended: RS256 with rotating keys.',
  },
  error: {
    type: 'background_task',
    taskId: 'task-error',
    taskType: 'agent',
    status: 'error',
    startedAt: Date.now() - 8500,
    description: 'Run integration test suite',
    toolUses: 2,
    durationMs: 8500,
    summary: 'Process exited with code 1: ECONNREFUSED localhost:5432',
  },
  minimal: {
    type: 'background_task',
    taskId: 'task-minimal',
    taskType: 'agent',
    status: 'running',
    startedAt: Date.now(),
    description: 'Quick file search',
  },
  stopped: {
    type: 'background_task',
    taskId: 'task-stopped',
    taskType: 'agent',
    status: 'stopped',
    startedAt: Date.now() - 30000,
    description: 'Deep analysis of auth patterns',
    toolUses: 15,
    durationMs: 30000,
    summary: 'Stopped by user.',
  },
  bash_running: {
    type: 'background_task',
    taskId: 'task-bash-running',
    taskType: 'bash',
    status: 'running',
    startedAt: Date.now() - 120000,
    command: 'npm run dev',
    durationMs: 120000,
  },
  bash_build: {
    type: 'background_task',
    taskId: 'task-bash-build',
    taskType: 'bash',
    status: 'running',
    startedAt: Date.now() - 15000,
    command: 'pnpm build --filter=@dorkos/client',
    durationMs: 15000,
  },
  bash_complete: {
    type: 'background_task',
    taskId: 'task-bash-complete',
    taskType: 'bash',
    status: 'complete',
    startedAt: Date.now() - 45000,
    command: 'pnpm test -- --run',
    durationMs: 45000,
  },
  bash_error: {
    type: 'background_task',
    taskId: 'task-bash-error',
    taskType: 'bash',
    status: 'error',
    startedAt: Date.now() - 8000,
    command: 'docker compose up -d',
    durationMs: 8000,
    summary: 'Process exited with code 1: port 5432 already in use',
  },
};

// ---------------------------------------------------------------------------
// Error parts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sample tasks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sample messages
// ---------------------------------------------------------------------------

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
    content: 'Here is the config file I mentioned.\n\n[File: config.json (uploaded)]',
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

// ---------------------------------------------------------------------------
// Sample questions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Multi-question variants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sample files and queue
// ---------------------------------------------------------------------------

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
    result: {
      savedPath: '/uploads/config.json',
      originalName: 'config.json',
      filename: 'config.json',
      size: 4,
      mimeType: 'application/json',
    },
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

// ---------------------------------------------------------------------------
// Command palette mock data
// ---------------------------------------------------------------------------

export const SAMPLE_COMMANDS: import('@dorkos/shared/types').CommandEntry[] = [
  {
    namespace: 'built-in',
    command: 'commit',
    fullCommand: '/commit',
    description: 'Stage and commit changes with a generated message',
  },
  {
    namespace: 'built-in',
    command: 'test',
    fullCommand: '/test',
    description: 'Run the test suite',
    argumentHint: '<file-or-pattern>',
  },
  {
    namespace: 'built-in',
    command: 'review',
    fullCommand: '/review',
    description: 'Review code changes in the current branch',
  },
  {
    namespace: 'linear',
    command: 'idea',
    fullCommand: '/linear:idea',
    description: 'Quick-capture an idea into Linear',
    argumentHint: '<idea text>',
  },
  {
    namespace: 'linear',
    command: 'done',
    fullCommand: '/linear:done',
    description: 'Report completion and close the loop on an issue',
  },
  {
    namespace: 'adr',
    command: 'create',
    fullCommand: '/adr:create',
    description: 'Create a new Architecture Decision Record',
    argumentHint: '<title>',
  },
  {
    namespace: 'adr',
    command: 'list',
    fullCommand: '/adr:list',
    description: 'List all ADRs with status',
  },
];

/** Commands with long text — descriptions, argument hints, and deeply nested namespaces. */
export const SAMPLE_COMMANDS_LONG: import('@dorkos/shared/types').CommandEntry[] = [
  {
    namespace: 'app',
    command: 'upgrade',
    fullCommand: '/app:upgrade',
    description:
      'Comprehensive dependency upgrade with security audit, prioritization, and validation',
  },
  {
    namespace: 'app',
    command: 'cleanup',
    fullCommand: '/app:cleanup',
    description:
      'Comprehensive code cleanup using Knip and best practices for codebase maintenance',
  },
  {
    namespace: 'chat',
    command: 'self-test',
    fullCommand: '/chat:self-test',
    description:
      'Self-test the DorkOS chat UI in a live browser session — drives real interactions, monitors JSONL transcript, compares API vs UI, researches issues, and produces an evidence-based findings report',
    argumentHint: '[url] [focus:area1,area2]',
  },
  {
    namespace: 'debug',
    command: 'rubber-duck',
    fullCommand: '/debug:rubber-duck',
    description:
      'Structured problem articulation using rubber duck debugging methodology to systematically work through complex bugs',
    argumentHint: '[brief-problem-description]',
  },
  {
    namespace: 'debug',
    command: 'api',
    fullCommand: '/debug:api',
    description:
      'Debug API and data flow issues by tracing through Component -> TanStack Query -> Express Route -> Service -> SQLite/JSONL',
    argumentHint: '[endpoint-or-feature] [--url <url>]',
  },
  {
    namespace: 'debug',
    command: 'performance',
    fullCommand: '/debug:performance',
    description:
      'Diagnose performance issues including slow renders, bundle size, N+1 queries, and memory leaks',
    argumentHint: '[area-or-symptom] [--url <url>]',
  },
  {
    namespace: 'adr',
    command: 'review',
    fullCommand: '/adr:review',
    description:
      'Review proposed ADRs for lifecycle progression — accept implemented decisions, deprecate stale ones, archive trivial ones',
    argumentHint: '[spec-slug | ADR-number | --all]',
  },
  {
    namespace: 'template',
    command: 'update',
    fullCommand: '/template:update',
    description:
      'Update project from upstream template with selective file updates and conflict resolution',
    argumentHint:
      '[all|harness|guides|selective] [--dry-run] [--verbose] [--force] [--version <tag>]',
  },
  {
    namespace: 'research',
    command: 'curate',
    fullCommand: '/research:curate',
    description:
      'Curate research files — inventory by type, identify stale/superseded candidates, update frontmatter status',
  },
  {
    namespace: 'review-recent-work',
    command: 'review-recent-work',
    fullCommand: '/review-recent-work',
    description:
      'Trace through recent code changes to verify implementation correctness and completeness',
  },
];

// ---------------------------------------------------------------------------
// File palette mock data
// ---------------------------------------------------------------------------

export const SAMPLE_FILE_ENTRIES: Array<
  import('@/layers/shared/lib').FileEntry & { indices: number[] }
> = [
  {
    path: 'src/services/auth/auth-handler.ts',
    filename: 'auth-handler.ts',
    directory: 'src/services/auth/',
    isDirectory: false,
    indices: [18, 19, 20, 21], // "auth" in filename
  },
  {
    path: 'src/services/auth/',
    filename: 'auth',
    directory: 'src/services/',
    isDirectory: true,
    indices: [0, 1, 2, 3],
  },
  {
    path: 'src/routes/api/sessions.ts',
    filename: 'sessions.ts',
    directory: 'src/routes/api/',
    isDirectory: false,
    indices: [0, 1, 2, 3, 4, 5, 6, 7], // "sessions" in filename
  },
  {
    path: 'src/lib/logger.ts',
    filename: 'logger.ts',
    directory: 'src/lib/',
    isDirectory: false,
    indices: [],
  },
  {
    path: 'packages/shared/src/types.ts',
    filename: 'types.ts',
    directory: 'packages/shared/src/',
    isDirectory: false,
    indices: [],
  },
  {
    path: 'AGENTS.md',
    filename: 'AGENTS.md',
    directory: '',
    isDirectory: false,
    indices: [],
  },
];
