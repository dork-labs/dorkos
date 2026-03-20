import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';

const USER_MSG = createUserMessage({
  id: 'sim-ap-user',
  content: 'Clean install the dependencies and run the build.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-ap-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const INTRO_TEXT =
  "I'll need to run a destructive command to clean install the dependencies. This will remove the existing `node_modules` directory and reinstall everything from scratch. Let me ask for your approval before proceeding.\n\n";

const APPROVAL_TOOL = createToolCall({
  toolCallId: 'sim-ap-tool',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'rm -rf node_modules && npm install' }),
  status: 'pending',
  interactiveType: 'approval',
});

const BUILD_TEXT =
  '\n\nDependencies installed successfully. Now let me run the build to make sure everything compiles cleanly.\n\n';

const BUILD_TOOL = createToolCall({
  toolCallId: 'sim-ap-build',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm build' }),
  status: 'pending',
});

const FOLLOWUP_TEXT =
  'Build completed successfully. All 12 packages compiled without errors. The clean install resolved the dependency conflicts that were causing issues previously — the lockfile is now consistent with `package.json` across all workspaces.';

/** Demonstrates text → approval pending → approved → build → summary. */
export const toolApproval: SimScenario = {
  id: 'tool-approval',
  title: 'Tool Approval',
  description: 'Streaming text → approval request → auto-approved → build → summary',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ap-asst', INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Approval tool call
    { type: 'append_tool_call', messageId: 'sim-ap-asst', toolCall: APPROVAL_TOOL },
    { type: 'set_waiting', isWaiting: true, waitingType: 'approval', delayMs: 5000 },

    // Auto-approve
    { type: 'set_waiting', isWaiting: false },
    {
      type: 'update_tool_call',
      messageId: 'sim-ap-asst',
      toolCallId: 'sim-ap-tool',
      patch: { status: 'running' },
      delayMs: 3000,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-ap-asst',
      toolCallId: 'sim-ap-tool',
      patch: {
        status: 'complete',
        result:
          'added 1247 packages in 8.3s\n\n127 packages are looking for funding\n  run `npm fund` for details',
      },
      delayMs: 600,
    },

    // Build text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ap-asst', BUILD_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Build tool
    { type: 'append_tool_call', messageId: 'sim-ap-asst', toolCall: BUILD_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ap-asst',
      toolCallId: 'sim-ap-build',
      patch: { status: 'running' },
      delayMs: 4000,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-ap-asst',
      toolCallId: 'sim-ap-build',
      patch: {
        status: 'complete',
        result:
          '12 packages built in 14.2s\n\n@dorkos/shared: 0.8s\n@dorkos/db: 1.1s\n@dorkos/cli: 2.3s\n@dorkos/server: 3.4s\n@dorkos/client: 6.6s',
      },
      delayMs: 600,
    },

    // Followup text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ap-asst', FOLLOWUP_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
