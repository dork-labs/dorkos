import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';
import type { ErrorPart } from '@dorkos/shared/types';

const USER_MSG = createUserMessage({
  id: 'sim-err-user',
  content: 'Analyze the performance bottleneck in the database layer.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-err-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const INTRO_TEXT =
  "I'll start by profiling the database queries to identify the bottleneck. Let me check the query logs and trace the execution path through the service layer.\n\n";

const READ_TOOL = createToolCall({
  toolCallId: 'sim-err-read',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/services/database.ts' }),
  status: 'pending',
});

const PARTIAL_TEXT =
  "\n\nI found the database service. Looking at the query patterns, there are several N+1 queries in the session listing endpoint. The `listSessions` function fetches each session's metadata in a separate query instead of using a join. Let me trace the";

const ERROR_PART: ErrorPart = {
  type: 'error',
  message: 'Anthropic API returned 500: Internal Server Error',
  category: 'execution_error',
  details:
    'Error: API request failed with status 500\n  at ClaudeClient.sendMessage (sdk/client.ts:142)\n  at AgentLoop.step (sdk/agent.ts:89)',
};

/** Demonstrates streaming text with a tool call that gets interrupted by an execution error. */
export const errorStates: SimScenario = {
  id: 'error-states',
  title: 'Error States',
  description: 'Text → tool call → more text interrupted by an execution error',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-err-asst', INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Read tool
    { type: 'append_tool_call', messageId: 'sim-err-asst', toolCall: READ_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-err-asst',
      toolCallId: 'sim-err-read',
      patch: { status: 'running' },
      delayMs: 1600,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-err-asst',
      toolCallId: 'sim-err-read',
      patch: {
        status: 'complete',
        result:
          'export async function listSessions() {\n  const sessions = await db.query("SELECT id FROM sessions");\n  // N+1 query pattern\n  return Promise.all(sessions.map(s => db.query("SELECT * FROM metadata WHERE session_id = ?", s.id)));\n}',
      },
      delayMs: 400,
    },

    // Partial streaming text before error
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-err-asst', PARTIAL_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 1000 },

    // Error
    { type: 'append_part', messageId: 'sim-err-asst', part: ERROR_PART },
    { type: 'set_status', status: 'error' },
  ],
};
