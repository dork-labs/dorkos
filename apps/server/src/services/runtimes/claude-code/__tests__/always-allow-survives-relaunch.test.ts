/**
 * The seam DOR-1316 was actually reported at: the COLD RELAUNCH.
 *
 * The store-level tests beside this one stop at DorkOS's own session row. What
 * the operator saw was one step further out — a process relaunched AFTER the
 * "Always Allow" click still spelled `--permission-mode default` on its command
 * line, so the agent asked all over again while the status line read "Accept
 * edits". This drives the whole way: a real approval raised through the SDK's
 * own `canUseTool` seam, answered with "Always Allow", then a brand-new runtime
 * (a server restart, as far as the session is concerned) sending the next
 * message — and asserts the mode the SDK is launched with.
 *
 * Because that is what it asserts, the DOR-885 case lives here too: the settings
 * store is one plain text column shared by every runtime, so the mode a Claude
 * Code session hydrates can be an id only some OTHER runtime declares — and the
 * SDK must never be launched with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));
const { contextBuilderFactory, toolFilterFactory } = vi.hoisted(() => ({
  contextBuilderFactory: () => ({
    buildSystemPromptAppend: vi.fn().mockResolvedValue({
      text: '<env>\nWorking directory: /mock\n</env>',
      stable: '<env>\nWorking directory: /mock\n</env>',
    }),
    renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
  }),
  toolFilterFactory: () => ({
    resolveToolConfig: vi
      .fn()
      .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
  }),
}));
vi.mock('../messaging/context-builder.js', contextBuilderFactory);
vi.mock('../tooling/tool-filter.js', toolFilterFactory);
vi.mock('@dorkos/shared/manifest', async () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue({
      tasksTools: true,
      relayTools: true,
      meshTools: true,
      adapterTools: true,
    }),
  },
}));
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: vi.fn().mockResolvedValue([]),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('not found');
    }),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSettings, StreamEvent } from '@dorkos/shared/types';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { UNKNOWN_MODE_STATUS } from '../messaging/permission-mode-guard.js';
import { logger } from '../../../../lib/logger.js';

const mockedQuery = vi.mocked(query);

const SESSION_ID = 'sess-relaunch';
const TOOL_CALL_ID = 'tool-write-relaunch';

/** The suggestion a Write card carries: "don't ask me again in this chat". */
const SESSION_ACCEPT_EDITS: PermissionUpdate = {
  type: 'setMode',
  mode: 'acceptEdits',
  destination: 'session',
};

/** Add stub SDK query methods to a mock async iterable so it matches the real shape. */
function withQueryMethods<T extends object>(obj: T): T {
  return Object.assign(obj, {
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
  });
}

/** An in-memory stand-in for the durable settings store (ADR-0260). */
function memorySettingsPort(): SessionSettingsPort {
  const rows = new Map<string, SessionSettings>();
  return {
    getSessionSettings: async (id) => rows.get(id) ?? null,
    saveSessionSettings: async (id, settings) => {
      rows.set(id, { ...rows.get(id), ...settings });
    },
    rekeySessionSettings: async (from, to) => {
      const row = rows.get(from);
      if (row) {
        rows.delete(from);
        rows.set(to, row);
      }
    },
  };
}

/**
 * Start a turn and hand back the `canUseTool` the SDK was launched with,
 * plus the options that launch spelled.
 *
 * @param runtime - The runtime to send through.
 */
async function startTurn(runtime: ClaudeCodeRuntime) {
  let canUseToolFn:
    | ((
        toolName: string,
        input: Record<string, unknown>,
        context: {
          signal: AbortSignal;
          toolUseID: string;
          suggestions?: PermissionUpdate[];
        }
      ) => Promise<unknown>)
    | undefined;
  let launchedWith: { permissionMode?: string } | undefined;
  mockedQuery.mockImplementation(((args: {
    options: { canUseTool?: typeof canUseToolFn; permissionMode?: string };
  }) => {
    canUseToolFn = args.options.canUseTool;
    launchedWith = args.options;
    const iterator = {
      next: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { type: 'system', subtype: 'init', session_id: SESSION_ID },
        })
        .mockImplementationOnce(() => new Promise(() => {})),
    };
    return withQueryMethods({
      [Symbol.asyncIterator]: () => iterator,
    }) as unknown as ReturnType<typeof query>;
  }) as unknown as typeof query);

  const gen = runtime.sendMessage(SESSION_ID, 'change a file');
  // Anything the launch says BEFORE the SDK starts. The resolver hands its
  // notes back as data and `message-sender.ts` yields them ahead of `query()`,
  // so a launch that emits one suspends this generator short of the launch
  // itself — draining them here is what lets a turn that reports something
  // still reach `query()`, and it is also how a test reads what was reported.
  const preLaunchEvents: { type: string; data?: { message?: string } }[] = [];
  let settled: IteratorResult<StreamEvent> | undefined;
  const take = () => gen.next().then((r) => ((settled = r), r));
  let pull = take();
  // The cold path reaches the store and the transcript probe before it
  // launches, so one flush is not enough to get to `query()`.
  await vi.waitFor(async () => {
    await vi.advanceTimersByTimeAsync(0);
    if (settled && !settled.done) {
      preLaunchEvents.push(settled.value as { type: string; data?: { message?: string } });
      settled = undefined;
      pull = take();
    }
    if (!launchedWith) throw new Error('query() not reached yet');
  });
  return { canUseTool: canUseToolFn!, launchedWith: launchedWith!, preLaunchEvents, pull };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // CLEARED, never reset: the module mocks at the top of this file are
  // established once at import, and resetting them would strip the stubs every
  // launch below depends on out from under the next test in the file.
  vi.clearAllMocks();
});

