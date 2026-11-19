import { CREDITS_BLANKED_SETTINGS_NAMES } from '../credits-launch.js';
/**
 * The launch options DorkOS hands every Claude Code turn.
 *
 * These are the settings no other test can defend, because getting one wrong
 * costs a whole surface without costing a single failing assertion anywhere
 * else: the fixtures that feed every other suite keep supplying the frames a
 * real model would have stopped sending. Each case here pins one such setting
 * against the reason it exists.
 */
import { resolveClaudeCredentialEnv } from '../../../../core/credential-env.js';
import { resolveLaunchAccountRoot } from '../../claude-config-dir.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { runtimeRegistry } from '../../../../core/runtime-registry.js';
import { eq, roomSeatLaunchRequirements, sessionMetadata } from '@dorkos/db';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setAgentHomeRegistry } from '../../../../core/agent-identity/index.js';
import { projectSlug } from '../../sessions/project-slug.js';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import { SessionStore } from '../../sessions/session-store.js';
import { TranscriptReader } from '../../sessions/transcript-reader.js';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import { RequiredSessionIdentityError } from '../../../../../lib/replay/required-session-identity-error.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession, ToolState } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { MessageOpts, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { configManager } from '../../../../core/config-manager.js';
import { resolveDorkHome } from '../../../../../lib/dork-home.js';
import { CLASSIFIER_CONTEXT_MATCHER } from '../classifier-context.js';
import { buildSystemPromptAppend, renderContextEntry } from '../context-builder.js';
import { resolveLaunch } from '../launch-resolver.js';
import {
  agentHomesSelfGrantRules,
  HOME_PERSON_ONLY_FULL_RULES,
  HOME_PERSON_ONLY_RULES,
  PERSON_ONLY_DATA_FOLDERS,
  personOnlyFileRules,
} from '../directory-grants.js';
import { assignTurnBounds } from '../../turn-bounds.js';
import {
  recordTurnLevels,
  marksOf,
  aliasTurnLevel,
} from '../../../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../../../session/session-state-projector.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { roomTurnMarksOf } from '../../../../rooms/limits/teammate-turn.js';
import { noteRoomTurnWords } from '../../../../core/turn-power/outside-words.js';
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
  expandTilde: (userPath: string) => userPath,
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

