---
slug: context-builder-agent-refactor
number: 42
created: 2026-02-18
status: tasks-ready
---

# Tasks: Context Builder & agent-manager.ts Refactor

**Spec**: `specs/context-builder-agent-refactor/02-specification.md`
**Total tasks**: 10

---

## Phase 1 — Type Extraction (no behavior change)

### Task 1.1: Create `services/agent-types.ts`

**File**: `apps/server/src/services/agent-types.ts` (~35 lines)
**Dependencies**: None

Extract `AgentSession` interface and `ToolState` interface from `agent-manager.ts` into a new dedicated types file. Update `agent-manager.ts` to import from the new file.

**Create `apps/server/src/services/agent-types.ts`:**

```typescript
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, PermissionMode } from '@dorkos/shared/types';
import type { PendingInteraction } from './interactive-handlers.js';

/** In-memory state for an active agent session. */
export interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  permissionMode: PermissionMode;
  model?: string;
  cwd?: string;
  /** True once the first SDK query has been sent (JSONL file exists) */
  hasStarted: boolean;
  /** Active SDK query object — used for mid-stream control (setPermissionMode, setModel) */
  activeQuery?: Query;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

/** Mutable tool tracking state passed by reference into the event mapper. */
export interface ToolState {
  inTool: boolean;
  currentToolName: string;
  currentToolId: string;
  taskToolInput: string;
  appendTaskInput: (chunk: string) => void;
  resetTaskInput: () => void;
  setToolState: (tool: boolean, name: string, id: string) => void;
}
```

**Update `apps/server/src/services/agent-manager.ts`:**

1. Remove the `AgentSession` interface definition (lines 71-84)
2. Add import: `import type { AgentSession, ToolState } from './agent-types.js';`
3. Remove the `import type { PendingInteraction }` since it's now re-exported via agent-types
4. Keep the inline `toolState` object creation in `sendMessage()` unchanged — it satisfies the `ToolState` interface already

**Verification**: `npm run typecheck` passes with no errors.

---

## Phase 2 — Utility Extraction (no behavior change)

### Task 2.1: Create `lib/sdk-utils.ts`

**File**: `apps/server/src/lib/sdk-utils.ts` (~40 lines)
**Dependencies**: Task 1.1

Extract `makeUserPrompt()` and `resolveClaudeCliPath()` from `agent-manager.ts` into a new utility module.

**Create `apps/server/src/lib/sdk-utils.ts`:**

```typescript
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';

/**
 * Wrap a plain-text user message in the AsyncIterable form required by the SDK
 * when mcpServers is provided. Safe to use unconditionally — the SDK accepts
 * AsyncIterable for all query types.
 */
export async function* makeUserPrompt(content: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Resolve the Claude Code CLI path for the SDK to spawn.
 *
 * Tries SDK bundled path first, then PATH lookup, then falls back to
 * undefined for SDK default resolution (may fail in Electron).
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Try the SDK's bundled cli.js (works when running from source / node_modules)
  try {
    const sdkCli = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (existsSync(sdkCli)) return sdkCli;
  } catch {
    /* not resolvable in bundled context */
  }

  // 2. Find the globally installed `claude` binary via PATH
  try {
    const bin = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
    if (bin && existsSync(bin)) return bin;
  } catch {
    /* not found on PATH */
  }

  // 3. Let SDK use its default resolution (may fail in Electron)
  return undefined;
}
```

**Update `apps/server/src/services/agent-manager.ts`:**

1. Remove the `makeUserPrompt()` function definition (lines 35-42)
2. Remove the `resolveClaudeCliPath()` function definition (lines 50-69)
3. Remove now-unused imports: `execFileSync` from `child_process`, `existsSync` from `fs`
4. Add import: `import { makeUserPrompt, resolveClaudeCliPath } from '../lib/sdk-utils.js';`
5. Keep the `export { buildTaskEvent }` re-export unchanged

**Verification**: `npm run typecheck` and `npm test -- --run` both pass.

---

## Phase 3 — Event Mapper Extraction (no behavior change)

### Task 3.1: Create `services/sdk-event-mapper.ts`

**File**: `apps/server/src/services/sdk-event-mapper.ts` (~140 lines)
**Dependencies**: Task 1.1

Extract the `mapSdkMessage()` private method from `AgentManager` into a standalone pure async generator function.

