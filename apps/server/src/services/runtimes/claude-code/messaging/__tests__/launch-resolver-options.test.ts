vi.mock('../../accounts/account-login-metadata.js', () => ({
  requireConfirmedAccountLogin: () => undefined,
}));
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/index.js';
import { projectSlug } from '../../sessions/project-slug.js';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { MessageOpts, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { RELAY_TURN_CEILING } from '../../../../core/session-relay/relay-send.js';
import { configManager } from '../../../../core/config-manager.js';
import { resolveDorkHome } from '../../../../../lib/dork-home.js';
import { CLASSIFIER_CONTEXT_MATCHER } from '../classifier-context.js';
import { buildSystemPromptAppend, renderContextEntry } from '../context-builder.js';
import { resolveLaunch } from '../launch-resolver.js';
import { PERSON_ONLY_DATA_FOLDERS, personOnlyFileRules } from '../directory-grants.js';
import { assignTurnBounds } from '../../turn-bounds.js';
import {
  captureLaunchFingerprint,
  compareLaunchFingerprints,
} from '../../sessions/launch-fingerprint.js';

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

  it('registers the teammate fence on every tool, read from the session as each call is made', async () => {
    // DOR-2955. A fence that is never registered fails nothing anywhere: a
    // teammate's turn would simply reach every room the agent is in again.
    const session = makeSession();
    const options = await captureSdkOptions(undefined, session);
    const unmatched = (options.hooks?.PreToolUse ?? []).filter((m) => m.matcher === undefined);
    // The teammate fence, then the held turn's ask (DOR-3204).
    expect(unmatched).toHaveLength(2);
    const hook = unmatched[0]!.hooks[0]!;
    const call = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'sdk-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/mock/project',
      tool_name: 'mcp__dorkos__read_room_history',
      tool_input: { roomId: 'room-of-the-owner' },
      tool_use_id: 'tool-1',
    };
    const signal = { signal: new AbortController().signal };

    expect(await hook(call, 'tool-1', signal)).toEqual({});
    session.teammateTier = { roomId: 'room-answered' };
    expect(await hook(call, 'tool-1', signal)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('registers the held turn’s ask on every tool, read from the session as each call is made', async () => {
    // DOR-3204. Unregistered, a held turn runs whatever the folder's allow rules allow, unasked.
    const session = makeSession();
    const options = await captureSdkOptions(undefined, session);
    const unmatched = (options.hooks?.PreToolUse ?? []).filter((m) => m.matcher === undefined);
    const hook = unmatched[1]!.hooks[0]!;
    const call = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'sdk-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/mock/project',
      tool_name: 'Bash',
      tool_input: { command: 'python3 -c 1' },
      tool_use_id: 'tool-1',
    };
    const signal = { signal: new AbortController().signal };

    expect(await hook(call, 'tool-1', signal)).toEqual({});
    session.turnPermissionCeiling = 'runtime-default';
    expect(await hook(call, 'tool-1', signal)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
  });

  it('shows a teammate’s turn no notes, says what it may do, and never shares its process with the owner’s', async () => {
    // DOR-2955. The notes are left out of the prompt, which the digest does not
    // see, so the teammate block must be IN the digest: without it a warm
    // process launched with the owner's notes would serve the teammate's turn.
    vi.mocked(buildSystemPromptAppend).mockImplementation(async (_home, _cwd, _gates, options) => ({
      text:
        options?.memory === false
          ? '<env>mock</env>'
          : '<env>mock</env>\n\n<agent_memory>x</agent_memory>',
      stable: '<env>mock</env>',
    }));
    const session = makeSession();
    const resolve = (messageOpts?: MessageOpts) =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hello',
        session,
        opts: makeOpts(),
        ...(messageOpts ? { messageOpts } : {}),
        effectiveCwd: '/mock/project',
      });
    const append = (launch: Awaited<ReturnType<typeof resolve>>) =>
      (launch.sdkOptions.systemPrompt as { append: string }).append;
    const pin = (launch: Awaited<ReturnType<typeof resolve>>) =>
      captureLaunchFingerprint(launch.launch);

    const owner = await resolve();
    const teammate = await resolve({
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
    });
    const ownerAgain = await resolve({
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't2' },
    });

    expect(append(teammate)).not.toContain('<agent_memory>');
    expect(append(teammate)).not.toContain('<relay_connections>');
    expect(append(teammate)).toContain('<teammate_turn>');
    expect(append(ownerAgain)).toContain('<agent_memory>');
    expect(append(ownerAgain)).not.toContain('<teammate_turn>');
    expect(compareLaunchFingerprints(pin(owner), pin(teammate)).action).toBe('relaunch');
    expect(compareLaunchFingerprints(pin(teammate), pin(ownerAgain)).action).toBe('relaunch');
    // And an ordinary turn after an ordinary turn relaunches for none of this.
    expect(compareLaunchFingerprints(pin(owner), pin(ownerAgain)).action).not.toBe('relaunch');
    // Back to the file's own stub, which `clearAllMocks` would not restore.
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>mock</env>',
      stable: '<env>mock</env>',
    });
  });

  it('launches a teammate’s turn without the owner’s profile, folder or grants (DOR-2956)', async () => {
    // Red when: the launcher stops asking the append for the teammate form, or applies a
    // caller's folder grants to a teammate's turn. Owner turns are unchanged.
    const asked: Array<Record<string, unknown> | undefined> = [];
    vi.mocked(buildSystemPromptAppend).mockImplementation(async (_home, _cwd, _gates, options) => {
      asked.push(options as Record<string, unknown> | undefined);
      return { text: '<env>mock</env>', stable: '<env>mock</env>' };
    });
    const grants = [{ path: '/elsewhere/private-repo', access: 'read' as const }];
    const resolve = (messageOpts: MessageOpts) =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hello',
        session: makeSession(),
        opts: makeOpts(),
        messageOpts,
        effectiveCwd: '/mock/project',
      });
    const reach = (launch: Awaited<ReturnType<typeof resolve>>) =>
      (launch.sdkOptions.settings as { permissions?: { additionalDirectories?: string[] } })
        ?.permissions?.additionalDirectories ?? [];

    const teammate = await resolve({
      additionalDirectories: grants,
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
    });
    const owner = await resolve({
      additionalDirectories: grants,
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't2' },
    });

    expect(asked[0]).toMatchObject({ memory: false, teammate: true });
    expect(asked[1]?.teammate).toBeUndefined();
    expect(reach(teammate)).toEqual([]);
    expect(reach(owner)).toContain('/elsewhere/private-repo');
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>mock</env>',
      stable: '<env>mock</env>',
    });
  });

  it('holds a chat a teammate’s mark reached to the same tier, fenced to no room (DOR-3036)', async () => {
    // Red when: the launcher reads only `roomTurn.teammate`, so a chat one hop on from a
    // teammate's turn gets the owner's notes, profile and grants back.
    const asked: Array<Record<string, unknown> | undefined> = [];
    vi.mocked(buildSystemPromptAppend).mockImplementation(async (_home, _cwd, _gates, options) => {
      asked.push(options as Record<string, unknown> | undefined);
      return { text: '<env>mock</env>', stable: '<env>mock</env>' };
    });
    const session = makeSession();
    const launch = await resolveLaunch({
      sessionId: 's1',
      content: 'hello',
      session,
      opts: makeOpts(),
      messageOpts: {
        teammate: true,
        additionalDirectories: [{ path: '/elsewhere/private-repo', access: 'read' }],
      },
      effectiveCwd: '/mock/project',
    });
    assignTurnBounds(session, { teammate: true });

    expect(asked[0]).toMatchObject({ memory: false, teammate: true });
    expect(
      (launch.sdkOptions.settings as { permissions?: { additionalDirectories?: string[] } })
        ?.permissions?.additionalDirectories ?? []
    ).toEqual([]);
    expect(session.teammateTier).toEqual({ roomId: null });
    assignTurnBounds(session, undefined);
    expect(session.teammateTier).toBeUndefined();
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>mock</env>',
      stable: '<env>mock</env>',
    });
  });

  // DOR-2955, review B1/B2: Claude Code reads `@path` and runs a leading `/name`
  // before any tool gate sees them. Measured on the pinned binary; these pin the
  // launcher half.
  describe('words somebody other than the person here wrote', () => {
    const ZW = '\u200B';
    const resolveWith = (content: string, messageOpts?: MessageOpts) =>
      resolveLaunch({
        sessionId: 's1',
        content,
        session: makeSession(),
        opts: makeOpts({ getKnownCommands: async () => ['/leak', '/compact'] }),
        ...(messageOpts ? { messageOpts } : {}),
        effectiveCwd: '/mock/project',
      });
    const stranger: MessageOpts = {
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', untrustedText: true },
    };

    it('never run as a command, and never read as a file', async () => {
      const slash = await resolveWith('/leak', stranger);
      expect(slash.enrichedContent).toBe(`${ZW}/leak`);
      const at = await resolveWith('see @/etc/hosts', stranger);
      expect(at.enrichedContent).toBe(`see ${ZW}@/etc/hosts`);
    });

    it('is the same for a teammate’s turn', async () => {
      const launched = await resolveWith('/compact', {
        roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
      });
      expect(launched.enrichedContent).toBe(`${ZW}/compact`);
    });

    it('leaves the person here exactly as today: commands run bare, files are read', async () => {
      expect((await resolveWith('/leak')).enrichedContent).toBe('/leak');
      expect((await resolveWith('  /leak  ')).enrichedContent).toBe('/leak');
      expect((await resolveWith('see @notes.md')).enrichedContent).toBe('see @notes.md');
    });

    it('defuses every context block, whoever wrote the message', async () => {
      vi.mocked(renderContextEntry).mockReturnValueOnce(
        '<room_context>bo: @/etc/hosts</room_context>'
      );
      const launched = await resolveWith('see @notes.md', {
        additionalContext: [{ kind: 'room_context' } as never],
      });
      expect(launched.enrichedContent).toBe(
        `<room_context>bo: ${ZW}@/etc/hosts</room_context>\n\nsee @notes.md`
      );
    });
  });

  describe('Claude Code’s own auto-memory on an agent’s turn (ADR 261017-153539)', () => {
    let root: string;
    let home: string;
    let account: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'dorkos-automem-'));
      home = path.join(root, 'agent');
      account = path.join(root, '.claude');
      mkdirSync(home, { recursive: true });
      setAgentHomeRegistry({
        isRegisteredHome: (dir) => dir === home,
        listRegisteredHomes: () => [home],
        managedWorkspaceOwner: () => null,
        roomsDir: null,
      });
    });

    afterEach(() => {
      setAgentHomeRegistry(undefined);
      rmSync(root, { recursive: true, force: true });
    });

    const launch = (cwd: string) =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hello',
        session: { ...makeSession(), accountRoot: account },
        opts: makeOpts({ cwd }),
        effectiveCwd: cwd,
      });
    const memoryDir = () => path.join(account, 'projects', projectSlug(home), 'memory');

    it('is off for a turn that runs as an agent, so its DorkOS memory is its only one', async () => {
      const resolved = await launch(home);
      expect(resolved.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });

    it('stays on while the agent still has Claude Code notes nobody has moved', async () => {
      mkdirSync(memoryDir(), { recursive: true });
      writeFileSync(path.join(memoryDir(), 'MEMORY.md'), '- [a](a.md)\n');
      const resolved = await launch(home);
      expect(resolved.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    });

    it('goes off once the migration has left its marker in that folder', async () => {
      mkdirSync(memoryDir(), { recursive: true });
      writeFileSync(path.join(memoryDir(), 'MEMORY.md'), '- [a](a.md)\n');
      writeFileSync(path.join(memoryDir(), 'MOVED-TO-DORKOS.md'), 'moved\n');
      const resolved = await launch(home);
      expect(resolved.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    });

    it('stays on for a plain folder, which has no DorkOS memory to use instead', async () => {
      const resolved = await launch(path.join(root, 'plain'));
      expect(resolved.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    });
  });

  it('launches a teammate’s turn with no setting layers and no auto-memory, in its own process', async () => {
    // DOR-2955, review B3: every setting layer adds the owner's CLAUDE.md files, and
    // Claude Code adds its own auto-memory for the folder whatever the layers say.
    const session = makeSession();
    const resolve = (messageOpts?: MessageOpts) =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hello',
        session,
        opts: makeOpts(),
        ...(messageOpts ? { messageOpts } : {}),
        effectiveCwd: '/mock/project',
      });
    const owner = await resolve();
    const teammate = await resolve({
      roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
    });

    expect(teammate.sdkOptions.settingSources).toEqual([]);
    expect(teammate.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(owner.sdkOptions.settingSources).toEqual(['local', 'project', 'user']);
    expect(owner.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    // What bounds the turn is an option of the launch, never a setting layer.
    expect(teammate.sdkOptions.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    expect(teammate.sdkOptions.canUseTool).toBeTypeOf('function');
    const moved = compareLaunchFingerprints(
      captureLaunchFingerprint(owner.launch),
      captureLaunchFingerprint(teammate.launch)
    );
    expect(moved.action).toBe('relaunch');
    if (moved.action === 'relaunch') {
      expect(moved.changed).toEqual(expect.arrayContaining(['settingSources', 'env']));
    }
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

// DOR-3107 (Security): an agent at Full autonomy never calls the tool gate, so
// a marked turn must LAUNCH at the capped mode. Each cap is taken from where
// that mark is set, so a source that loosens its cap fails here.
describe('a marked turn on an agent at Full autonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** One turn as the runtime starts it: its bounds first, then the launch. */
  async function launchAs(opts: MessageOpts | undefined, session: AgentSession): Promise<Options> {
    assignTurnBounds(session, opts);
    return captureSdkOptions(opts, session);
  }

  /** A session whose own saved mode is Full autonomy. */
  function bypassSession(): AgentSession {
    return { ...makeSession(), permissionMode: 'bypassPermissions' };
  }

  it.each([
    ['a Telegram or Slack message (the relay adapter)', 'runtime-default' as const],
    ['a turn relayed from the web', RELAY_TURN_CEILING],
    ['a room post from an outsider', 'runtime-default' as const],
    ['a space teammate’s post', ['runtime-default', READ_ONLY_LEVEL] as const],
  ])('launches at the runtime’s Default for %s', async (_name, ceiling) => {
    const options = await launchAs(
      { permissionCeiling: ceiling as TurnPermissionCeiling },
      bypassSession()
    );
    expect(options.permissionMode).not.toBe('bypassPermissions');
    expect(['default', 'plan']).toContain(options.permissionMode);
  });

  it('launches at Full autonomy for the owner’s own turn', async () => {
    const options = await launchAs(undefined, bypassSession());
    expect(options.permissionMode).toBe('bypassPermissions');
  });

  it('launches at Full autonomy for another of the owner’s agents at Full autonomy', async () => {
    const options = await launchAs(
      { permissionCeiling: { asks: 'never', reach: 'everything' } },
      bypassSession()
    );
    expect(options.permissionMode).toBe('bypassPermissions');
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

    const expectedDeny = [
      'Edit(//rooms/r1/repo/**)',
      'Write(//rooms/r1/repo/**)',
      'NotebookEdit(//rooms/r1/repo/**)',
      // Then the folders only a person may change, on every turn.
      ...PERSON_ONLY_DATA_FOLDERS.flatMap((folder) =>
        ['Edit', 'Write', 'NotebookEdit'].map(
          (tool) => `${tool}(/${resolveDorkHome()}/${folder}/**)`
        )
      ),
      // And the config files, which hold every approval (DOR-3068).
      ...personOnlyFileRules(resolveDorkHome()),
      // And every project's installed plugins (DOR-3068).
      ...['Edit', 'Write', 'NotebookEdit'].map((tool) => `${tool}(//**/.dork/plugins/**)`),
    ];
    const settings = options.settings as {
      fastMode: boolean;
      permissions: { additionalDirectories: string[]; deny: string[] };
    };
    expect(settings.fastMode).toBe(true);
    expect(settings.permissions.additionalDirectories).toEqual([
      '/rooms/r1/worktrees/ana',
      '/rooms/r1/repo',
    ]);
    expect(settings.permissions.deny.slice(0, expectedDeny.length)).toEqual(expectedDeny);
    // And last, the secret files the model's read tools never open (DOR-3299).
    const rest = settings.permissions.deny.slice(expectedDeny.length);
    expect(rest).toContain(`Read(/${resolveDorkHome()}/host.key)`);
    expect(rest.every((rule) => /^(Read|Grep|Glob)\(/.test(rule))).toBe(true);
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
