import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';
import type { SubagentPart } from '@dorkos/shared/types';

const USER_MSG = createUserMessage({
  id: 'sim-ks-user',
  content: 'Build a complete authentication system with JWT, refresh tokens, and tests.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-ks-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const INTRO_TEXT = "I'll build a complete auth system with JWT access tokens, refresh token rotation, and comprehensive test coverage. Let me start by exploring the codebase to understand the existing structure and dependencies.\n\n";

const READ_TOOL = createToolCall({
  toolCallId: 'sim-ks-read',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/config.ts' }),
  status: 'pending',
});

const SUBAGENT_PART: SubagentPart = {
  type: 'subagent',
  taskId: 'sim-ks-sub',
  description: 'Research JWT best practices and token rotation patterns',
  status: 'running',
  toolUses: 3,
  lastToolName: 'WebSearch',
  durationMs: 8200,
};

const MIDDLE_TEXT = "\n\nBased on the research, here's the implementation plan. I want to confirm the token storage approach before proceeding — this is an important security decision.\n\n";

const QUESTION_TOOL = createToolCall({
  toolCallId: 'sim-ks-question',
  toolName: 'AskUserQuestion',
  input: JSON.stringify({
    question: 'Where should refresh tokens be stored?',
  }),
  status: 'pending',
  interactiveType: 'question',
  questions: [
    {
      header: 'Storage',
      question: 'Where should refresh tokens be stored?',
      options: [
        { label: 'httpOnly cookie (Recommended)', description: 'Most secure, prevents XSS access' },
        { label: 'localStorage', description: 'Simpler, but vulnerable to XSS' },
        { label: 'In-memory only', description: 'Most secure but lost on page refresh' },
      ],
      multiSelect: false,
    },
  ],
});

const POST_QUESTION_TEXT = "\n\nPerfect. I'll use httpOnly cookies for refresh tokens — that's the most secure approach since they can't be accessed via JavaScript. Now let me implement the auth module.\n\n";

const WRITE_TOOL = createToolCall({
  toolCallId: 'sim-ks-write',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/services/auth.ts', content: '...' }),
  status: 'pending',
});

const POST_WRITE_TEXT = "\n\nThe auth module is written. Now I need to run the test suite, which requires executing shell commands. Let me ask for approval.\n\n";

const APPROVAL_TOOL = createToolCall({
  toolCallId: 'sim-ks-approval',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm vitest run --reporter=verbose' }),
  status: 'pending',
  interactiveType: 'approval',
});

const FINAL_TEXT = "Authentication system is complete. All tests pass and the JWT implementation follows best practices:\n\n- **Access tokens** use RS256 signing with 15-minute expiry\n- **Refresh tokens** stored in httpOnly cookies with 7-day expiry and automatic rotation\n- **Key rotation** happens every 24 hours with graceful old-key acceptance\n- **12 tests** cover token generation, validation, refresh flow, rotation, and error cases\n\nThe system is production-ready and resistant to common attack vectors like XSS token theft and replay attacks.";

/** Demonstrates all message types in sequence: text → tools → subagent → question → approval → done. */
export const kitchenSink: SimScenario = {
  id: 'kitchen-sink',
  title: 'Kitchen Sink',
  description: 'All message types: text, tools, subagent, question, approval',
  steps: [
    // User message + intro
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ks-asst', INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Read tool
    { type: 'append_tool_call', messageId: 'sim-ks-asst', toolCall: READ_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ks-asst', toolCallId: 'sim-ks-read', patch: { status: 'running' }, delayMs: 1200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ks-asst',
      toolCallId: 'sim-ks-read',
      patch: { status: 'complete', result: 'export const config = {\n  jwtSecret: process.env.JWT_SECRET,\n  tokenExpiry: "15m",\n  refreshExpiry: "7d",\n}' },
      delayMs: 600,
    },

    // Subagent
    { type: 'append_part', messageId: 'sim-ks-asst', part: SUBAGENT_PART, delayMs: 5000 },

    // Middle text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ks-asst', MIDDLE_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Question
    { type: 'append_tool_call', messageId: 'sim-ks-asst', toolCall: QUESTION_TOOL },
    { type: 'set_waiting', isWaiting: true, waitingType: 'question', delayMs: 5000 },
    { type: 'set_waiting', isWaiting: false },
    {
      type: 'update_tool_call',
      messageId: 'sim-ks-asst',
      toolCallId: 'sim-ks-question',
      patch: {
        status: 'complete',
        answers: { 'Where should refresh tokens be stored?': 'httpOnly cookie (Recommended)' },
      },
      delayMs: 600,
    },

    // Post-question text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ks-asst', POST_QUESTION_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Write tool
    { type: 'append_tool_call', messageId: 'sim-ks-asst', toolCall: WRITE_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-ks-asst', toolCallId: 'sim-ks-write', patch: { status: 'running' }, delayMs: 1600 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ks-asst',
      toolCallId: 'sim-ks-write',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    // Post-write text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ks-asst', POST_WRITE_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Approval tool
    { type: 'append_tool_call', messageId: 'sim-ks-asst', toolCall: APPROVAL_TOOL },
    { type: 'set_waiting', isWaiting: true, waitingType: 'approval', delayMs: 4000 },
    { type: 'set_waiting', isWaiting: false },
    { type: 'update_tool_call', messageId: 'sim-ks-asst', toolCallId: 'sim-ks-approval', patch: { status: 'running' }, delayMs: 2400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-ks-asst',
      toolCallId: 'sim-ks-approval',
      patch: {
        status: 'complete',
        result: '✓ 12 tests passed\n\nTest Files  3 passed (3)\nTests      12 passed (12)',
      },
      delayMs: 600,
    },

    // Final summary
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-ks-asst', FINAL_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