**Create `apps/server/src/services/sdk-event-mapper.ts`:**

```typescript
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from './agent-types.js';
import { buildTaskEvent, TASK_TOOL_NAMES } from './build-task-event.js';
import { logger } from '../lib/logger.js';

/**
 * Map a single SDK message to zero or more DorkOS StreamEvent objects.
 *
 * Pure async generator — no I/O, no SDK iterator interaction, no session Map access.
 * ToolState is passed by reference (mutable struct owned by the caller's streaming loop).
 */
export async function* mapSdkMessage(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState
): AsyncGenerator<StreamEvent> {
  // Handle system/init messages
  if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
    session.sdkSessionId = message.session_id;
    session.hasStarted = true;
    const initModel = (message as Record<string, unknown>).model as string | undefined;
    if (initModel) {
      yield {
        type: 'session_status',
        data: { sessionId, model: initModel },
      };
    }
    return;
  }

  // Handle stream events (content blocks)
  if (message.type === 'stream_event') {
    const event = (message as { event: Record<string, unknown> }).event;
    const eventType = event.type as string;

    if (eventType === 'content_block_start') {
      const contentBlock = event.content_block as Record<string, unknown> | undefined;
      if (contentBlock?.type === 'tool_use') {
        toolState.resetTaskInput();
        toolState.setToolState(true, contentBlock.name as string, contentBlock.id as string);
        yield {
          type: 'tool_call_start',
          data: {
            toolCallId: contentBlock.id as string,
            toolName: contentBlock.name as string,
            status: 'running',
          },
        };
      }
    } else if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && !toolState.inTool) {
        yield { type: 'text_delta', data: { text: delta.text as string } };
      } else if (delta?.type === 'input_json_delta' && toolState.inTool) {
        if (TASK_TOOL_NAMES.has(toolState.currentToolName)) {
          toolState.appendTaskInput(delta.partial_json as string);
        }
        yield {
          type: 'tool_call_delta',
          data: {
            toolCallId: toolState.currentToolId,
            toolName: toolState.currentToolName,
            input: delta.partial_json as string,
            status: 'running',
          },
        };
      }
    } else if (eventType === 'content_block_stop') {
      if (toolState.inTool) {
        const wasTaskTool = TASK_TOOL_NAMES.has(toolState.currentToolName);
        const taskToolName = toolState.currentToolName;
        yield {
          type: 'tool_call_end',
          data: {
            toolCallId: toolState.currentToolId,
            toolName: toolState.currentToolName,
            status: 'complete',
          },
        };
        toolState.setToolState(false, '', '');
        if (wasTaskTool && toolState.taskToolInput) {
          try {
            const input = JSON.parse(toolState.taskToolInput);
            const taskEvent = buildTaskEvent(taskToolName, input);
            if (taskEvent) {
              yield { type: 'task_update', data: taskEvent };
            }
          } catch {
            /* malformed JSON, skip */
          }
          toolState.resetTaskInput();
        }
      }
    }
    return;
  }

  // Handle tool use summaries
  if (message.type === 'tool_use_summary') {
    const summary = message as { summary: string; preceding_tool_use_ids: string[] };
    for (const toolUseId of summary.preceding_tool_use_ids) {
      yield {
        type: 'tool_result',
        data: {
          toolCallId: toolUseId,
          toolName: '',
          result: summary.summary,
          status: 'complete',
        },
      };
    }
    return;
  }

  // Handle result messages
  if (message.type === 'result') {
    const result = message as Record<string, unknown>;
    const usage = result.usage as Record<string, unknown> | undefined;
    const modelUsageMap = result.modelUsage as
      | Record<string, Record<string, unknown>>
      | undefined;
    const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;
    yield {
      type: 'session_status',
      data: {
        sessionId,
        model: result.model as string | undefined,
        costUsd: result.total_cost_usd as number | undefined,
        contextTokens: usage?.input_tokens as number | undefined,
        contextMaxTokens: firstModelUsage?.contextWindow as number | undefined,
      },
    };
    yield {
      type: 'done',
      data: { sessionId },
    };
  }
}
```

**Update `apps/server/src/services/agent-manager.ts`:**

1. Remove the entire `private async *mapSdkMessage(...)` method (lines 330-461)
2. Add import: `import { mapSdkMessage } from './sdk-event-mapper.js';`
3. Update the call site in `sendMessage()` — change `this.mapSdkMessage(...)` to `mapSdkMessage(...)`

