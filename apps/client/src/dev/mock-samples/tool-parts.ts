import type { BackgroundTaskPart, ErrorPart } from '@dorkos/shared/types';

/**
 * Background-task subagent-part fixtures — one entry per lifecycle state
 * (`running`, `complete`, `error`, `stopped`, `untracked`, `streaming`) plus
 * the `bash_*` variants for the shell-command flavor of the same part.
 *
 * @module dev/mock-samples/tool-parts
 */
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

/** Error-part fixtures, one per {@link ErrorPart} `category`. */
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
  // The shape both error-rendering fixes are about: a provider auth failure
  // whose ONE actionable instruction is a URL. The friendly "sign in again"
  // copy shows, the provider's own words show under it, and the link is a real,
  // clickable anchor rather than something to retype.
  auth_error: {
    type: 'error',
    message:
      'This request requires more credits. Add credits at https://openrouter.ai/settings/credits',
    category: 'auth_error',
  },
  uncategorized: {
    type: 'error',
    message: 'Something went wrong during processing.',
  },
};
