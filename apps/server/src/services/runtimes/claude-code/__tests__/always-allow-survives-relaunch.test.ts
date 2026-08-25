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
import type { SessionSettings } from '@dorkos/shared/types';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';

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

describe('"Always Allow" survives the relaunch (DOR-1316)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

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
    const pull = gen.next();
    // The cold path reaches the store and the transcript probe before it
    // launches, so one flush is not enough to get to `query()`.
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(0);
      if (!launchedWith) throw new Error('query() not reached yet');
    });
    return { canUseTool: canUseToolFn!, launchedWith: launchedWith!, pull };
  }

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