The call site at line 306 changes from:
```typescript
for await (const event of this.mapSdkMessage(result.value, session, sessionId, toolState)) {
```
to:
```typescript
for await (const event of mapSdkMessage(result.value, session, sessionId, toolState)) {
```

**Verification**: `npm run typecheck` and `npm test -- --run` both pass. All existing agent-manager tests continue to pass since the behavior is identical.

---

### Task 3.2: Write `services/__tests__/sdk-event-mapper.test.ts`

**File**: `apps/server/src/services/__tests__/sdk-event-mapper.test.ts`
**Dependencies**: Task 3.1

Write unit tests for the extracted `mapSdkMessage()` async generator. Mock `build-task-event.js` and `logger.js`.

**Create `apps/server/src/services/__tests__/sdk-event-mapper.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../build-task-event.js', () => ({
  buildTaskEvent: vi.fn(),
  TASK_TOOL_NAMES: new Set(['TaskCreate', 'TaskUpdate']),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));

import { mapSdkMessage } from '../sdk-event-mapper.js';
import { buildTaskEvent } from '../build-task-event.js';
import type { AgentSession, ToolState } from '../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';

/** Collect all events from the async generator */
async function collectEvents(
  gen: AsyncGenerator<StreamEvent>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-123',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeToolState(): ToolState {
  let inTool = false;
  let currentToolName = '';
  let currentToolId = '';
  let taskToolInput = '';
  return {
    get inTool() { return inTool; },
    get currentToolName() { return currentToolName; },
    get currentToolId() { return currentToolId; },
    get taskToolInput() { return taskToolInput; },
    appendTaskInput: (chunk: string) => { taskToolInput += chunk; },
    resetTaskInput: () => { taskToolInput = ''; },
    setToolState: (tool: boolean, name: string, id: string) => {
      inTool = tool;
      currentToolName = name;
      currentToolId = id;
    },
  };
}

describe('mapSdkMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('system/init messages', () => {
    it('emits session_status with model on init', async () => {
      const session = makeSession();
      const events = await collectEvents(
        mapSdkMessage(
          { type: 'system', subtype: 'init', session_id: 'new-sdk-id', model: 'claude-3' } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session_status');
      expect((events[0].data as any).model).toBe('claude-3');
    });

    it('sets session.sdkSessionId and hasStarted on init', async () => {
      const session = makeSession({ sdkSessionId: 'old', hasStarted: false });
      await collectEvents(
        mapSdkMessage(
          { type: 'system', subtype: 'init', session_id: 'new-sdk-id', model: 'claude-3' } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(session.sdkSessionId).toBe('new-sdk-id');
      expect(session.hasStarted).toBe(true);
    });
  });

  describe('stream_event messages', () => {
    it('content_block_start (tool_use) emits tool_call_start', async () => {
      const session = makeSession();
      const toolState = makeToolState();
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'tc-1', name: 'Read', input: {} },
            },
          } as any,
          session,
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_start');
      expect((events[0].data as any).toolName).toBe('Read');
      expect((events[0].data as any).toolCallId).toBe('tc-1');
    });

    it('content_block_delta (text_delta, not in tool) emits text_delta', async () => {
      const session = makeSession();
      const toolState = makeToolState();
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello world' },
            },
          } as any,
          session,
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      expect((events[0].data as any).text).toBe('Hello world');
    });

    it('content_block_delta (input_json, in tool) emits tool_call_delta', async () => {
      const session = makeSession();
      const toolState = makeToolState();
      toolState.setToolState(true, 'Read', 'tc-1');
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"file":"test.ts"}' },
            },
          } as any,
          session,
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_delta');
      expect((events[0].data as any).input).toBe('{"file":"test.ts"}');
    });

    it('content_block_stop (in tool) emits tool_call_end', async () => {
      const session = makeSession();
      const toolState = makeToolState();
      toolState.setToolState(true, 'Read', 'tc-1');
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          } as any,
          session,
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_call_end');
      expect((events[0].data as any).toolCallId).toBe('tc-1');
      expect((events[0].data as any).status).toBe('complete');
    });

    it('task tool stop also emits task_update when buildTaskEvent returns event', async () => {
      const session = makeSession();
      const toolState = makeToolState();
      toolState.setToolState(true, 'TaskCreate', 'tc-task');
      toolState.appendTaskInput('{"subject":"Test task"}');

      const mockTaskEvent = { id: 'task-1', subject: 'Test task', status: 'in_progress' };
      (buildTaskEvent as ReturnType<typeof vi.fn>).mockReturnValue(mockTaskEvent);

      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
          } as any,
          session,
          'session-1',
          toolState
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_call_end');
      expect(events[1].type).toBe('task_update');
      expect(events[1].data).toEqual(mockTaskEvent);
    });
  });

  describe('tool_use_summary messages', () => {
    it('emits tool_result for each preceding tool use ID', async () => {
      const session = makeSession();
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'tool_use_summary',
            summary: 'File read successfully',
            preceding_tool_use_ids: ['tc-1', 'tc-2'],
          } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool_result');
      expect((events[0].data as any).toolCallId).toBe('tc-1');
      expect(events[1].type).toBe('tool_result');
      expect((events[1].data as any).toolCallId).toBe('tc-2');
    });
  });

  describe('result messages', () => {
    it('emits session_status + done', async () => {
      const session = makeSession();
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'result',
            model: 'claude-3',
            total_cost_usd: 0.001,
            usage: { input_tokens: 100, output_tokens: 50 },
            modelUsage: {},
          } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('session_status');
      expect((events[0].data as any).costUsd).toBe(0.001);
      expect(events[1].type).toBe('done');
    });

    it('includes token counts from usage', async () => {
      const session = makeSession();
      const events = await collectEvents(
        mapSdkMessage(
          {
            type: 'result',
            model: 'claude-3',
            total_cost_usd: 0.002,
            usage: { input_tokens: 200, output_tokens: 100 },
            modelUsage: { 'claude-3': { contextWindow: 200000 } },
          } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      const statusEvent = events.find((e) => e.type === 'session_status');
      expect((statusEvent!.data as any).contextTokens).toBe(200);
      expect((statusEvent!.data as any).contextMaxTokens).toBe(200000);
    });
  });

  describe('unknown messages', () => {
    it('yields nothing and does not throw', async () => {
      const session = makeSession();
      const events = await collectEvents(
        mapSdkMessage(
          { type: 'unknown_type', data: {} } as any,
          session,
          'session-1',
          makeToolState()
        )
      );
      expect(events).toHaveLength(0);
    });
  });
});
```

