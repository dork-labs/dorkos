import { createUserMessage, createAssistantMessage, createToolCall, createHookState } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';
import type { SubagentPart } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const USER_MSG = createUserMessage({
  id: 'sim-dr-user',
  content: 'Refactor our API routes from Express callbacks to a typed router pattern with input validation, error handling, and comprehensive tests.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-dr-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

// ---------------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------------

const INTRO = "That's a substantial refactoring task. I'll work through this systematically — first exploring the current route structure, then designing the new typed router pattern, and finally implementing the changes with tests. Let me start by mapping out the existing routes.\n\n";

const POST_GREP = "\n\nI found 8 route files across the API. Let me read the main ones to understand the current patterns before designing the new approach.\n\n";

const POST_READS = `\n\nI can see the pattern clearly now. The current routes have several issues:

1. **No input validation** — Request bodies are used directly without any schema validation
2. **Inconsistent error handling** — Some routes use try/catch, others let errors propagate to the global handler
3. **No type safety** — Request and response types are implicit, not enforced
4. **Duplicated middleware** — Authentication and logging are repeated in each route

I'll design a typed router that addresses all of these. Let me research the best approach for Express type-safe routing.\n\n`;

const POST_RESEARCH = `\n\nBased on the research, I'll create a \`createTypedRoute\` helper that wraps Express handlers with Zod validation and standardized error handling. Here's the architecture:

\`\`\`typescript
// New pattern
const getSession = createTypedRoute({
  method: 'get',
  path: '/api/sessions/:id',
  params: z.object({ id: z.string().uuid() }),
  response: SessionResponseSchema,
  handler: async ({ params }) => {
    const session = await sessionService.getById(params.id);
    if (!session) throw new NotFoundError('Session not found');
    return session;
  },
});
\`\`\`

Let me start implementing this. I'll begin with the core \`createTypedRoute\` utility, then migrate each route file.\n\n`;

const POST_CORE_WRITE = "\n\nThe core utility is written. Now let me create the error classes that the typed routes will throw.\n\n";

const POST_ERRORS_WRITE = "\n\nGood. Now let me migrate the session routes — they're the most complex and will validate the pattern.\n\n";

const POST_SESSIONS = "\n\nThe session routes are migrated. Let me now handle the agent routes, which have the most validation logic.\n\n";

const POST_AGENTS = "\n\nAgent routes are done. Let me migrate the remaining routes: health, config, and pulse.\n\n";

const POST_REMAINING = "\n\nAll routes migrated. Now I need to write comprehensive tests. Let me create the test file with coverage for validation, error handling, and happy paths.\n\n";

const POST_TESTS = "\n\nTests are written. Let me run the full suite to make sure everything passes. I'll also run the linter to catch any style issues.\n\n";

const FINAL_SUMMARY = `Refactoring complete. Here's a summary of all changes:

### New Files
- \`src/lib/typed-route.ts\` — Core \`createTypedRoute\` utility with Zod validation
- \`src/lib/api-errors.ts\` — Standardized error classes (NotFoundError, ValidationError, etc.)
- \`src/routes/__tests__/typed-routes.test.ts\` — 24 tests covering all route behaviors

### Modified Files
- \`src/routes/sessions.ts\` — Migrated 6 endpoints to typed pattern
- \`src/routes/agents.ts\` — Migrated 5 endpoints with input validation
- \`src/routes/health.ts\` — Migrated 2 endpoints
- \`src/routes/config.ts\` — Migrated 3 endpoints
- \`src/routes/pulse.ts\` — Migrated 4 endpoints
- \`src/middleware/error-handler.ts\` — Updated to handle typed API errors

### Key Improvements
- **Type safety**: All request/response shapes are validated at runtime via Zod
- **Consistent errors**: Every route returns structured error responses with proper HTTP status codes
- **No duplication**: Auth and logging middleware are applied once at the router level
- **Test coverage**: 24 tests covering validation, error handling, auth, and happy paths

All 24 tests pass and the linter is clean.`;

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const GREP_TOOL = createToolCall({
  toolCallId: 'sim-dr-grep',
  toolName: 'Grep',
  input: JSON.stringify({ pattern: 'router\\.(get|post|put|delete)', path: 'src/routes/' }),
  status: 'pending',
});

const READ_SESSIONS = createToolCall({
  toolCallId: 'sim-dr-read1',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/routes/sessions.ts' }),
  status: 'pending',
});

const READ_AGENTS = createToolCall({
  toolCallId: 'sim-dr-read2',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/routes/agents.ts' }),
  status: 'pending',
});

const READ_HEALTH = createToolCall({
  toolCallId: 'sim-dr-read3',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/src/routes/health.ts' }),
  status: 'pending',
});

const SUBAGENT: SubagentPart = {
  type: 'subagent',
  taskId: 'sim-dr-sub',
  description: 'Research typed Express router patterns and Zod integration approaches',
  status: 'running',
  toolUses: 5,
  lastToolName: 'WebSearch',
  durationMs: 12400,
};

const WRITE_CORE = createToolCall({
  toolCallId: 'sim-dr-write1',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/lib/typed-route.ts', content: '...' }),
  status: 'pending',
});

const WRITE_ERRORS = createToolCall({
  toolCallId: 'sim-dr-write2',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/lib/api-errors.ts', content: '...' }),
  status: 'pending',
});

const EDIT_SESSIONS = createToolCall({
  toolCallId: 'sim-dr-edit1',
  toolName: 'Edit',
  input: JSON.stringify({ file_path: '/src/routes/sessions.ts', old_string: 'router.get', new_string: 'createTypedRoute' }),
  status: 'pending',
});

const EDIT_AGENTS = createToolCall({
  toolCallId: 'sim-dr-edit2',
  toolName: 'Edit',
  input: JSON.stringify({ file_path: '/src/routes/agents.ts', old_string: 'router.post', new_string: 'createTypedRoute' }),
  status: 'pending',
});

const EDIT_REMAINING = createToolCall({
  toolCallId: 'sim-dr-edit3',
  toolName: 'Edit',
  input: JSON.stringify({ file_path: '/src/routes/health.ts', old_string: 'router.get', new_string: 'createTypedRoute' }),
  status: 'pending',
  hooks: [
    createHookState({
      hookId: 'sim-dr-hook',
      hookName: 'pre-edit-lint',
      hookEvent: 'PreToolUse',
      status: 'running',
    }),
  ],
});

const WRITE_TESTS = createToolCall({
  toolCallId: 'sim-dr-write3',
  toolName: 'Write',
  input: JSON.stringify({ file_path: '/src/routes/__tests__/typed-routes.test.ts', content: '...' }),
  status: 'pending',
});

const BASH_TEST = createToolCall({
  toolCallId: 'sim-dr-bash1',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm vitest run src/routes/__tests__/typed-routes.test.ts --reporter=verbose' }),
  status: 'pending',
});

const BASH_LINT = createToolCall({
  toolCallId: 'sim-dr-bash2',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'pnpm eslint src/routes/ src/lib/typed-route.ts src/lib/api-errors.ts' }),
  status: 'pending',
});

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** Long multi-file refactoring session with many tool calls, subagent, and extensive text — designed to produce scrollable content. */
export const deepRefactor: SimScenario = {
  id: 'deep-refactor',
  title: 'Deep Refactoring (Long)',
  description: 'Multi-file refactor: 8 routes migrated, 24 tests, hooks, subagent',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', INTRO),
    { type: 'set_streaming', isTextStreaming: false },

    // Grep
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: GREP_TOOL, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-grep', patch: { status: 'running' }, delayMs: 1200 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-grep',
      patch: { status: 'complete', result: 'src/routes/sessions.ts:15,22,34,48,62,78\nsrc/routes/agents.ts:12,28,41,55,68\nsrc/routes/health.ts:8,14\nsrc/routes/config.ts:10,18,26\nsrc/routes/pulse.ts:12,20,31,42\nsrc/routes/relay.ts:8,15\nsrc/routes/mesh.ts:10,22\nsrc/routes/discovery.ts:8' },
      delayMs: 400,
    },

    // Post-grep text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_GREP),
    { type: 'set_streaming', isTextStreaming: false },

    // Read sessions
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: READ_SESSIONS, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-read1', patch: { status: 'running' }, delayMs: 1600 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-read1',
      patch: { status: 'complete', result: 'import { Router } from "express";\n\nconst router = Router();\n\nrouter.get("/api/sessions", async (req, res) => {\n  try {\n    const sessions = await sessionService.list();\n    res.json(sessions);\n  } catch (err) {\n    res.status(500).json({ error: "Internal error" });\n  }\n});\n\nrouter.get("/api/sessions/:id", async (req, res) => {\n  const session = await sessionService.getById(req.params.id);\n  res.json(session); // No null check!\n});\n\n// ... 4 more routes' },
      delayMs: 600,
    },

    // Read agents
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: READ_AGENTS, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-read2', patch: { status: 'running' }, delayMs: 1400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-read2',
      patch: { status: 'complete', result: 'router.post("/api/agents", async (req, res) => {\n  const agent = await agentService.create(req.body); // No validation!\n  res.status(201).json(agent);\n});\n\nrouter.put("/api/agents/:id", async (req, res) => {\n  const agent = await agentService.update(req.params.id, req.body);\n  res.json(agent);\n});' },
      delayMs: 400,
    },

    // Read health
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: READ_HEALTH, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-read3', patch: { status: 'running' }, delayMs: 1000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-read3',
      patch: { status: 'complete', result: 'router.get("/health", (req, res) => {\n  res.json({ status: "ok", uptime: process.uptime() });\n});' },
      delayMs: 400,
    },

    // Post-reads analysis
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_READS),
    { type: 'set_streaming', isTextStreaming: false },

    // Subagent research
    { type: 'append_part', messageId: 'sim-dr-asst', part: SUBAGENT, delayMs: 6000 },

    // Post-research architecture text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_RESEARCH),
    { type: 'set_streaming', isTextStreaming: false },

    // Write core utility
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: WRITE_CORE, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-write1', patch: { status: 'running' }, delayMs: 2000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-write1',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    // Post-core text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_CORE_WRITE),
    { type: 'set_streaming', isTextStreaming: false },

    // Write error classes
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: WRITE_ERRORS, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-write2', patch: { status: 'running' }, delayMs: 1400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-write2',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    // Post-errors text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_ERRORS_WRITE),
    { type: 'set_streaming', isTextStreaming: false },

    // Edit sessions
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: EDIT_SESSIONS, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-edit1', patch: { status: 'running' }, delayMs: 2400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-edit1',
      patch: { status: 'complete', result: 'File edited successfully. 6 routes migrated.' },
      delayMs: 400,
    },

    // Post-sessions text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_SESSIONS),
    { type: 'set_streaming', isTextStreaming: false },

    // Edit agents
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: EDIT_AGENTS, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-edit2', patch: { status: 'running' }, delayMs: 2000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-edit2',
      patch: { status: 'complete', result: 'File edited successfully. 5 routes migrated.' },
      delayMs: 400,
    },

    // Post-agents text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_AGENTS),
    { type: 'set_streaming', isTextStreaming: false },

    // Edit remaining (with hook)
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: EDIT_REMAINING, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-edit3', patch: { status: 'running' }, delayMs: 1800 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-edit3',
      patch: {
        status: 'complete',
        result: 'File edited successfully. 9 routes migrated across health, config, pulse.',
        hooks: [
          createHookState({
            hookId: 'sim-dr-hook',
            hookName: 'pre-edit-lint',
            hookEvent: 'PreToolUse',
            status: 'success',
            stdout: 'All files passed linting.',
          }),
        ],
      },
      delayMs: 400,
    },

    // Post-remaining text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_REMAINING),
    { type: 'set_streaming', isTextStreaming: false },

    // Write tests
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: WRITE_TESTS, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-write3', patch: { status: 'running' }, delayMs: 2400 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-write3',
      patch: { status: 'complete', result: 'File written successfully.' },
      delayMs: 400,
    },

    // Post-tests text
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', POST_TESTS),
    { type: 'set_streaming', isTextStreaming: false },

    // Run tests
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: BASH_TEST, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-bash1', patch: { status: 'running' }, delayMs: 4000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-bash1',
      patch: {
        status: 'complete',
        result: '✓ GET /api/sessions returns list (12ms)\n✓ GET /api/sessions/:id returns session (8ms)\n✓ GET /api/sessions/:id returns 404 for unknown (5ms)\n✓ POST /api/sessions validates input (6ms)\n✓ DELETE /api/sessions/:id returns 204 (4ms)\n✓ GET /api/agents returns list (10ms)\n✓ POST /api/agents validates required fields (7ms)\n✓ POST /api/agents rejects invalid input (4ms)\n✓ PUT /api/agents/:id updates agent (9ms)\n✓ PUT /api/agents/:id returns 404 for unknown (5ms)\n✓ DELETE /api/agents/:id returns 204 (3ms)\n✓ GET /health returns status (2ms)\n✓ GET /health/detailed returns metrics (4ms)\n✓ GET /api/config returns config (3ms)\n✓ PUT /api/config validates schema (6ms)\n✓ PUT /api/config rejects unknown keys (4ms)\n✓ GET /api/pulse/schedules returns list (8ms)\n✓ POST /api/pulse/schedules validates cron (5ms)\n✓ PUT /api/pulse/schedules/:id updates (7ms)\n✓ DELETE /api/pulse/schedules/:id returns 204 (3ms)\n✓ Error handler formats ValidationError (2ms)\n✓ Error handler formats NotFoundError (2ms)\n✓ Error handler formats AuthError (2ms)\n✓ Error handler returns 500 for unknown errors (2ms)\n\nTest Files  1 passed (1)\nTests      24 passed (24)\nDuration   0.14s',
      },
      delayMs: 600,
    },

    // Run lint
    { type: 'append_tool_call', messageId: 'sim-dr-asst', toolCall: BASH_LINT, delayMs: 200 },
    { type: 'update_tool_call', messageId: 'sim-dr-asst', toolCallId: 'sim-dr-bash2', patch: { status: 'running' }, delayMs: 2000 },
    {
      type: 'update_tool_call',
      messageId: 'sim-dr-asst',
      toolCallId: 'sim-dr-bash2',
      patch: { status: 'complete', result: 'No lint errors found.' },
      delayMs: 400,
    },

    // Final summary
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-dr-asst', FINAL_SUMMARY),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
