import {
  createUserMessage,
  createAssistantMessage,
  createToolCall,
  createHookState,
} from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';
import type { SubagentPart } from '@dorkos/shared/types';

const USER_MSG = createUserMessage({
  id: 'sim-mt-user',
  content: 'Refactor the auth module and add comprehensive tests.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-mt-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const INTRO_TEXT =
  "I'll start by exploring the codebase to understand the current auth implementation, then refactor it and add comprehensive test coverage. Let me begin with a search to find all auth-related files.\n\n";

const GREP_TOOL = createToolCall({
  toolCallId: 'sim-mt-grep',
  toolName: 'Grep',
  input: JSON.stringify({ pattern: 'authenticate', path: 'src/' }),
  status: 'pending',
});

const READ_TOOL = createToolCall({
  toolCallId: 'sim-mt-read',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/services/auth.ts' }),
  status: 'pending',
});

const READ2_TOOL = createToolCall({
  toolCallId: 'sim-mt-read2',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/middleware/session.ts' }),
  status: 'pending',
});

const SUBAGENT_PART: SubagentPart = {
  type: 'subagent',
  taskId: 'sim-mt-sub',
  description: 'Research JWT best practices for token rotation',
  status: 'running',
  toolUses: 0,
};

const POST_READ_TEXT =
  '\n\nI can see the auth module uses an older pattern with shared secrets. Let me also check the session middleware to understand the full authentication flow.\n\n';

const WRITE_TOOL = createToolCall({
  toolCallId: 'sim-mt-write',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/services/auth.test.ts', content: '...' }),
  status: 'pending',
  hooks: [
    createHookState({
      hookId: 'sim-mt-hook-lint',
      hookName: 'pre-write-lint',
      hookEvent: 'PreToolUse',
      status: 'running',
    }),
  ],
});

const BASH_TOOL = createToolCall({
  toolCallId: 'sim-mt-bash',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm vitest run src/services/auth.test.ts' }),
  status: 'pending',
});

const MIDDLE_TEXT =
  "\n\nThe subagent found good patterns for token rotation. Based on the research, I'll refactor the auth module to use RS256 with key rotation and write comprehensive tests. Let me create the test file first.\n\n";

const SUMMARY_TEXT =
  "Refactoring complete. The auth module now uses RS256 with rotating keys instead of shared HS256 secrets. Here's what changed:\n\n- Replaced `jwt.sign()` with asymmetric RS256 signing\n- Added automatic key rotation every 24 hours\n- Updated the session middleware to validate against the key registry\n- Added 8 comprehensive tests covering token generation, validation, rotation, and edge cases\n\nAll 8 tests pass and the linting hook confirmed clean code.";

/** Demonstrates a complex multi-tool chain with hooks and subagent blocks. */
export const multiToolChain: SimScenario = {
  id: 'multi-tool-chain',
  title: 'Multi-Tool Chain',
  description: 'Grep → Read → subagent → Write (with hook) → Bash',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-mt-asst', INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Grep
    { type: 'append_tool_call', messageId: 'sim-mt-asst', toolCall: GREP_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-grep',
      patch: { status: 'running' },
      delayMs: 1200,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-grep',
      patch: {
        status: 'complete',
        result: 'src/services/auth.ts:12\nsrc/middleware/session.ts:8\nsrc/routes/login.ts:24',
      },
      delayMs: 400,
    },

    // Read
    { type: 'append_tool_call', messageId: 'sim-mt-asst', toolCall: READ_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-read',
      patch: { status: 'running' },
      delayMs: 1400,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-read',
      patch: {
        status: 'complete',
        result:
          'export function authenticate(token: string) {\n  // legacy implementation\n  return jwt.verify(token, SECRET);\n}',
      },
      delayMs: 600,
    },

    // Post-read text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-mt-asst', POST_READ_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Read 2
    { type: 'append_tool_call', messageId: 'sim-mt-asst', toolCall: READ2_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-read2',
      patch: { status: 'running' },
      delayMs: 1400,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-read2',
      patch: {
        status: 'complete',
        result:
          'export function sessionMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(" ")[1];\n  if (!token) return res.status(401).json({ error: "Unauthorized" });\n  req.user = authenticate(token);\n  next();\n}',
      },
      delayMs: 600,
    },

    // Subagent part appended to the assistant message
    { type: 'append_part', messageId: 'sim-mt-asst', part: SUBAGENT_PART, delayMs: 4000 },

    // Middle text after subagent
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-mt-asst', MIDDLE_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Write with hook
    { type: 'append_tool_call', messageId: 'sim-mt-asst', toolCall: WRITE_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-write',
      patch: { status: 'running' },
      delayMs: 800,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-write',
      patch: {
        status: 'complete',
        result: 'File written successfully.',
        hooks: [
          createHookState({
            hookId: 'sim-mt-hook-lint',
            hookName: 'pre-write-lint',
            hookEvent: 'PreToolUse',
            status: 'success',
            stdout: 'All files passed linting.',
          }),
        ],
      },
      delayMs: 400,
    },

    // Bash test
    { type: 'append_tool_call', messageId: 'sim-mt-asst', toolCall: BASH_TOOL, delayMs: 200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-bash',
      patch: { status: 'running' },
      delayMs: 3000,
    },
    {
      type: 'update_tool_call',
      messageId: 'sim-mt-asst',
      toolCallId: 'sim-mt-bash',
      patch: {
        status: 'complete',
        result:
          '✓ src/services/auth.test.ts (8 tests) 67ms\n\nTest Files  1 passed (1)\nTests       8 passed (8)',
      },
      delayMs: 600,
    },

    // Summary
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-mt-asst', SUMMARY_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