**Verification**: `npx vitest run apps/server/src/services/__tests__/sdk-event-mapper.test.ts` passes all tests.

---

## Phase 4 — Context Builder (new feature)

### Task 4.1: Create `services/context-builder.ts`

**File**: `apps/server/src/services/context-builder.ts` (~100 lines)
**Dependencies**: Task 3.1 (agent-manager must be refactored first so context builder integration is clean)

Create the context builder service that produces structured runtime context for injection into the SDK system prompt.

**Create `apps/server/src/services/context-builder.ts`:**

```typescript
import os from 'node:os';
import { getGitStatus } from './git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';
import { logger } from '../lib/logger.js';

/**
 * Build a system prompt append string containing runtime context.
 *
 * Returns XML key-value blocks mirroring Claude Code's own `<env>` structure.
 * Never throws — all errors result in partial context (git failures produce
 * `Is git repo: false`).
 */
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
  ]);

  return [
    envResult.status === 'fulfilled' ? envResult.value : '',
    gitResult.status === 'fulfilled' ? gitResult.value : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Build the `<env>` block with system and DorkOS metadata.
 */
async function buildEnvBlock(cwd: string): Promise<string> {
  const lines = [
    `Working directory: ${cwd}`,
    `Product: DorkOS`,
    `Version: ${process.env.DORKOS_VERSION ?? 'development'}`,
    `Port: ${process.env.DORKOS_PORT ?? '4242'}`,
    `Platform: ${os.platform()}`,
    `OS Version: ${os.release()}`,
    `Node.js: ${process.version}`,
    `Hostname: ${os.hostname()}`,
    `Date: ${new Date().toISOString()}`,
  ];

  return `<env>\n${lines.join('\n')}\n</env>`;
}

/**
 * Build the `<git_status>` block from git status data.
 *
 * For non-git directories or git failures, returns a minimal block
 * with `Is git repo: false`.
 */
async function buildGitBlock(cwd: string): Promise<string> {
  try {
    const status = await getGitStatus(cwd);

    // Non-git directory (error response)
    if ('error' in status) {
      return '<git_status>\nIs git repo: false\n</git_status>';
    }

    const gitStatus = status as GitStatusResponse;
    const lines: string[] = [
      'Is git repo: true',
      `Current branch: ${gitStatus.branch}`,
      'Main branch (use for PRs): main',
    ];

    if (gitStatus.ahead > 0) {
      lines.push(`Ahead of origin: ${gitStatus.ahead} commits`);
    }
    if (gitStatus.behind > 0) {
      lines.push(`Behind origin: ${gitStatus.behind} commits`);
    }
    if (gitStatus.detached) {
      lines.push('Detached HEAD: true');
    }

    if (gitStatus.clean) {
      lines.push('Working tree: clean');
    } else {
      const parts: string[] = [];
      if (gitStatus.modified > 0) parts.push(`${gitStatus.modified} modified`);
      if (gitStatus.staged > 0) parts.push(`${gitStatus.staged} staged`);
      if (gitStatus.untracked > 0) parts.push(`${gitStatus.untracked} untracked`);
      if (gitStatus.conflicted > 0) parts.push(`${gitStatus.conflicted} conflicted`);
      lines.push(`Working tree: dirty (${parts.join(', ')})`);
    }

    return `<git_status>\n${lines.join('\n')}\n</git_status>`;
  } catch (err) {
    logger.warn('[buildGitBlock] git status failed, returning non-git block', { err });
    return '<git_status>\nIs git repo: false\n</git_status>';
  }
}
```