describe('"Always Allow" survives the relaunch (DOR-1316)', () => {
  it('launches the next process in the mode the click granted, not back at default', async () => {
    // One store outlives both runtimes — the durable row is the only thing a
    // restart carries across, which is exactly what this is about.
    const settings = memorySettingsPort();

    const first = new ClaudeCodeRuntime('/tmp/dorkos-test', '/tmp/test-cwd');
    first.setSessionSettings(settings);
    first.ensureSession(SESSION_ID, { permissionMode: 'default' });

    const turn = await startTurn(first);
    // The launch this click happens during is the one the operator saw asking.
    expect(turn.launchedWith.permissionMode).toBe('default');

    const approval = turn.canUseTool(
      'Write',
      { file_path: '/mock/path/second.txt', content: 'WORLD' },
      {
        signal: new AbortController().signal,
        toolUseID: TOOL_CALL_ID,
        suggestions: [SESSION_ACCEPT_EDITS],
      }
    );
    await turn.pull;

    expect(first.approveTool(SESSION_ID, TOOL_CALL_ID, true, { alwaysAllow: true })).toBe(true);
    // The SDK gets the suggestions verbatim — the grant is untouched.
    expect(await approval).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [SESSION_ACCEPT_EDITS],
    });

    // The server restarts: nothing in memory survives, only the row.
    const second = new ClaudeCodeRuntime('/tmp/dorkos-test', '/tmp/test-cwd');
    second.setSessionSettings(settings);
    const relaunch = await startTurn(second);

    expect(relaunch.launchedWith.permissionMode).toBe('acceptEdits');
  });
});

describe('a mode the SDK never heard of never reaches it (DOR-885)', () => {
  it("launches in default when the durable row holds another runtime's mode id", async () => {
    const warn = vi.spyOn(logger, 'warn');
    // `always-allow` is `test-mode`'s real declared default, and
    // `session_metadata.permission_mode` is one text column for every runtime —
    // so this row is a shape the store genuinely produces, not an invented one.
    // Launching with it would 400 the whole turn; `default` asks about
    // everything, which is the only safe reading of a mode nothing can weigh.
    const settings = memorySettingsPort();
    await settings.saveSessionSettings(SESSION_ID, { permissionMode: 'always-allow' });

    const runtime = new ClaudeCodeRuntime('/tmp/dorkos-test', '/tmp/test-cwd');
    runtime.setSessionSettings(settings);

    const turn = await startTurn(runtime);
    expect(turn.launchedWith.permissionMode).toBe('default');

    // And it SAYS so. The coercion is per launch and never rewrites the
    // operator's row, exactly like the auto-mode downgrade beside it — so the
    // panel goes on showing `always-allow` while the agent asks about
    // everything, and without this note nothing would explain the gap.
    expect(turn.preLaunchEvents).toEqual([
      { type: 'system_status', data: { message: UNKNOWN_MODE_STATUS } },
    ]);
    // The id belongs in the log, not on screen: it means nothing to the person
    // reading the note, and an operator reading logs has no other way to it.
    expect(warn).toHaveBeenCalledWith(
      '[sendMessage] saved permission mode is not one this runtime offers',
      expect.objectContaining({ stored: 'always-allow', running: 'default' })
    );
  });

  it('says nothing when the saved mode is one this runtime does offer', async () => {
    // The note reports something that happened; it is not decoration on every
    // launch. Pinned at the same seam rather than on the pure function, because
    // a `!==` that slipped to a truthiness check would still pass a unit test of
    // `narrowToClaudeCodeMode` while toasting every session in the app.
    const settings = memorySettingsPort();
    await settings.saveSessionSettings(SESSION_ID, { permissionMode: 'acceptEdits' });

    const runtime = new ClaudeCodeRuntime('/tmp/dorkos-test', '/tmp/test-cwd');
    runtime.setSessionSettings(settings);

    const turn = await startTurn(runtime);
    expect(turn.launchedWith.permissionMode).toBe('acceptEdits');
    expect(turn.preLaunchEvents).toEqual([]);
  });
});