// Chats that carry a mark that holds (a Wi-Fi sign-in's), as `marksOf` reads them; every other
// chat reads its real marks.
const heldChats = vi.hoisted(() => new Set<string>());
vi.mock('../../../../core/turn-power/turn-levels.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../core/turn-power/turn-levels.js')>();
  return {
    ...real,
    marksOf: (sessionId: string | null | undefined, agentPath: string | undefined) =>
      sessionId && heldChats.has(sessionId)
        ? { outsider: true }
        : real.marksOf(sessionId, agentPath),
  };
});

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
  return {
    cwd: '/mock/project',
    requiredLaunches: runtimeRegistry.requiredLaunches.bind(runtimeRegistry),
    onSdkSessionRebind: async () => {},
    ...overrides,
  };
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
    runtimeRegistry.setDb(createTestDb());
  });

  it.each([
    'intact',
    'changed-bill',
    'changed-inference',
    'missing-marker',
    'corrupt-marker',
    'owned-old-alias',
  ] as const)(
    'cold reopen after refused native adoption keeps required authority: %s',
    async (variant) => {
      const sessionId = `4328-cold-${variant}`;
      const temp = mkdtempSync(path.join(os.tmpdir(), '4328-cold-required-'));
      const accountRoot = path.join(temp, 'account');
      const cwd = path.join(temp, 'project');
      mkdirSync(accountRoot);
      mkdirSync(cwd);
      mkdirSync(path.join(temp, 'dork'));
      vi.stubEnv('DORK_HOME', path.join(temp, 'dork'));
      vi.stubEnv('CLAUDE_CONFIG_DIR', accountRoot);
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
        vi.stubEnv(key, '');
      vi.mocked(configManager.get).mockImplementation(((key: string) =>
        key === 'runtimes'
          ? {
              claudeCode: {
                defaultAccount: 'cold-account',
                accounts: [{ id: 'cold-account', path: accountRoot }],
              },
            }
          : undefined) as typeof configManager.get);
      const db = createTestDb();
      runtimeRegistry.setDb(db);
      db.insert(roomSeatLaunchRequirements)
        .values({
          id: 'cold-required',
          destinationSessionId: sessionId,
          sourceSessionId: 'prior',
          sourceDispatchId: 'prior-dispatch',
          startSeq: 1,
          endSeq: 8,
          state: 'settled',
          createdAt: 'now',
          payload: JSON.stringify({
            version: 1,
            roomId: 'r',
            authorId: 'a',
            runtime: 'claude-code',
            root: accountRoot,
            accountId: 'cold-account',
            inference: 'own-account',
            billing: 'subscription',
          }),
        })
        .run();
      db.insert(sessionMetadata)
        .values({
          sessionId: sessionId,
          agentPath: cwd,
          runtime: 'claude-code',
          permissionMode: 'plan',
          model: 'claude-sonnet-4-5',
          effort: 'high',
          fastMode: false,
          requiredLaunchId: 'cold-required',
          createdAt: 'now',
        })
        .run();
      if (variant !== 'owned-old-alias')
        db.insert(sessionMetadata)
          .values({
            sessionId: 'independent',
            agentPath: path.join(temp, 'other'),
            runtime: 'claude-code',
            createdAt: 'earlier',
          })
          .run();
      const sessions = new SessionStore();
      sessions.configureSettings(runtimeRegistry, 'default');
      sessions.ensureSession(sessionId, { cwd, permissionMode: 'plan', hasStarted: true });
      const original = sessions.findSession(sessionId)!;
      original.accountRoot = accountRoot;
      const tools = {
        toolNameById: new Map(),
        resolvedResultIds: new Set(),
        toolInputReceived: new Set(),
      } as unknown as ToolState;
      try {
        if (variant === 'owned-old-alias') {
          const recorded = recordTurnLevels(
            {
              type: 'claude-code',
              getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
              async *sendMessage() {},
            } as unknown as AgentRuntime,
            () => 'plan'
          );
          for await (const _ of recorded.sendMessage(sessionId, 'Prior turn', {
            carriedMarks: { outsider: true },
            permissionCeiling: { asks: 'always', reach: 'read' },
          })) {
          }
          expect(marksOf(sessionId, undefined)).toMatchObject({ outsider: true });
          getOrCreateProjector(sessionId, cwd);
        }
        for await (const _ of mapSdkMessage(
          {
            type: 'system',
            subtype: 'init',
            session_id: 'independent',
            apiKeySource: 'oauth',
          } as unknown as SDKMessage,
          original,
          sessionId,
          tools
        )) {
        }
        if (variant === 'owned-old-alias') {
          await sessions.rebindSdkSession(sessionId, 'independent', sessionId, original);
          // Isolate cold settings after the genuine SDK/Registry alias commit.
          // The existing canonical carry contribution preserves its live mark.
          aliasTurnLevel(sessionId, 'independent');
          expect(marksOf('independent', undefined)).toMatchObject({ outsider: true });
        } else
          await expect(
            sessions.rebindSdkSession(sessionId, 'independent', sessionId, original)
          ).rejects.toBeInstanceOf(RequiredSessionIdentityError);
        original.lastActivity = 0;
        sessions.checkSessionHealth({ cleanup: vi.fn() } as unknown as Parameters<
          SessionStore['checkSessionHealth']
        >[0]);
        expect(sessions.findSession(sessionId)).toBeUndefined();
        const nativeFolder = path.join(accountRoot, 'projects', projectSlug(cwd));
        mkdirSync(nativeFolder, { recursive: true });
        writeFileSync(
          path.join(nativeFolder, `${sessionId}.jsonl`),
          JSON.stringify({
            type: 'user',
            uuid: 'old-user',
            sessionId: sessionId,
            cwd,
            message: { role: 'user', content: 'Prior intact history' },
          }) + '\n'
        );
        if (variant === 'missing-marker')
          db.update(sessionMetadata)
            .set({ requiredLaunchId: null })
            .where(eq(sessionMetadata.sessionId, sessionId))
            .run();
        if (variant === 'corrupt-marker')
          db.update(sessionMetadata)
            .set({ requiredLaunchId: 'missing-record' })
            .where(eq(sessionMetadata.sessionId, sessionId))
            .run();
        if (variant === 'changed-bill')
          vi.mocked(resolveClaudeCredentialEnv).mockResolvedValueOnce({
            ANTHROPIC_API_KEY: 'edge-fixture-only',
          });
        if (variant === 'changed-inference')
          writeFileSync(
            path.join(accountRoot, 'settings.json'),
            JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://unsupported.example.invalid' } })
          );
        vi.mocked(query).mockClear();
        vi.mocked(query).mockReturnValue({
          [Symbol.asyncIterator]: async function* () {},
        } as unknown as ReturnType<typeof query>);
        const observed = [];
        try {
          const cold = await sessions.ensureForMessage(sessionId, new TranscriptReader(), cwd);
          expect(cold).not.toBe(original);
          for await (const event of executeSdkQuery(
            sessionId,
            'Different new work',
            cold,
            makeOpts({ cwd }),
            { cwd }
          ))
            observed.push(event);
        } catch (error) {
          if (variant === 'intact' || (error instanceof Error && error.name === 'AssertionError'))
            throw error;
          observed.push({ type: 'error', data: { message: String(error) } });
        }
        if (variant === 'owned-old-alias') {
          if (vi.mocked(query).mock.calls.length) {
            expect(marksOf(sessionId, undefined)).toMatchObject({ outsider: true });
            expect(query).toHaveBeenCalledOnce();
            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.permissionMode).toBe('plan');
            expect(options.model).toBe('claude-sonnet-4-5');
            expect(options.effort).toBe('high');
            expect(options.settings).toMatchObject({ fastMode: false });
            expect(options.resume).toBe('independent');
            expect(options.env?.CLAUDE_CONFIG_DIR).toBe(accountRoot);
          } else {
            expect(query).not.toHaveBeenCalled();
            const reasons = observed
              .flatMap((event) =>
                event.type === 'error' &&
                'message' in event.data &&
                typeof event.data.message === 'string'
                  ? [event.data.message]
                  : []
              )
              .join(' ');
            expect(reasons).toMatch(/required|recovery|canonical|identity|alias/i);
          }
        } else if (variant === 'intact') {
          expect(query).toHaveBeenCalledOnce();
          expect(vi.mocked(query).mock.calls[0][0].options?.env?.CLAUDE_CONFIG_DIR).toBe(
            accountRoot
          );
          expect(runtimeRegistry.requiredLaunches().forSession(sessionId)).toMatchObject({
            root: accountRoot,
            inference: 'own-account',
            billing: 'subscription',
          });
        } else {
          const expected =
            variant === 'changed-bill'
              ? 'billing choice cannot be preserved'
              : variant === 'changed-inference'
                ? 'inference source is unknown'
                : variant === 'missing-marker'
                  ? 'reference is missing'
                  : 'requirement is missing';
          expect(
            observed
              .flatMap((event) =>
                event.type === 'error' &&
                'message' in event.data &&
                typeof event.data.message === 'string'
                  ? [event.data.message]
                  : []
              )
              .join(' ')
          ).toContain(expected);
          expect(observed.some((event) => event.type === 'error')).toBe(true);
          expect(query).not.toHaveBeenCalled();
        }
      } finally {
        disposeProjector(sessionId);
        disposeProjector('independent');
        vi.unstubAllEnvs();
        vi.mocked(configManager.get).mockReset();
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );

  it('refuses a changed subscription bill through the actual final launch resolver after settlement', async () => {
    const db = createTestDb();
    runtimeRegistry.setDb(db);
    const account = resolveLaunchAccountRoot({ hintId: 'default', project: null });
    if (!account.ok) throw account.error;
    vi.mocked(resolveClaudeCredentialEnv).mockResolvedValueOnce({
      ANTHROPIC_API_KEY: 'edge-test-only',
    });
    db.insert(roomSeatLaunchRequirements)
      .values({
        id: 'required',
        destinationSessionId: 's1',
        sourceSessionId: 'old',
        sourceDispatchId: 'prior-dispatch',
        startSeq: 1,
        endSeq: 8,
        state: 'settled',
        createdAt: 'now',
        payload: JSON.stringify({
          version: 1,
          roomId: 'r',
          authorId: 'a',
          runtime: 'claude-code',
          root: account.root,
          accountId: 'default',
          inference: 'own-account',
          billing: 'subscription',
        }),
      })
      .run();
    db.insert(sessionMetadata)
      .values({ sessionId: 's1', requiredLaunchId: 'required', createdAt: 'now' })
      .run();
    await expect(
      resolveLaunch({
        sessionId: 's1',
        content: 'new work',
        session: makeSession(),
        opts: makeOpts(),
        effectiveCwd: '/mock/project',
      })
    ).rejects.toThrow('billing choice cannot be preserved');
    expect(query).not.toHaveBeenCalled();
  });

  it.each(
    CREDITS_BLANKED_SETTINGS_NAMES.filter((name) => name !== 'ANTHROPIC_API_KEY').flatMap((name) =>
      (['inherited', 'user', 'folder'] as const).map((layer) => ({ name, layer }))
    )
  )(
    'refuses unsupported recovery routing $name from $layer before SDK entry',
    async ({ name, layer }) => {
      const temp = mkdtempSync(path.join(os.tmpdir(), '4328-final-route-'));
      const accountRoot = path.join(temp, 'account');
      const cwd = path.join(temp, 'project');
      mkdirSync(accountRoot, { recursive: true });
      mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      const db = createTestDb();
      runtimeRegistry.setDb(db);
      db.insert(roomSeatLaunchRequirements)
        .values({
          id: 'route-required',
          destinationSessionId: 's1',
          sourceSessionId: 'old',
          sourceDispatchId: 'prior-dispatch',
          startSeq: 1,
          endSeq: 8,
          state: 'settled',
          createdAt: 'now',
          payload: JSON.stringify({
            version: 1,
            roomId: 'r',
            authorId: 'a',
            runtime: 'claude-code',
            root: accountRoot,
            accountId: 'route-account',
            inference: 'own-account',
            billing: 'subscription',
          }),
        })
        .run();
      db.insert(sessionMetadata)
        .values({ sessionId: 's1', requiredLaunchId: 'route-required', createdAt: 'now' })
        .run();
      vi.mocked(configManager.get).mockImplementation(((key: string) =>
        key === 'runtimes'
          ? {
              claudeCode: {
                defaultAccount: 'route-account',
                accounts: [{ id: 'route-account', path: accountRoot }],
              },
              environment: { inherit: { claudeCode: [name], codex: [], opencode: [] } },
            }
          : undefined) as typeof configManager.get);
      try {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
        const value = name.endsWith('BASE_URL')
          ? 'https://unsupported.example.invalid'
          : /(?:USE_|SKIP_|MANAGED_BY_HOST)/.test(name)
            ? '1'
            : 'fixture-host-auth';
        if (layer === 'inherited') vi.stubEnv(name, value);
        else
          writeFileSync(
            layer === 'user'
              ? path.join(accountRoot, 'settings.json')
              : path.join(cwd, '.claude', 'settings.json'),
            JSON.stringify({ env: { [name]: value } })
          );
        const attempt = async () => {
          for await (const _event of executeSdkQuery(
            's1',
            'new work',
            makeSession(),
            makeOpts({ cwd }),
            { cwd }
          )) {
            // Fully drain: the required refusal must precede any SDK entry.
          }
        };
        await expect(attempt()).rejects.toThrow('Recovery inference source is unsupported.');
        expect(query).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        vi.mocked(configManager.get).mockReset();
        db.$client.close();
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );

  it('skips the card for a read in the working folder, a grant or a loaded plugin, and nowhere else (DOR-3300)', async () => {
    const captured: { options?: Options } = {};
    vi.mocked(query).mockImplementation((args) => {
      captured.options = args.options;
      return {
        [Symbol.asyncIterator]: async function* () {},
      } as unknown as ReturnType<typeof query>;
    });
    const session = { ...makeSession(), unattended: true };
    const sender = makeOpts({ plugins: [{ type: 'local', path: '/mock/plugins/sample' }] });
    const grants = { additionalDirectories: [{ path: '/mock/grant', access: 'read' as const }] };
    for await (const _event of executeSdkQuery('s1', 'hello', session, sender, grants)) {
      // Drained: the launch is what is under test.
    }
    const reads = async (file_path: string) => {
      const result = await captured.options!.canUseTool!(
        'Read',
        { file_path },
        { signal: new AbortController().signal, toolUseID: file_path, requestId: file_path }
      );
      return result?.behavior;
    };
    expect(await reads('/mock/project/notes.md')).toBe('allow');
    expect(await reads('/mock/grant/notes.md')).toBe('allow');
    expect(await reads('/mock/plugins/sample/skills/x/ref.md')).toBe('allow');
    expect(await reads('/mock/plugins/other/ref.md')).toBe('deny');
    expect(await reads('/mock/elsewhere/notes.md')).toBe('deny');
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

  it('registers the hook that refuses a removed MCP server mid-chat, on MCP tools (DOR-3872)', async () => {
    const options = await captureSdkOptions();
    const matchers = (options.hooks?.PreToolUse ?? []).map((m) => m.matcher);
    expect(matchers).toContain('^mcp__');
  });

  it("registers the hooks that record a helper agent's tool calls, on every tool", async () => {
    const options = await captureSdkOptions();
    const unmatched = (options.hooks?.PostToolUse ?? []).filter((m) => m.matcher === undefined);
    expect(unmatched).toHaveLength(1);
    expect(options.hooks?.PostToolUseFailure).toEqual([{ hooks: [unmatched[0]!.hooks[0]] }]);
  });

  it('registers the held turn’s ask on every tool, read from the session as each call is made', async () => {
    // DOR-3204. Unregistered, a held turn runs whatever the folder's allow rules allow, unasked.
    const session = makeSession();
    const options = await captureSdkOptions(undefined, session);
    const unmatched = (options.hooks?.PreToolUse ?? []).filter((m) => m.matcher === undefined);
    // The only hook on every tool: there is no teammate fence (DOR-3440).
    expect(unmatched).toHaveLength(1);
    const hook = unmatched[0]!.hooks[0]!;
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

  it('hands the Never ask hook the chat’s own outside-words check (DOR-4600, Security S3)', async () => {
    // Red when: the launch passes the hook only the turn's marks. Then a status read runs for no
    // chat, or for one that read outside words.
    const session = { ...makeSession(), permissionMode: 'dontAsk' as const };
    const options = await captureSdkOptions(undefined, session);
    const neverAsk = (options.hooks?.PreToolUse ?? []).find((m) => m.matcher === '^mcp__dorkos__');
    const hook = neverAsk!.hooks[0]!;
    const statusRead = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'sdk-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/mock/project',
      tool_name: 'mcp__dorkos__running_chats',
      tool_input: {},
      tool_use_id: 'tool-1',
      mcp_server: { name: 'dorkos', source: 'sdk' },
    };
    const signal = { signal: new AbortController().signal };

    expect(await hook(statusRead, 'tool-1', signal)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    // A room turn that answered someone from outside (DOR-4029): the chat read outside words.
    noteRoomTurnWords('sdk-1', true);
    try {
      expect(await hook(statusRead, 'tool-1', signal)).toEqual({});
    } finally {
      noteRoomTurnWords('sdk-1', false);
    }
  });

  it('launches a teammate’s turn as any other: notes, profile, grants and process (DOR-3440)', async () => {
    // Red when: a teammate's turn is launched apart again, which is the lowering Dorian removed.
    const asked: Array<Record<string, unknown> | undefined> = [];
    vi.mocked(buildSystemPromptAppend).mockImplementation(async (_home, _cwd, _gates, options) => {
      asked.push(options as Record<string, unknown> | undefined);
      return {
        text: '<env>mock</env>\n\n<agent_memory>x</agent_memory>',
        stable: '<env>mock</env>',
      };
    });
    const grants = [{ path: '/elsewhere/private-repo', access: 'read' as const }];
    const resolve = (turnId: string, teammate: boolean) =>
      resolveLaunch({
        sessionId: 's1',
        content: 'hello',
        session: makeSession(),
        opts: makeOpts(),
        messageOpts: {
          additionalDirectories: grants,
          roomTurn: {
            roomId: 'room-a',
            authorId: 'ana',
            turnId,
            ...(teammate ? { teammate } : {}),
          },
        },
        effectiveCwd: '/mock/project',
      });
    const owner = await resolve('t1', false);
    const teammate = await resolve('t2', true);
    const append = (launch: typeof owner) =>
      (launch.sdkOptions.systemPrompt as { append: string }).append;

    expect(append(teammate)).toContain('<agent_memory>');
    expect(append(teammate)).not.toContain('<teammate_turn>');
    expect(asked[0]).not.toHaveProperty('memory');
    expect(asked[0]).not.toHaveProperty('teammate');
    expect(
      (teammate.sdkOptions.settings as { permissions?: { additionalDirectories?: string[] } })
        ?.permissions?.additionalDirectories
    ).toContain('/elsewhere/private-repo');
    expect(teammate.sdkOptions.settingSources).toEqual(['local', 'project', 'user']);
    expect(teammate.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    expect(
      compareLaunchFingerprints(
        captureLaunchFingerprint(owner.launch),
        captureLaunchFingerprint(teammate.launch)
      ).action
    ).not.toBe('relaunch');
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

    it('is the same for a teammate’s turn, as the room runner sends it', async () => {
      const launched = await resolveWith('/compact', {
        roomTurn: {
          roomId: 'room-a',
          authorId: 'ana',
          turnId: 't1',
          ...roomTurnMarksOf({ teammate: true }),
        },
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
    ['a Wi-Fi sign-in’s hold', 'runtime-default' as const],
    ['a read-only cap', ['runtime-default', READ_ONLY_LEVEL] as const],
  ])('launches at the runtime’s Default for %s', async (_name, ceiling) => {
    const options = await launchAs(
      { permissionCeiling: ceiling as TurnPermissionCeiling },
      bypassSession()
    );
    expect(options.permissionMode).not.toBe('bypassPermissions');
    expect(['default', 'plan']).toContain(options.permissionMode);
  });

  it('launches at Full autonomy for a teammate’s turn, whose mark only records (DOR-3440)', async () => {
    const options = await launchAs(
      {
        permissionCeiling: {
          asks: 'never',
          reach: 'everything',
          teammate: [{ roomId: 'r', authorId: 'a' }],
        },
      },
      bypassSession()
    );
    expect(options.permissionMode).toBe('bypassPermissions');
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

  it('gives a marked turn none of the folders it was granted, and an unmarked one all (Security S2, #3280)', async () => {
    const grants = {
      additionalDirectories: [{ path: '/rooms/r1/worktrees/ana', access: 'write' }],
    };
    const granted = (options: Options) =>
      (options.settings as { permissions?: { additionalDirectories?: string[] } } | undefined)
        ?.permissions?.additionalDirectories ?? [];

    expect(granted(await captureSdkOptions(grants as MessageOpts))).toContain(
      '/rooms/r1/worktrees/ana'
    );
    heldChats.add('sdk-1');
    try {
      expect(granted(await captureSdkOptions(grants as MessageOpts))).toEqual([]);
    } finally {
      heldChats.clear();
    }
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
      // And every agent home's self-grant files, on every launch (DOR-3068 S1).
      ...agentHomesSelfGrantRules(resolveDorkHome(), 'launch'),
      // And every project's installed plugins (DOR-3068).
      ...['Edit', 'Write', 'NotebookEdit'].map((tool) => `${tool}(//**/.dork/plugins/**)`),
      // And the browser sign-in stores in the home folder, on every launch (DOR-4136).
      ...HOME_PERSON_ONLY_RULES,
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

  // DOR-4136: the browser sign-in stores are denied below Full only, at the level the launch
  // really runs at. The agent browser's guard config stays denied at Full.
  describe('browser sign-in stores by level', () => {
    const denyOf = (options: Options) =>
      (options.settings as { permissions: { deny: string[] } }).permissions.deny;
    const session = `Write(/${resolveDorkHome()}/browser/storage-state.json)`;
    const guard = `Write(/${resolveDorkHome()}/browser/agent-browser-guard.json*)`;

    it('denies them below Full', async () => {
      const deny = denyOf(await captureSdkOptions({}, makeSession()));
      expect(deny).toContain(session);
      expect(deny).toEqual(expect.arrayContaining([...HOME_PERSON_ONLY_RULES]));
    });

    it('leaves them out at Full, and keeps the guard config', async () => {
      const deny = denyOf(
        await captureSdkOptions({}, { ...makeSession(), permissionMode: 'bypassPermissions' })
      );
      expect(deny).not.toContain(session);
      expect(deny).not.toContain('Write(~/Library/Application Support/DorkOS/**)');
      expect(deny).toContain(guard);
      expect(deny).toEqual(expect.arrayContaining([...HOME_PERSON_ONLY_FULL_RULES]));
    });

    it('denies them to a chat set to Full whose turn is held below Full', async () => {
      const deny = denyOf(
        await captureSdkOptions(
          {},
          {
            ...makeSession(),
            permissionMode: 'bypassPermissions',
            turnPermissionCeiling: 'runtime-default',
          }
        )
      );
      expect(deny).toContain(session);
    });
  });

  it('refuses an invalid set before anything launches', async () => {
    vi.mocked(query).mockClear();
    await expect(
      captureSdkOptions({ additionalDirectories: [{ path: 'relative/dir', access: 'read' }] })
    ).rejects.toThrow(/not an absolute path/);
    expect(query).not.toHaveBeenCalled();
  });
});