**Verification**: `npm run typecheck` passes.

---

### Task 4.2: Integrate context builder into `agent-manager.ts`

**File**: `apps/server/src/services/agent-manager.ts`
**Dependencies**: Task 4.1

Add `buildSystemPromptAppend()` call and `systemPrompt` option to `sendMessage()`.

**Update `apps/server/src/services/agent-manager.ts`:**

1. Add import: `import { buildSystemPromptAppend } from './context-builder.js';`

2. In `sendMessage()`, after the `effectiveCwd` assignment and boundary validation, add the context building call. Then modify `sdkOptions` to include `systemPrompt`.

Change the sdkOptions construction from:

```typescript
const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  settingSources: ['project', 'user'],
  ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
};
```

To:

```typescript
const systemPromptAppend = await buildSystemPromptAppend(effectiveCwd);

const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  settingSources: ['project', 'user'],
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: systemPromptAppend,
  },
  ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
};
```

**Critical invariant**: The `Promise.race` event loop and everything else in `sendMessage()` remains untouched. Only the sdkOptions construction is modified.

**Verification**: `npm run typecheck` and `npm test -- --run` both pass.

---

### Task 4.3: Write `services/__tests__/context-builder.test.ts`

**File**: `apps/server/src/services/__tests__/context-builder.test.ts`
**Dependencies**: Task 4.1

Write comprehensive unit tests for the context builder.

