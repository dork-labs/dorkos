import type { ChatMessage, ToolCallState } from '@/layers/features/chat/model/chat-types';
import type { PendingFile } from '@/layers/features/composer';
import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import { queueDowngradeNotice } from '@/layers/features/chat/lib/queue-chips';
import type {
  TaskItem,
  QuestionItem,
  BackgroundTaskPart,
  ContextUsage,
  ErrorPart,
} from '@dorkos/shared/types';
import type { SessionDiagnostics } from '@/layers/features/status';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { IdentityStatus } from '@/layers/shared/ui';
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
  // The ending nobody witnessed (DOR-1108). Deliberately carries no summary: the
  // whole point is that there is nothing to report, so this is the sample that
  // shows the card explaining ITSELF rather than showing the agent's words.
  untracked: {
    type: 'background_task',
    taskId: 'task-untracked',
    taskType: 'agent',
    status: 'untracked',
    startedAt: Date.now() - 240000,
    description: 'Run the dev server in the background',
    toolUses: 2,
    durationMs: 240000,
  },
  streaming: {
    type: 'background_task',
    taskId: 'task-streaming',
    taskType: 'agent',
    status: 'running',
    startedAt: Date.now() - 6000,
    description: 'Audit error handling across the API layer',
    toolUses: 4,
    lastToolName: 'Read',
    durationMs: 6000,
    toolUseId: 'toolu_streaming_1',
    // Live-forwarded subagent text (SDK forwardSubagentText) — expand to watch.
    subagentText:
      "I'm starting by mapping the route handlers in apps/server/src/routes. " +
      'Each handler delegates to a service, so I’ll trace the error paths there.\n\n' +
      'Found three handlers that swallow errors without surfacing a category. ' +
      'Checking whether the shared ErrorEvent schema covers these cases next…',
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

/** A queue whose rows did not all come from this window, and one with a notice. */
export const SAMPLE_QUEUE_MIXED_ORIGINS: QueueItem[] = [
  createQueueItem({ content: 'Then add error handling to the auth endpoint' }),
  createQueueItem({ content: 'Finally, update the API docs', mine: false }),
  createQueueItem({
    content: 'And change course on the migration',
    // The real notice, through the real mapping — so the showcase shows exactly
    // what a person sees when a steer is queued because the runtime cannot steer.
    notice: queueDowngradeNotice({
      messageId: 'demo-downgraded',
      requested: 'steer',
      applied: 'queue',
      degradedBecause: 'unsupported',
    }),
  }),
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

// ---------------------------------------------------------------------------
// Session readout snapshots (the right panel's Session tab)
// ---------------------------------------------------------------------------

/** A warm context breakdown, largest category first once the readout sorts it. */
const SESSION_CONTEXT_USAGE: ContextUsage = {
  totalTokens: 176_000,
  maxTokens: 200_000,
  percentage: 88,
  model: 'claude-opus-4-6',
  categories: [
    { name: 'System prompt', tokens: 11_400, color: '#8b5cf6' },
    { name: 'Messages', tokens: 148_200, color: '#3b82f6' },
    { name: 'Tools', tokens: 16_400, color: '#14b8a6' },
    { name: 'Memory', tokens: 0, color: '#f59e0b' },
  ],
};

/**
 * Three snapshots of one session for the Session-readout showcase: healthy,
 * degraded (the state the surface exists for), and cold.
 */
export const SESSION_DIAGNOSTICS: Record<'healthy' | 'degraded' | 'cold', SessionDiagnostics> = {
  healthy: {
    sessionId: '9f3c1b7a-2e4d-4f18-9c02-7a6b5d3e1f88',
    cwd: '/Users/dev/work/dorkos',
    git: { state: 'repo', branch: 'dor-460-session-tab', dirty: true },
    runtime: 'claude-code',
    model: 'claude-opus-4-6',
    selectedModel: 'default',
    effort: 'high',
    fastMode: false,
    permissionMode: 'plan',
    contextPercent: 88,
    contextUsage: SESSION_CONTEXT_USAGE,
    cache: { readTokens: 142_000, creationTokens: 9_400, contextTokens: 176_000 },
    usage: {
      kind: 'subscription',
      utilization: 0.42,
      windowLabel: '5-hour window',
      resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      state: 'ok',
    },
    connectionState: 'connected',
    streaming: true,
    lifecycle: 'streaming',
    triggerPending: false,
    lastEventSeq: 1_284,
    snapshotCursor: 1_190,
    lastEventAt: Date.now() - 1_200,
    queueDepth: 0,
    subagents: [
      { name: 'researcher', description: 'Reads the codebase before you do', model: 'haiku' },
      { name: 'reviewer', description: 'Checks a diff against the rubric' },
    ],
    activeSubagents: [
      {
        taskId: 'task-1',
        status: 'running',
        description: 'Trace every caller of useSessionStatus',
        toolUses: 7,
        lastToolName: 'Grep',
      },
      // A finished row, because the fold keeps them for the whole turn: the
      // showcase has to show that they land under "Finished this turn" and not
      // under "Running".
      {
        taskId: 'task-0',
        status: 'complete',
        description: 'Read the spec',
        toolUses: 3,
        lastToolName: 'Read',
        summary: 'Summarised §2',
      },
    ],
    runningSubagentCount: 1,
    clientVersion: '0.56.0',
  },
  degraded: {
    sessionId: '9f3c1b7a-2e4d-4f18-9c02-7a6b5d3e1f88',
    cwd: '/Users/dev/work/dorkos',
    git: { state: 'repo', branch: 'dor-460-session-tab', dirty: true },
    runtime: 'codex',
    model: 'gpt-5-codex',
    selectedModel: 'gpt-5-codex',
    effort: 'medium',
    fastMode: true,
    permissionMode: 'bypassPermissions',
    contextPercent: 94,
    contextUsage: SESSION_CONTEXT_USAGE,
    cache: null,
    usage: { kind: 'pay-as-you-go', costUsd: 4.12 },
    connectionState: 'reconnecting',
    streaming: true,
    lifecycle: 'streaming',
    triggerPending: true,
    lastEventSeq: 1_190,
    snapshotCursor: 1_190,
    // Four minutes with nothing applied while the turn claims to be streaming —
    // the exact state this surface exists to make visible.
    lastEventAt: Date.now() - 4 * 60 * 1000,
    queueDepth: 3,
    subagents: [],
    activeSubagents: [
      {
        taskId: 'task-9',
        status: 'running',
        description: 'Rewrite the migration',
        toolUses: 31,
        lastToolName: 'Edit',
      },
    ],
    // Two by the server's count, one by this client's fold — a dropped frame,
    // which on a silent stream is exactly the kind of thing worth seeing.
    runningSubagentCount: 2,
    clientVersion: '0.56.0',
  },
  cold: {
    sessionId: 'c0ld0000-0000-4000-8000-000000000000',
    cwd: null,
    git: { state: 'unknown' },
    runtime: null,
    model: null,
    selectedModel: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    contextPercent: null,
    contextUsage: null,
    cache: null,
    usage: null,
    connectionState: 'connecting',
    streaming: false,
    lifecycle: null,
    triggerPending: false,
    lastEventSeq: 0,
    snapshotCursor: null,
    lastEventAt: null,
    queueDepth: 0,
    subagents: [],
    activeSubagents: [],
    runningSubagentCount: null,
    clientVersion: null,
  },
};

// ---------------------------------------------------------------------------
// Identity surfaces — MentionPill, IdentityHoverCard, IdentityAvatar
// ---------------------------------------------------------------------------

/**
 * The whole live-state vocabulary an identity's corner dot can say, with the
 * words a showcase captions each one with.
 *
 * One list, imported by every showcase that draws the states, so the playground
 * cannot end up showing three different state systems for the fact this repo
 * spent a release drawing five different ways (DOR-1052).
 */
export const IDENTITY_STATUSES: readonly { status: IdentityStatus; label: string }[] = [
  { status: 'idle', label: 'idle — no dot' },
  { status: 'working', label: 'working — pulses' },
  { status: 'needs-you', label: 'needs you — still' },
  { status: 'error', label: 'error — still' },
];

/**
 * One identity as the phase-1 identity surfaces need it. Deliberately not
 * `AuthorRef` — that's the wire shape a later slice resolves mentions and
 * avatars against; this is only what a presentational component reads.
 * `MentionPill` and `IdentityHoverCard` each pull a couple of these fields
 * under their own prop name (`label` vs. `displayName`), so one mock per
 * identity covers both showcases.
 */
export interface MockIdentity {
  kind: 'human' | 'agent' | 'system';
  displayName: string;
  handle?: string;
  color?: string;
  emoji?: string;
  /** A photo, when this identity has one — the face the disc draws over the emoji. */
  imageUrl?: string;
  origin?: 'local' | { platform: string };
  agent?: {
    runtime?: string;
    model?: string;
    working?: { forMs: number };
    /** Owner attribution (spec `identity-consistency` W1.6) — the hover card's fourth chip. */
    managedBy?: { displayName: string; handle: string | null };
  };
}

/**
 * A 16x16 PNG, inline, so the playground needs no network and no fixture file.
 * A gradient rather than a face: it has to read as "a photo is here" at 20px.
 */
const MOCK_PHOTO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAACRElEQVR42g3Loa6FIAAA0PdhN9PcLBZnpLlZKM5IY7NQhGBgFJwbM8jYKCSDJDY2C8nEdzxPP38/UAB4a5Bb8EAQBxBGcGHgZ+AWcAqgd7AZID1Yb8ASoH+/qoDqravcVg+s4lCFsbpw5efKLdUpKr1Xm6mkr9a7Yqn6QlNA89ZNbpsHNnFowthcuPFz45bmFI3em8000jfr3bDUfKEroHvrLrfdA7s4dGHsLtz5uXNLd4pO791mOum79e5Y6r4AC4BvDXMLHwjjAMMILwz9DN0CTwH1DjcDpYfrDVmCX+gL6N+6z23/wD4OfRj7C/d+7t3Sn6LXe7+ZXvp+vXuW+i+gAtBbo9yiB6I4oDCiCyM/I7egUyC9o80g6dF6I5bQF6YCpreecjs9cIrDFMbpwpOfJ7dMp5j0Pm1mkn5a74ml6Qu4APzWOLf4gTgOOIz4wtjP2C34FFjveDNYerzemCX8BVIAeWuSW/JAEgcSRnJh4mfiFnIKoneyGSI9WW/CEvkCLYC+Nc0tfSCNAw0jvTD1M3ULPQXVO90MlZ6uN2WJfoEXwN+a55Y/kMeBh5FfmPuZu4Wfguudb4ZLz9ebs8S/IAoQby1yKx4o4iDCKC4s/CzcIk4h9C42I6QX6y1YEl9QBai3VrlVD1RxUGFUF1Z+Vm5Rp1B6V5tR0qv1ViypLxwFHG995PZ44BGHI4zHhQ8/H245TnHo/djMIf2x3gdLxxdsAfatbW7tA20cbBjtha2frVvsKaze7Was9Ha9LUuW/gP2ssBwaAAcBgAAAABJRU5ErkJggg==';

/**
 * The cast the identity showcases draw from: an agent with a live working
 * chip, an agent with none, a local person, a person carrying a photo, a
 * bridged external person, a room's own system voice, and the edge cases the
 * design doc calls out by name — a long name/handle pair, a light fill with no
 * emoji (the case `readableForeground` exists for), and multi-codepoint ZWJ
 * emoji.
 */
export const MOCK_IDENTITIES: Record<string, MockIdentity> = {
  warden: {
    kind: 'agent',
    displayName: 'Warden',
    handle: 'warden',
    color: '#6d5ae0',
    emoji: '🛡️',
    agent: {
      runtime: 'Claude Code',
      model: 'Opus 4.8',
      working: { forMs: 134_000 },
      managedBy: { displayName: 'Dorian', handle: 'dorian' },
    },
  },
  scout: {
    kind: 'agent',
    displayName: 'Scout',
    handle: 'scout',
    color: '#12a594',
    emoji: '🔭',
    agent: {
      runtime: 'Claude Code',
      model: 'Sonnet 5',
      // The other managed-by fallback: an owner the roster knows by name but
      // not yet by handle. Never a bare "@" — the display name stands in.
      managedBy: { displayName: 'Priya', handle: null },
    },
  },
  // No `managedBy` at all — today's honest state for every real card, since
  // no production caller populates it yet (that lands with the Team page).
  // Sits beside `warden`/`scout` so the three owner-attribution states —
  // handle, name-only, and no chip — are visible in the same row.
  courier: {
    kind: 'agent',
    displayName: 'Courier',
    handle: 'courier',
    color: '#e11d48',
    emoji: '📦',
    agent: { runtime: 'Claude Code', model: 'Sonnet 5' },
  },
  ana: {
    kind: 'human',
    displayName: 'Ana',
    handle: 'ana',
    origin: 'local',
  },
  // The photo case. A person, because the upload surface is for people only —
  // an agent's identity language is its emoji and its colour. The emoji sits
  // beside the photo on purpose: the disc draws the photo and the emoji is what
  // it falls back to, which is the precedence this cast member exists to show.
  photographed: {
    kind: 'human',
    displayName: 'Dorian',
    handle: 'dorian',
    color: '#0ea5e9',
    emoji: '🐙',
    imageUrl: MOCK_PHOTO,
    origin: 'local',
  },
  priya: {
    kind: 'human',
    displayName: 'Priya',
    handle: 'priya',
    origin: { platform: 'Telegram' },
  },
  roomNotice: {
    kind: 'system',
    displayName: 'General',
  },
  // Both halves are deliberately long, and the NAME is the longer of the two:
  // the pill wraps a long handle within a line, while a fixed-width identity row
  // truncates a long name — two different behaviours that need one cast member
  // long enough to trigger each. A name that merely looks long (40 characters)
  // fits the row it was meant to overflow and quietly proves nothing.
  longHandle: {
    kind: 'agent',
    displayName: 'Codebase Migration Orchestrator for the Northern Monorepo (staging)',
    handle: 'codebase-migration-orchestrator-v2',
    color: '#d4770a',
  },
  // No `emoji` — the fallback letter has to pick its own contrast against a
  // pale fill rather than assume white, exactly the case `readableForeground`
  // was added for.
  noEmojiFill: {
    kind: 'agent',
    displayName: 'Relay',
    handle: 'relay',
    color: '#fde68a',
  },
  multiCodepointEmoji: {
    kind: 'agent',
    displayName: 'Pair',
    handle: 'pair',
    color: '#0ea5e9',
    emoji: '🧑‍💻',
  },
  externalFlag: {
    kind: 'agent',
    displayName: 'Privateer',
    handle: 'privateer',
    color: '#334155',
    emoji: '🏴‍☠️',
  },
};

// ---------------------------------------------------------------------------
// Team roster (spec `identity-consistency` §W2.2, §W2.6)
// ---------------------------------------------------------------------------

/**
 * A roster the product cannot produce yet, which is exactly why it exists.
 *
 * Two people, four agents and two owners. The spec's binding rule for the Buzz
 * future (§W2.6) is that no component may branch on "there is exactly one
 * person" — a rule that only means anything if something in the repo draws a
 * second one. This is that something: the playground renders the real Team page
 * against it, and the page's jsdom tests assert grouping, the owner filter and
 * the chips against these same rows, so the showcase and the tests cannot drift
 * into disagreeing about what a two-person install looks like.
 *
 * The edge cases the card has to survive ride along rather than living in a
 * second fixture: a person bridged in from another platform with a qualified
 * handle, an agent that belongs to nobody (the system one), an agent with no
 * handle at all, and a name long enough to need truncating.
 */
export const MOCK_TEAM_ROSTER: TeamMember[] = [
  {
    id: 'person-dorian',
    kind: 'human',
    displayName: 'Dorian',
    handle: 'dorian',
    color: '#6d5ae0',
    isSelf: true,
    ownerId: null,
    origin: 'local',
    person: { role: null, email: 'dorian@dorkos.ai', lastSeenAt: new Date().toISOString() },
  },
  {
    id: 'person-miguel',
    kind: 'human',
    displayName: 'Miguel Ferreira-Santos',
    // Qualified, because two platforms can each hold a `miguel` and the roster
    // has to be able to say which one this is.
    handle: 'miguel.telegram',
    color: '#0ea5e9',
    // The roster's photo case. On the SELF row it would be redundant with the
    // Account Menu and Profile Tab showcases, which already draw one; here it
    // also proves the Team card draws a photo for somebody who is not you —
    // the surface that silently dropped `imageUrl` until `teamMemberFace`
    // (DOR-979 review, N2).
    imageUrl: MOCK_PHOTO,
    isSelf: false,
    ownerId: null,
    origin: { platform: 'telegram' },
    // Nothing on this install dates a bridged person's presence, so the roster
    // says `null` rather than guessing — the case the header renders as the
    // platform line instead of "Last seen …".
    person: { role: null, lastSeenAt: null },
  },
  {
    id: 'agent-warden',
    kind: 'agent',
    displayName: 'Warden',
    handle: 'warden',
    color: '#6d5ae0',
    emoji: '🛡️',
    isSelf: false,
    ownerId: 'person-dorian',
    origin: 'local',
    agent: {
      manifestId: 'agent-warden',
      runtime: 'claude-code',
      model: 'opus-4.8',
      healthStatus: 'active',
      recentlyActive: true,
      projectPath: '/Users/dorian/agents/warden',
      // Mid-turn: the state the status sentence renders as
      // "Working in #team · 5 min".
      activity: {
        working: {
          roomId: 'room-team',
          roomName: 'team',
          since: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
        lastActiveAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
      isDefault: true,
      isSystem: false,
      registeredAt: '2026-07-01T09:00:00.000Z',
    },
  },
  {
    id: 'agent-scout',
    kind: 'agent',
    displayName: 'Scout',
    handle: 'scout',
    color: '#f59e0b',
    emoji: '🔭',
    isSelf: false,
    ownerId: 'person-dorian',
    origin: 'local',
    agent: {
      manifestId: 'agent-scout',
      runtime: 'codex',
      healthStatus: 'stale',
      recentlyActive: false,
      projectPath: '/Users/dorian/agents/scout',
      // Idle: "Last active 3 h ago".
      activity: {
        working: null,
        lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
      isDefault: false,
      isSystem: false,
      registeredAt: '2026-07-04T14:20:00.000Z',
    },
  },
  {
    id: 'agent-cartographer',
    kind: 'agent',
    displayName: 'Cartographer of the Northern Reaches',
    // Never been in a room, so there is nothing to address it by.
    handle: null,
    color: '#0ea5e9',
    emoji: '🗺️',
    isSelf: false,
    ownerId: 'person-miguel',
    origin: 'local',
    agent: {
      manifestId: 'agent-cartographer',
      runtime: 'opencode',
      model: 'qwen3-coder',
      healthStatus: 'inactive',
      recentlyActive: false,
      // Never run: "Hasn't run yet", which is a different sentence from idle.
      activity: { working: null, lastActiveAt: null },
      isDefault: false,
      isSystem: false,
      registeredAt: '2026-07-06T11:05:00.000Z',
    },
  },
  {
    id: 'agent-dorkbot',
    kind: 'agent',
    displayName: 'DorkBot',
    handle: 'dorkbot',
    color: '#334155',
    emoji: '🤖',
    isSelf: false,
    // The system agent belongs to the install, not to a person.
    ownerId: null,
    origin: 'local',
    agent: {
      manifestId: 'agent-dorkbot',
      runtime: 'claude-code',
      healthStatus: 'active',
      recentlyActive: true,
      projectPath: '/Users/dorian/.dork/agents/dorkbot',
      activity: {
        working: null,
        lastActiveAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      },
      isDefault: false,
      isSystem: true,
      registeredAt: '2026-06-20T08:00:00.000Z',
    },
  },
];
