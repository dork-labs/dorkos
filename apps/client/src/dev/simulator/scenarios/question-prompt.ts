import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';

const USER_MSG = createUserMessage({
  id: 'sim-qp-user',
  content: 'Set up the testing infrastructure for this project.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-qp-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const INTRO_TEXT =
  'Before I set up the testing infrastructure, I want to understand your preferences so I can make the right choices. There are several viable approaches and I want to make sure we pick the one that fits your workflow best.\n\n';

const QUESTION_TOOL = createToolCall({
  toolCallId: 'sim-qp-tool',
  toolName: 'AskUserQuestion',
  input: JSON.stringify({
    question: 'Which testing framework should we use?',
  }),
  status: 'pending',
  interactiveType: 'question',
  questions: [
    {
      header: 'Framework',
      question: 'Which testing framework should we use for this project?',
      options: [
        {
          label: 'Vitest (Recommended)',
          description: 'Fast, Vite-native, excellent TypeScript support',
        },
        { label: 'Jest', description: 'Battle-tested, widely adopted, rich ecosystem' },
        { label: 'Playwright', description: 'Browser-based E2E testing with great DX' },
      ],
      multiSelect: false,
    },
  ],
});

const MIDDLE_TEXT =
  "\n\nGreat choice. Vitest is the best fit for this project since you're already using Vite. Let me also check what testing utilities are already installed.\n\n";

const READ_TOOL = createToolCall({
  toolCallId: 'sim-qp-read',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/package.json' }),
  status: 'pending',
});

const FOLLOWUP_TEXT = `\n\nI'll set up Vitest with the following configuration:

- \`vitest.config.ts\` with jsdom environment for component testing
- React Testing Library for component tests with user-event helpers
- Coverage reporting via \`@vitest/coverage-v8\` with branch thresholds
- Test files co-located in \`__tests__/\` directories alongside source
- A shared \`test-setup.ts\` for global mocks (matchMedia, ResizeObserver, etc.)
- Mock utilities for the Transport interface via \`createMockTransport()\`

This setup follows the same patterns used by the DorkOS monorepo and ensures tests run fast with minimal configuration overhead.`;

/** Demonstrates text → AskUserQuestion → answered → tool call → text. */
export const questionPrompt: SimScenario = {
  id: 'question-prompt',
  title: 'Question Prompt',
  description: 'Text → interactive question → auto-answered → tool → follow-up',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-qp-asst', INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Question tool call
    { type: 'append_tool_call', messageId: 'sim-qp-asst', toolCall: QUESTION_TOOL },
    { type: 'set_waiting', isWaiting: true, waitingType: 'question', delayMs: 6000 },

    // Auto-answer
    { type: 'set_waiting', isWaiting: false },
    {
      type: 'update_tool_call',
      messageId: 'sim-qp-asst',
      toolCallId: 'sim-qp-tool',
      patch: {
        status: 'complete',
        answers: {
          'Which testing framework should we use for this project?': 'Vitest (Recommended)',
        },
      },
      delayMs: 600,
    },

    // Middle text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-qp-asst', MIDDLE_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Read package.json
    { type: 'append_tool_call', messageId: 'sim-qp-asst', toolCall: READ_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-qp-asst',
      toolCallId: 'sim-qp-read',
      patch: { status: 'running' },
      delayMs: 1200,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-qp-asst',
      toolCallId: 'sim-qp-read',
      patch: {
        status: 'complete',
        result:
          '{\n  "name": "my-project",\n  "devDependencies": {\n    "vite": "^6.0.0",\n    "typescript": "^5.7.0"\n  }\n}',
      },
      delayMs: 400,
    },

    // Followup text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-qp-asst', FOLLOWUP_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
