/**
 * The launch options DorkOS hands every Claude Code turn.
 *
 * These are the settings no other test can defend, because getting one wrong
 * costs a whole surface without costing a single failing assertion anywhere
 * else: the fixtures that feed every other suite keep supplying the frames a
 * real model would have stopped sending. Each case here pins one such setting
 * against the reason it exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { configManager } from '../../../../core/config-manager.js';
import { CLASSIFIER_CONTEXT_MATCHER } from '../classifier-context.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../../core/agent-identity/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/agent-identity/index.js')>()),
  resolveAgentTokenEnv: vi.fn().mockResolvedValue({}),
}));

/** A minimal cold session — enough for one launch to be planned. */
function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

/** Sender options with the one required field. */
function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {}, ...overrides };
}

/** Drive one turn and hand back the options the SDK was launched with. */
async function captureSdkOptions(
  messageOpts?: MessageOpts,
  session: AgentSession = makeSession()
): Promise<Options> {
  let capturedOptions: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return { [Symbol.asyncIterator]: async function* () {} } as unknown as ReturnType<typeof query>;
  });
  for await (const _event of executeSdkQuery('s1', 'hello', session, makeOpts(), messageOpts)) {
    // Drained: the launch is what is under test, not the stream.
  }
  return capturedOptions!;
}

describe('the launch options every Claude Code turn is given', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a launch as per token when its final environment carries a key, whatever its source (spec claude-account-fleet §6 U)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-from-the-server');
    try {
      const inherited = makeSession();
      await captureSdkOptions(undefined, inherited);
      expect(inherited.launchedPerToken).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    try {
      const signedIn = makeSession();
      await captureSdkOptions(undefined, signedIn);
      expect(signedIn.launchedPerToken).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('turns the task and todo tools on, which no newer model gets by default', async () => {
    const options = await captureSdkOptions();

    const env = options.env as Record<string, string | undefined>;
    expect(
      env.CLAUDE_CODE_ENABLE_TODO_TOOLS,
      'without this the model never calls TodoWrite/TaskCreate/TaskUpdate, so the todo panel ' +
        'and the Tasks surface stay empty forever and nothing anywhere errors'
    ).toBe('1');
  });

  it("registers the hooks that record a helper agent's tool calls, on every tool", async () => {
    const options = await captureSdkOptions();
    const unmatched = (options.hooks?.PostToolUse ?? []).filter((m) => m.matcher === undefined);
    expect(unmatched).toHaveLength(1);
    expect(options.hooks?.PostToolUseFailure).toEqual([{ hooks: [unmatched[0]!.hooks[0]] }]);
  });

  it('registers the PostToolUse hook that tells auto mode about DorkOS tools', async () => {
    // Spec `auto-mode-classifier-context`. Nothing else can catch this: a hook
    // that was never registered produces no error, no log line and no failing
    // assertion anywhere — auto mode just goes on guessing about DorkOS's own
    // tools, exactly as it did before, and the whole change is a no-op nobody
    // notices.
    const options = await captureSdkOptions();

    // The audit record's helper-tool hook rides PostToolUse too (spec
    // `audit-trail` PR3); the classifier hook is the one with a matcher.
    const matchers = (options.hooks?.PostToolUse ?? []).filter((m) => m.matcher !== undefined);
    expect(matchers).toHaveLength(1);
    expect(
      matchers[0]?.matcher,
      'the CLI reads a word-characters-only matcher as a list of exact tool names, so the ' +
        'registration has to hand it a pattern \u2014 see CLASSIFIER_CONTEXT_MATCHER'
    ).toBe(CLASSIFIER_CONTEXT_MATCHER);

    const hook = matchers[0]!.hooks[0]!;
    const result = (await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__dorkos__mesh_list',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'toolu_1',
      } as never,
      'toolu_1',
      { signal: new AbortController().signal }
    )) as Record<string, unknown>;

    const specific = result.hookSpecificOutput as Record<string, unknown>;
    expect(specific?.hookEventName).toBe('PostToolUse');
    expect(specific?.classifierContext).toContain("passed DorkOS's own permission check");
  });

  // DOR-2717. A session timer (CronCreate, ScheduleWakeup, /loop) lives inside
  // the CLI and is no background task, so nothing on the stream says one is
  // pending. The Stop hook's input does, at every turn end; the warm process is
  // held on it so the idle reaper cannot kill the timer before it fires.
  it('records the timers the CLI reports pending at each turn end', async () => {
    const session = makeSession();
    const options = await captureSdkOptions(undefined, session);

    const stop = options.hooks?.Stop ?? [];
    expect(stop).toHaveLength(1);
    const hook = stop[0]!.hooks[0]!;
    const fire = (crons: unknown) =>
      hook(
        { hook_event_name: 'Stop', stop_hook_active: false, session_crons: crons } as never,
        undefined,
        { signal: new AbortController().signal }
      );

    expect(
      await fire([{ id: 'c1', schedule: '5 9 * * *', recurring: false, prompt: 'tick' }])
    ).toEqual({});
    expect(session.pendingTimers).toBe(1);
    await fire([]);
    expect(session.pendingTimers).toBe(0);
    // A CLI too old to report the field says nothing about timers.
    await fire(undefined);
    expect(session.pendingTimers).toBe(0);
  });

  it('sends the plugin list over stdin rather than on the command line', async () => {
    const options = await captureSdkOptions();

    expect(
      options.pluginDelivery,
      'ADR-0239 activates every enabled marketplace plugin through `options.plugins`, and on ' +
        'argv that list is an unbounded count of absolute paths — past Windows\u2019 command-line ' +
        'length limit the CLI simply stops starting'
    ).toBe('initialize');
  });
});

