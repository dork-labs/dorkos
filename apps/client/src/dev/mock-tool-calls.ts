import type { ToolCallState } from '@/layers/features/chat/model/chat-types';
import { createToolCall, createHookState } from './mock-factories';

// ---------------------------------------------------------------------------
// Pre-built tool call variant sets
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
    input: JSON.stringify({
      command: 'cat apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts',
    }),
    status: 'complete',
    result: Array.from(
      { length: 200 },
      (_, i) =>
        `${String(i + 1).padStart(4, ' ')}│ ${'import { foo } from "bar";  // line content here that makes this realistic output'.slice(0, 60 + (i % 20))}`
    ).join('\n'),
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
    input: JSON.stringify({
      notebook_path: '/notebooks/analysis.ipynb',
      new_source: 'df.describe()',
    }),
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
    result:
      'Found 3 tools: mcp__slack__send_message, mcp__slack__read_channel, mcp__slack__list_channels',
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
    result: 'useState documentation content…',
  }),
};

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
        stderr:
          'FAIL src/auth.test.ts\n  ✗ should validate JWT token (12ms)\n    Expected: 200\n    Received: 401',
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
