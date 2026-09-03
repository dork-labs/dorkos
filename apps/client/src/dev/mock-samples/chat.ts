import type { ChatMessage, ToolCallState } from '@/layers/features/chat/model/chat-types';
import type { QuestionItem } from '@dorkos/shared/types';
import {
  createAssistantMessage,
  createUserMessage,
  createToolCall,
} from '../mock-factories';
import { TOOL_CALLS, TOOL_CALL_APPROVAL, TOOL_CALL_QUESTION } from '../mock-tool-calls';

/**
 * Sample chat messages — plain text, markdown with code, a command, a
 * compaction notice, a file attachment, a completed tool call, a pending
 * approval, and a pending question.
 *
 * @module dev/mock-samples/chat
 */
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

/** Three questions the {@link SAMPLE_MESSAGE_MULTI_QUESTION} fixture asks at once. */
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