describe('folder grants on the launch (spec `agent-home-desk` §4.2)', () => {
  const CLAUDE_MD_VAR = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never hands a turn the variable that loads a granted folder’s CLAUDE.md, even when the server has it and the owner chose to pass it on', async () => {
    // The strongest way it could arrive: set in the server's environment AND
    // named in the owner's inheritance list, which is the one route the
    // environment projection lets a name through.
    vi.stubEnv(CLAUDE_MD_VAR, '1');
    vi.mocked(configManager.get).mockImplementation(((key: string) =>
      key === 'runtimes'
        ? { environment: { inherit: { claudeCode: [CLAUDE_MD_VAR], codex: [], opencode: [] } } }
        : undefined) as typeof configManager.get);

    const options = await captureSdkOptions({
      additionalDirectories: [{ path: '/rooms/r1/worktrees/ana', access: 'write' }],
    });

    expect(Object.keys(options.env ?? {})).not.toContain(CLAUDE_MD_VAR);
  });

  it('merges the grants into the settings the launch already carries', async () => {
    const options = await captureSdkOptions(
      {
        additionalDirectories: [
          { path: '/rooms/r1/worktrees/ana', access: 'write' },
          { path: '/rooms/r1/repo', access: 'read' },
        ],
      },
      { ...makeSession(), fastMode: true }
    );

    expect(options.settings).toEqual({
      fastMode: true,
      permissions: {
        additionalDirectories: ['/rooms/r1/worktrees/ana', '/rooms/r1/repo'],
        deny: [
          'Edit(//rooms/r1/repo/**)',
          'Write(//rooms/r1/repo/**)',
          'NotebookEdit(//rooms/r1/repo/**)',
        ],
      },
    });
    // The SDK option is `--add-dir`, which loads the folder's skills (I11).
    expect(options.additionalDirectories).toBeUndefined();
  });

  it('refuses an invalid set before anything launches', async () => {
    vi.mocked(query).mockClear();
    await expect(
      captureSdkOptions({ additionalDirectories: [{ path: 'relative/dir', access: 'read' }] })
    ).rejects.toThrow(/not an absolute path/);
    expect(query).not.toHaveBeenCalled();
  });
});