**Create `apps/server/src/services/__tests__/context-builder.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../git-status.js', () => ({
  getGitStatus: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));

import { buildSystemPromptAppend } from '../context-builder.js';
import { getGitStatus } from '../git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';

const mockedGetGitStatus = vi.mocked(getGitStatus);

function makeGitStatus(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
    detached: false,
    tracking: 'origin/main',
    ...overrides,
  };
}

describe('buildSystemPromptAppend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
  });

  it('returns string containing <env> block', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('</env>');
  });

  it('<env> contains all required fields', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working directory: /test/dir');
    expect(result).toContain('Product: DorkOS');
    expect(result).toMatch(/Version: /);
    expect(result).toMatch(/Port: /);
    expect(result).toMatch(/Platform: /);
    expect(result).toMatch(/OS Version: /);
    expect(result).toMatch(/Node\.js: /);
    expect(result).toMatch(/Hostname: /);
    expect(result).toMatch(/Date: /);
  });

  it('Date field is valid ISO 8601', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    const dateMatch = result.match(/Date: (.+)/);
    expect(dateMatch).not.toBeNull();
    const parsed = new Date(dateMatch![1]);
    expect(parsed.toISOString()).toBe(dateMatch![1]);
  });

  it('Version defaults to "development" when env unset', async () => {
    vi.stubEnv('DORKOS_VERSION', '');
    // Re-import may be needed or just check the output
    const result = await buildSystemPromptAppend('/test/dir');
    // When DORKOS_VERSION is empty string, it's falsy, so ?? picks 'development'
    // Actually empty string is truthy for ??, need to check
    // '' ?? 'development' = '' (nullish coalescing only checks null/undefined)
    // So we should test with unset env var
    vi.unstubAllEnvs();
    delete process.env.DORKOS_VERSION;
    const result2 = await buildSystemPromptAppend('/test/dir');
    expect(result2).toContain('Version: development');
  });

  it('<git_status> shows "Is git repo: false" for non-git dirs', async () => {
    mockedGetGitStatus.mockResolvedValue({ error: 'not_git_repo' as const });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<git_status>');
    expect(result).toContain('Is git repo: false');
    expect(result).toContain('</git_status>');
  });

  it('<git_status> shows branch when git repo', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ branch: 'feat/my-feature' }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Is git repo: true');
    expect(result).toContain('Current branch: feat/my-feature');
  });

  it('omits "Ahead of origin" when ahead=0', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ ahead: 0 }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('Ahead of origin');
  });

  it('shows "Ahead of origin" when ahead>0', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ ahead: 3 }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Ahead of origin: 3 commits');
  });

  it('shows "Working tree: clean" when all counts zero', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ clean: true }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working tree: clean');
  });

  it('shows "Working tree: dirty" with only non-zero counts', async () => {
    mockedGetGitStatus.mockResolvedValue(
      makeGitStatus({
        clean: false,
        modified: 2,
        staged: 0,
        untracked: 3,
        conflicted: 0,
      })
    );
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working tree: dirty (2 modified, 3 untracked)');
    expect(result).not.toContain('staged');
    expect(result).not.toContain('conflicted');
  });

  it('shows "Detached HEAD" only when detached', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ detached: false }));
    let result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('Detached HEAD');

    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ detached: true, branch: 'HEAD' }));
    result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Detached HEAD: true');
  });

  it('git failure still returns env block (no throw)', async () => {
    mockedGetGitStatus.mockRejectedValue(new Error('git not found'));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('</env>');
    // Should not throw
  });
});
```

**Verification**: `npx vitest run apps/server/src/services/__tests__/context-builder.test.ts` passes all tests.

---

### Task 4.4: Update `agent-manager.test.ts` with systemPrompt assertions

**File**: `apps/server/src/services/__tests__/agent-manager.test.ts`
**Dependencies**: Task 4.2

Add test assertions verifying that `sendMessage()` passes `systemPrompt` to the SDK `query()` call.

**Update `apps/server/src/services/__tests__/agent-manager.test.ts`:**

1. Add mock for context-builder at the top of the file (alongside existing mocks):

```typescript
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>'),
}));
```

2. Also add this mock inside the `beforeEach` after `vi.resetModules()`:

```typescript
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>\nWorking directory: /mock\n</env>'),
}));
```

3. Add a new test case inside the `sendMessage()` describe block:

```typescript
it('passes systemPrompt with claude_code preset to SDK query', async () => {
  const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

  (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
    (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-session-sp',
        tools: [],
        mcp_servers: [],
        model: 'test',
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'text',
        skills: [],
        plugins: [],
        cwd: '/test',
        apiKeySource: 'user',
        uuid: 'uuid-1',
      };
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        result: '',
        stop_reason: 'end_turn',
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: {},
        permission_denials: [],
        uuid: 'uuid-2',
        session_id: 'sdk-session-sp',
      };
    })()
  );

  agentManager.ensureSession('sp-test', { permissionMode: 'default' });
  const events = [];
  for await (const event of agentManager.sendMessage('sp-test', 'hello')) {
    events.push(event);
  }

  // Verify query was called with systemPrompt option
  expect(mockedQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: expect.stringContaining('<env>'),
        },
      }),
    })
  );
});
```

4. Add a second test verifying the preset type:

