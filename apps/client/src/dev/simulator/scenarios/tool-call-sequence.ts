import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';

const USER_MSG = createUserMessage({
  id: 'sim-tc-user',
  content: 'Read the auth service and update the JWT expiry to 30 minutes.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-tc-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const INTRO_TEXT = "I'll read the auth service first, then update the JWT expiry. Let me start by locating the relevant file and understanding the current configuration.\n\n";

const GREP_TOOL = createToolCall({
  toolCallId: 'sim-tc-grep',
  toolName: 'Grep',
  input: JSON.stringify({ pattern: 'expiresIn', path: 'src/' }),
  status: 'pending',
});

const READ_TOOL = createToolCall({
  toolCallId: 'sim-tc-read',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/services/auth.ts' }),
  status: 'pending',
});

const MIDDLE_TEXT = "\n\nI can see the JWT token is currently configured with a 15-minute expiry. I'll update that to 30 minutes now.\n\n";

const EDIT_TOOL = createToolCall({
  toolCallId: 'sim-tc-edit',
  toolName: 'Edit',
  input: JSON.stringify({
    file_path: '/src/services/auth.ts',
    old_string: "expiresIn: '15m'",
    new_string: "expiresIn: '30m'",
  }),
  status: 'pending',
});

const VERIFY_TEXT = "\n\nThe edit is done. Let me verify this doesn't break any existing tests by running the auth test suite.\n\n";

const BASH_TOOL = createToolCall({
  toolCallId: 'sim-tc-bash',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm vitest run src/services/auth.test.ts' }),
  status: 'pending',
});

const FOLLOWUP_TEXT =
  "Done. I updated the JWT token expiry from 15 minutes to 30 minutes in `auth.ts`. The change was straightforward — just a single string value update. All 5 tests pass, confirming the expiry change doesn't break token validation or refresh logic.";

/** Demonstrates text → multiple tool calls (pending→running→complete) → text. */
export const toolCallSequence: SimScenario = {
  id: 'tool-call-sequence',
  title: 'Tool Call Sequence',
  description: 'Text → Grep → Read → Edit → Bash tool calls → summary text',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-tc-asst', INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Tool 1: Grep
    { type: 'append_tool_call', messageId: 'sim-tc-asst', toolCall: GREP_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-tc-asst', toolCallId: 'sim-tc-grep', patch: { status: 'running' }, delayMs: 1000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-tc-asst',
      toolCallId: 'sim-tc-grep',
      patch: { status: 'complete', result: 'src/services/auth.ts:14: expiresIn: "15m"\nsrc/services/auth.test.ts:8: expect(decoded.exp)' },
      delayMs: 400,
    },

    // Tool 2: Read
    { type: 'append_tool_call', messageId: 'sim-tc-asst', toolCall: READ_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-tc-asst', toolCallId: 'sim-tc-read', patch: { status: 'running' }, delayMs: 1600 },
    {
      type: 'update_tool_call',
      messageId: 'sim-tc-asst',
      toolCallId: 'sim-tc-read',
      patch: { status: 'complete', result: 'import jwt from "jsonwebtoken";\n\nexport function generateToken(userId: string) {\n  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, {\n    expiresIn: "15m",\n  });\n}\n\nexport function verifyToken(token: string) {\n  return jwt.verify(token, process.env.JWT_SECRET!);\n}' },
      delayMs: 400,
    },

    // Middle text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-tc-asst', MIDDLE_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Tool 3: Edit
    { type: 'append_tool_call', messageId: 'sim-tc-asst', toolCall: EDIT_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-tc-asst', toolCallId: 'sim-tc-edit', patch: { status: 'running' }, delayMs: 1000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-tc-asst',
      toolCallId: 'sim-tc-edit',
      patch: { status: 'complete', result: 'File edited successfully.' },
      delayMs: 400,
    },

    // Verify text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-tc-asst', VERIFY_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Tool 4: Bash
    { type: 'append_tool_call', messageId: 'sim-tc-asst', toolCall: BASH_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-tc-asst', toolCallId: 'sim-tc-bash', patch: { status: 'running' }, delayMs: 2400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-tc-asst',
      toolCallId: 'sim-tc-bash',
      patch: {
        status: 'complete',
        result: '✓ src/services/auth.test.ts (5 tests) 45ms\n\nTest Files  1 passed (1)\nTests       5 passed (5)',
      },
      delayMs: 600,
    },

    // Followup text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-tc-asst', FOLLOWUP_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