```typescript
it('systemPrompt uses preset type and claude_code preset', async () => {
  const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');

  (mockedQuery as ReturnType<typeof vi.fn>).mockReturnValue(
    (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-preset',
        tools: [],
        mcp_servers: [],
        model: 'test',
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'text',
        skills: [],
        plugins: [],
        cwd: '/test',
        apiKeySource: 'user',
        uuid: 'uuid-1',
      };
      yield {
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        result: '',
        stop_reason: 'end_turn',
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: {},
        permission_denials: [],
        uuid: 'uuid-2',
        session_id: 'sdk-preset',
      };
    })()
  );

  agentManager.ensureSession('preset-test', { permissionMode: 'default' });
  for await (const _event of agentManager.sendMessage('preset-test', 'hello')) {
    // consume events
  }

  const callArgs = (mockedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const systemPrompt = callArgs.options.systemPrompt;
  expect(systemPrompt.type).toBe('preset');
  expect(systemPrompt.preset).toBe('claude_code');
  expect(typeof systemPrompt.append).toBe('string');
});
```

**Verification**: `npx vitest run apps/server/src/services/__tests__/agent-manager.test.ts` passes all tests.

---

## Phase 5 — Validation & Documentation

### Task 5.1: Validate file sizes, test suite, and typecheck

**Dependencies**: Tasks 4.3, 4.4

Run the following validation checks:

1. **File line counts** — All files must be under 300 lines:
   ```bash
   wc -l apps/server/src/services/agent-manager.ts      # Target: ~240
   wc -l apps/server/src/services/sdk-event-mapper.ts    # Target: ~140
   wc -l apps/server/src/services/context-builder.ts     # Target: ~100
   wc -l apps/server/src/lib/sdk-utils.ts                # Target: ~40
   wc -l apps/server/src/services/agent-types.ts         # Target: ~35
   ```

2. **Full test suite**: `npm test -- --run` — all tests pass

3. **Typecheck**: `npm run typecheck` — no errors

4. If any file exceeds 300 lines, identify extractable sections and adjust. If tests fail, fix the failing tests. If typecheck fails, fix type errors.

---

### Task 5.2: Update CLAUDE.md and contributing/architecture.md

**Dependencies**: Task 5.1

Update documentation to reflect the new file structure and context injection.

**Update `CLAUDE.md`:**

1. In the services list under "### Server", update the `agent-manager.ts` description to mention it imports from `sdk-event-mapper.ts`, `context-builder.ts`, `agent-types.ts`, and `lib/sdk-utils.ts`.

2. Add new service entries:
   - **`services/agent-types.ts`** — Shared interfaces (`AgentSession`, `ToolState`) used by `agent-manager.ts` and `sdk-event-mapper.ts`.
   - **`services/sdk-event-mapper.ts`** — Pure async generator `mapSdkMessage()` that maps SDK streaming messages to DorkOS `StreamEvent` types. Extracted from `agent-manager.ts` for isolated testing.
   - **`services/context-builder.ts`** — Builds structured runtime context (`<env>` and `<git_status>` XML blocks) injected into every SDK `query()` call via `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. Uses `getGitStatus()`, `os` module, and `process.env`. Never throws.

3. Add new lib entry:
   - **`lib/sdk-utils.ts`** — SDK utility functions: `makeUserPrompt()` wraps content as `AsyncIterable<SDKUserMessage>`; `resolveClaudeCliPath()` resolves the Claude CLI binary path.

4. Update the service count from "Seventeen services" to "Twenty services" (agent-types, sdk-event-mapper, context-builder added).

**Update `contributing/architecture.md`:**

1. Update the module layout diagram to include the new files.
2. Add a "Context Injection" subsection to the data flow section showing the flow from `sendMessage()` -> `buildSystemPromptAppend()` -> `query()`.

**Verification**: Read the updated files and confirm accuracy.

---

## Dependency Graph

```
Task 1.1 (agent-types.ts)
  ├── Task 2.1 (sdk-utils.ts)
  └── Task 3.1 (sdk-event-mapper.ts)
       ├── Task 3.2 (sdk-event-mapper.test.ts)
       └── Task 4.1 (context-builder.ts)
            ├── Task 4.2 (integrate into agent-manager)
            │    ├── Task 4.3 (context-builder.test.ts)  [parallel with 4.4]
            │    └── Task 4.4 (agent-manager.test.ts)    [parallel with 4.3]
            │         └── Task 5.1 (validation)
            │              └── Task 5.2 (documentation)
            └── Task 4.3 (context-builder.test.ts)
```

## Parallel Execution Opportunities

1. **Task 2.1 and Task 3.1** can run in parallel (both depend only on Task 1.1)
2. **Task 4.3 and Task 4.4** can run in parallel (both depend on Task 4.1 + 4.2)
