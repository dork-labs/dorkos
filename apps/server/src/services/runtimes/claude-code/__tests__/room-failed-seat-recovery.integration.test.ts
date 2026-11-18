/**
 * Core4328 oracle. Real RoomService/claims/capabilities/mover/SQLite and SDK
 * mapper→normalizer→record projector; FakeAgentRuntime replaces only model I/O.
 * Requires the REAL integration-generated migration. Never create fake DDL or
 * count missing-table/import/setup errors as a recovery regression.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initBoundary } from '../../../../lib/boundary.js';
import { projectOfFolder } from '../../../core/usage/account-eligibility.js';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeAgentRuntime, mockInterruptReceipt } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { roomSeatLaunchRequirements, sessionMetadata } from '@dorkos/db';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../../lib/logger.js';
import { runInDispatch } from '../../../../lib/dispatch-context.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import { recordTurnLevels, marksOf } from '../../../core/turn-power/turn-levels.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import {
  initAccountSigninPolicy,
  accountSigninPolicy,
} from '../../../health/account-signin-policy.js';
import {
  AgentPauseService,
  initAgentPause,
  resetAgentPause,
} from '../../../mesh/pause/agent-pause.js';
import { roomsDomain } from '../../../rooms/room-capabilities.js';
import {
  createRoomHarness,
  agentLookupFor,
  roomVoice,
  type ScriptedTurnRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import {
  noteTurnFailure,
  settleTurnFailure,
  type TurnFailure,
} from '../../../rooms/turn-guards/turn-waits.js';
import { failedSeatCandidate } from '../../../rooms/reseat/failed-seat-candidate.js';
import { RoomSeatMover } from '../../../rooms/reseat/seat-mover.js';
import { claudeTranscriptPath } from '../../../session/fleet/carry-over-summary.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import { TURN_NOT_STARTED_CODE } from '../../../session/launch/turn-not-started.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import {
  getOrCreateProjector,
  setSessionEventStore,
} from '../../../session/session-state-projector.js';
import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import { createToolState } from '../agent-types.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { parseTranscript } from '../sessions/transcript-parser.js';
import { SessionCrashRecovery } from '../sessions/session-crash-recovery.js';
import {
  failedSessionAuthority,
  observedSessionBilling,
} from '../sessions/identity/failed-seat-authority.js';
import {
  requiredClaudeRoot,
  enforceRequiredClaudeConfiguration,
  validatedRecoveryRoute,
} from '../messaging/launch/required-launch.js';
import type { AgentSession } from '../agent-types.js';

const PRIOR_TEXT = 'Prior task: do not replay this instruction.';
const NEW_DRAFT = 'The release is ready.';
const NOTICE = 'API Error: upstream unavailable';

type Variant =
  | 'positive'
  | 'wrong-witness'
  | 'unknown-bill'
  | 'crash-loop'
  | 'mixed-auth'
  | 'unregistered-account';

/** Model-edge double delegates recovery evidence to the SAME production readers/policy. */
class SdkEdgeRuntime extends FakeAgentRuntime {
  readonly sessions = new Map<string, AgentSession>();
  readonly crashes = new Map<string, SessionCrashRecovery>();
  constructor(readonly home: string) {
    super('claude-code');
    this.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
    this.getSessionCwd = () => home;
    this.getInternalSessionId.mockImplementation((id) => id);
  }
  readFailedSeatAuthority(id: string) {
    const crash = this.crashes.get(id);
    return failedSessionAuthority(this.sessions.get(id), !crash || !crash.willAutoResume);
  }
  readObservedBilling(id: string) {
    return observedSessionBilling(this.sessions.get(id));
  }
  state(id: string, root: string) {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        sdkSessionId: id,
        cwd: this.home,
        launchedAccountRoot: root,
        hasStarted: false,
        permissionMode: 'plan',
        lastActivity: Date.now(),
        pendingInteractions: new Map(),
        eventQueue: [],
      } as AgentSession;
      this.sessions.set(id, session);
      // Real guard: a fake process transport, never a fake willAutoResume flag.
      this.crashes.set(
        id,
        new SessionCrashRecovery({
          sessionId: id,
          pump: { state: 'warm' },
          windows: {
            onCrash() {},
            dispatch: async () => {
              throw new Error('fixture never dispatches through crash retry');
            },
          },
        })
      );
    }
    return session;
  }
}

let scratch: string | undefined;
let usage: AccountUsageStore | undefined;
afterEach(async () => {
  usage?.stop();
  await usage?.flush();
  usage = undefined;
  setAccountUsageStore(undefined);
  setSessionEventStore(undefined);
  resetAgentPause();
  clearTestHomes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function fixture(variant: Variant = 'positive', projectPolicy?: 'eligible' | 'disallowed') {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), '4328-real-room-')));
  await initBoundary(scratch);
  const dorkHome = path.join(scratch, 'dork');
  const home = path.join(scratch, 'agent');
  const root = path.join(scratch, 'claude-account');
  await Promise.all([dorkHome, home, root].map((dir) => mkdir(dir, { recursive: true })));
  if (projectPolicy) execFileSync('git', ['init', '-q'], { cwd: home });
  vi.stubEnv('DORK_HOME', dorkHome);
  // No credential or paid arm exists in this fixture; an accidental HTTP effect is a defect.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network forbidden in4328 fixture');
    })
  );
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const config = initConfigManager(dorkHome);
  config.setDot('runtimes.claudeCode.accounts', [
    { id: 'fixture-account', label: 'Fixture', path: root },
  ]);
  config.setDot('runtimes.claudeCode.defaultAccount', 'fixture-account');
  registerTestHomes([home]);
  await writeFile(
    path.join(root, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        accountUuid: randomUUID(),
        organizationUuid: randomUUID(),
        emailAddress: 'fixture@example.invalid',
      },
    })
  );
  initAccountSigninPolicy(dorkHome);
  accountSigninPolicy()!.seed([{ root, identity: null }], new Date());
  // The real policy subsequently observes fixture metadata; no sign-in probe/network.
  usage = new AccountUsageStore({
    dorkHome,
    readConfig: async () => config.getAll(),
    resolveDefaultRoot: () => ({ path: root, warnings: [] }),
    timings: { scanIntervalMs: 3_600_000 },
  });
  await usage.load();
  usage.record('claude-code', { path: root }, [
    { key: 'five_hour', usedPct: 10, observedAt: new Date().toISOString(), source: 'sdk_event' },
  ]);
  setAccountUsageStore(usage);

  // Normal registered migrations, including the future integration-generated requirement migration.
  const db = createTestDb();
  runtimeRegistry.setDb(db);
  initAgentPause(new AgentPauseService({ db }));
  const eventStore = new SessionEventStore(db);
  setSessionEventStore(eventStore);
  const fake = new SdkEdgeRuntime(home);
  const runtime = recordTurnLevels(fake, () => 'plan');
  runtimeRegistry.register(runtime);
  const priorId = randomUUID();
  const freshId = randomUUID();
  const priorDispatch = `dsp_${randomUUID()}`;
  const launched: Array<{ sessionId: string; content: string; options?: MessageOpts }> = [];
  let requestId: string = priorId;

  const init = (id: string): SDKMessage =>
    ({
      type: 'system',
      subtype: 'init',
      session_id: id,
      ...(variant === 'unknown-bill' && id === priorId ? {} : { apiKeySource: 'oauth' }),
    }) as SDKMessage;
  const failure = (code: string): SDKMessage =>
    ({
      type: 'assistant',
      error: code,
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: NOTICE }] },
    }) as unknown as SDKMessage;
  const terminal = (id: string, subtype: string): SDKMessage =>
    ({
      type: 'result',
      subtype,
      errors: subtype === 'success' ? [] : [NOTICE],
      session_id: id,
    }) as unknown as SDKMessage;
  const messages = (id: string) =>
    id === priorId
      ? [
          init(id),
          failure('server_error'),
          ...(variant === 'mixed-auth' ? [failure('authentication_failed')] : []),
          terminal(id, 'error_during_execution'),
        ]
      : [init(id), terminal(id, 'success')];
  const nativeTranscript = (id: string) =>
    [
      {
        type: 'user',
        uuid: `user-${id}`,
        sessionId: id,
        cwd: home,
        timestamp: '2026-11-15T12:00:00Z',
        message: { role: 'user', content: id === priorId ? PRIOR_TEXT : NEW_DRAFT },
      },
      ...messages(id)
        .filter((message) => message.type === 'assistant')
        .map((message, index) => ({
          ...message,
          uuid: `assistant-${id}-${index}`,
          sessionId: id,
          cwd: home,
          timestamp: '2026-11-15T12:00:01Z',
        })),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  fake.sendMessage.mockImplementation(async function* (id, content, options) {
    launched.push({ sessionId: id, content, options });
    const state = fake.state(id, root);
    state.validatedRecoveryRoute = validatedRecoveryRoute(
      root,
      false,
      {},
      { cwd: home, settings: {} }
    );
    if (!fake.crashes.get(id)!.willAutoResume) {
      yield {
        type: 'error',
        data: {
          code: TURN_NOT_STARTED_CODE,
          reason: 'crash-loop',
          message: 'The process keeps stopping.',
        },
      };
      yield { type: 'done', data: { sessionId: id } };
      return;
    }
    const tools = createToolState();
    for (const sdk of messages(id)) {
      for await (const event of mapSdkMessage(sdk, state, id, tools)) {
        // A real model's tool effect, through the real capability/room identity/freshness gate.
        if (id !== priorId && event.type === 'done') {
          const context = {
            identity: {
              agentPath: home,
              displayName: 'Fixture',
              createdAt: new Date().toISOString(),
            },
            sessionId: id,
            retryChannel: 'mcp-argument' as const,
          };
          await registry.invoke('rooms.read_history', { roomId }, context);
          await registry.invoke('rooms.post', { roomId, text: NEW_DRAFT, confirm: true }, context);
        }
        yield event;
      }
    }
  });

  const runner: ScriptedTurnRunner = {
    turns: [],
    interrupted: [],
    ...roomVoice(),
    interrupt: async () => mockInterruptReceipt('not-running'),
    async run(request) {
      const id = request.sessionId!;
      requestId = id;
      const authority = await requiredClaudeRoot({
        sessionId: id,
        sessionRoot: id === priorId ? root : undefined,
        cwd: home,
        requiredLaunches: runtimeRegistry.requiredLaunches.bind(runtimeRegistry),
      });
      enforceRequiredClaudeConfiguration(
        authority.requirement,
        authority.root,
        false,
        {},
        { cwd: home, settings: {} }
      );
      await runtimeRegistry.persistSessionRuntime(
        id,
        'claude-code',
        { kind: 'room', externalAuthor: false },
        home
      );
      const projector = getOrCreateProjector(id);
      projector.enablePersistence(eventStore, 'record');
      const native = claudeTranscriptPath(root, home, id)!;
      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(native, nativeTranscript(id));
      request.onSessionBound(id);
      await feedProjector(
        projector,
        runtime.sendMessage(id, request.prompt, {
          cwd: home,
          forAgent: home,
          permissionMode: 'plan',
          permissionCeiling: request.permissionCeiling,
          ...(request.carriedOutsider ? { carriedMarks: { outsider: true as const } } : {}),
        }),
        { userMessage: request.prompt, roomMessage: { roomId, entryId: request.entry.id } }
      );
      const failure = (eventStore.readLatestTurnStrict(id) ?? []).reduce<Partial<TurnFailure>>(
        (known, event) => noteTurnFailure(known, event),
        {}
      );
      return {
        sessionId: id,
        text: null,
        ...('detail' in failure
          ? { unanswered: 'failed' as const, failure: settleTurnFailure(failure, true) }
          : {}),
      };
    },
  };
  const harness = createRoomHarness({
    db,
    agents: agentLookupFor({
      [home]: {
        name: 'fixture',
        displayName: 'Fixture',
        responseMode: 'mention-only',
      },
    }),
    runner,
    turnLimitsEnabled: false,
    seatMover: () => mover,
  });
  const { service, store, authors, human } = harness;
  const room = service.createRoom(
    { kind: 'channel', title: 'Recovery', members: [], agentPaths: [home] },
    human
  );
  const roomId = room.id;
  const authorId = authors.resolveAgent(home, 'Fixture').id;
  // Seed the prior room entry without scheduling a second concurrent model turn.
  // The completed prior dispatch below still uses the actual SDK/normalizer/store chain.
  const priorEntryKey = randomUUID();
  const priorEntry = store.appendEntry({
    roomId,
    id: priorEntryKey,
    authorId: human,
    kind: 'post',
    body: { text: 'Earlier work' },
    mentions: [],
    sessionId: null,
    cascadeRoot: priorEntryKey,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: new Date().toISOString(),
  });
  const priorEntryId = priorEntry.id;
  store.bindRoomSession(roomId, authorId, priorId, new Date().toISOString());
  db.insert(sessionMetadata)
    .values({
      sessionId: priorId,
      runtime: 'claude-code',
      agentPath: home,
      permissionMode: 'plan',
      model: 'fixture-model',
      effort: 'high',
      fastMode: false,
      createdAt: new Date().toISOString(),
    })
    .run();
  const registry: CapabilityRegistry = composeRegistry([roomsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms: service },
  });
  const oldNative = claudeTranscriptPath(root, home, priorId)!;
  const originalTranscript = nativeTranscript(priorId);
  await mkdir(path.dirname(oldNative), { recursive: true });
  await writeFile(oldNative, originalTranscript);
  const projector = getOrCreateProjector(priorId);
  projector.enablePersistence(eventStore, 'record');
  await runInDispatch({ dispatchId: priorDispatch, origin: 'room', entryId: priorEntryId }, () =>
    feedProjector(
      projector,
      runtime.sendMessage(priorId, PRIOR_TEXT, {
        cwd: home,
        forAgent: home,
        permissionMode: 'plan',
        permissionCeiling: { asks: 'always', reach: 'edit', outsider: true },
      }),
      { userMessage: PRIOR_TEXT, roomMessage: { roomId, entryId: priorEntryId } }
    )
  );
  if (variant === 'wrong-witness') {
    // Keep history valid/intact, but the persisted terminal belongs to another dispatch.
    const events = eventStore
      .readAll(priorId)
      .map((event) =>
        event.type === 'error' && event.reason === 'claude-server-error-terminal'
          ? { ...event, sourceDispatchId: `dsp_${randomUUID()}` }
          : event
      );
    eventStore.deleteSession(priorId);
    eventStore.appendTurn(priorId, events);
  }
  if (projectPolicy) {
    const otherProject = path.join(scratch!, 'other-project');
    await mkdir(otherProject);
    execFileSync('git', ['init', '-q'], { cwd: otherProject });
    // The prior turn was allowed; the owner's current restriction applies now.
    config.setDot('runtimes.claudeCode.accounts', [
      {
        id: 'fixture-account',
        label: 'Fixture',
        path: root,
        onlyProjects: [projectPolicy === 'eligible' ? home : otherProject],
      },
    ]);
  }
  if (variant === 'unregistered-account') {
    const otherRoot = path.join(scratch!, 'different-account');
    await mkdir(otherRoot);
    await writeFile(
      path.join(otherRoot, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: randomUUID(), organizationUuid: randomUUID() },
      })
    );
    config.setDot('runtimes.claudeCode.accounts', [
      { id: 'different', label: 'Different', path: otherRoot },
    ]);
    config.setDot('runtimes.claudeCode.defaultAccount', 'different');
  }
  if (variant === 'crash-loop') {
    const guard = fake.crashes.get(priorId)!;
    guard.handleCrash({
      sessionId: priorId,
      stateAtCrash: 'running',
      error: new Error('fixture process crash'),
    });
    guard.handleCrash({
      sessionId: priorId,
      stateAtCrash: 'running',
      error: new Error('fixture process crash'),
    });
    expect(guard.willAutoResume).toBe(false);
  }
  const ranking = vi.fn(async () => {
    throw new Error('recovery must never rank/failover');
  });
  const mover = new RoomSeatMover({
    recoveryCandidate: failedSeatCandidate,
    requiredLaunches: runtimeRegistry.requiredLaunches(),
    runtimeOf: async () => 'claude-code',
    newSeatRuntime: async () => 'claude-code',
    rebind: (r, a, s) => store.rebindRoomSession(r, a, s),
    settingsOf: (id) => runtimeRegistry.getSessionSettings(id),
    saveSettings: (id, settings) => runtimeRegistry.saveSessionSettings(id, settings),
    declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    effectiveModeOf: async () => 'plan',
    ranking,
    accountOf: async () => {
      throw new Error('preference-fallback account reader must not run');
    },
    transcriptState: async (seat) => {
      try {
        return (await readFile(claudeTranscriptPath(root, home, seat.sessionId!)!, 'utf8')).trim()
          ? 'present'
          : 'unknown';
      } catch {
        return 'unknown';
      }
    },
    summaryOf: async () => {
      throw new Error('prior work must not become a recovery prompt');
    },
    recordActivity: vi.fn(),
    recordSeatMove: (id, r, a) => store.sessionLedger.recordSeatMove(id, r, a),
    newSessionId: () => freshId,
  });
  const beforeMarks = marksOf(priorId, undefined);
  const submit = async () => {
    const answer = await registry.invoke(
      'rooms.post',
      { roomId, text: NEW_DRAFT },
      {
        identity: { agentPath: home, displayName: 'Fixture', createdAt: new Date().toISOString() },
        sessionId: `child_${randomUUID()}`,
        retryChannel: 'mcp-argument',
      }
    );
    await service.handoffs.idle();
    await service.triggersIdle();
    return answer;
  };
  return {
    config,
    db,
    service,
    store,
    roomId,
    authorId,
    priorId,
    freshId,
    root,
    home,
    oldNative,
    originalTranscript,
    launched,
    ranking,
    submit,
    beforeMarks,
    eventStore,
    fake,
    currentRequestId: () => requestId,
    info,
    warn,
    priorDispatch,
  };
}

describe('4328 real room recovery of a prior SDK server error', () => {
  it('moves once for different new work, posts once, preserves intact old history and billing/power', async () => {
    const f = await fixture();
    expect(
      f.fake.readFailedSeatAuthority(f.priorId),
      'actual SDK billing and terminal authority'
    ).toMatchObject({
      root: f.root,
      inference: 'own-account',
      billing: 'subscription',
      dispatchId: f.priorDispatch,
    });
    const candidate = await failedSeatCandidate({
      roomId: f.roomId,
      authorId: f.authorId,
      agentPath: f.home,
      sessionId: f.priorId,
    });
    expect(candidate).not.toBeNull(); // Must come from actual SDK/store/current guard facts, never a stubbed eligible flag.
    await expect(f.submit()).resolves.toMatchObject({ handedOff: true });
    expect(f.store.getRoomSession(f.roomId, f.authorId)).toBe(f.freshId);
    expect(f.launched.map((turn) => turn.sessionId)).toEqual([f.priorId, f.freshId]);
    expect(f.launched[1]!.content).not.toContain(PRIOR_TEXT);
    expect(f.launched[1]!.content).toContain(NEW_DRAFT);
    expect(await readFile(f.oldNative, 'utf8')).toBe(f.originalTranscript);
    expect(
      parseTranscript(f.originalTranscript.split('\n')).find((message) => message.role === 'user')
        ?.content
    ).toBe(PRIOR_TEXT);
    expect(await runtimeRegistry.getSessionSettings(f.freshId)).toEqual(
      await runtimeRegistry.getSessionSettings(f.priorId)
    );
    expect(marksOf(f.freshId, undefined)).toMatchObject(f.beforeMarks);
    expect(runtimeRegistry.requiredLaunches().forSession(f.freshId)).toMatchObject({
      runtime: 'claude-code',
      root: f.root,
      inference: 'own-account',
      billing: 'subscription',
      state: 'settled',
    });
    const posts = f.store
      .listEntries(f.roomId, { limit: 100 })
      .filter((entry) => entry.kind === 'post' && entry.authorId === f.authorId);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.text).toContain(NEW_DRAFT);
    expect(f.db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(1);
    const recovered = f.info.mock.calls.find(
      ([message]) => message === '[rooms] recovered a failed handoff seat'
    )?.[1];
    expect(recovered).toMatchObject({
      handoffId: expect.any(String),
      dispatchId: expect.any(String),
      attempt: 1,
      oldSessionId: f.priorId,
      freshSessionId: f.freshId,
      sourceStartSeq: expect.any(Number),
      sourceEndSeq: expect.any(Number),
      typedCause: 'prior-server-error',
    });
    expect(JSON.stringify(recovered)).not.toContain(PRIOR_TEXT);
    expect(JSON.stringify(recovered)).not.toContain(NEW_DRAFT);
    expect(f.ranking).not.toHaveBeenCalled();
  });
  it.each(['eligible', 'disallowed'] as const)(
    'qualifies the exact observed account against the actual seat project: %s',
    async (policy) => {
      const f = await fixture('positive', policy);
      expect(await projectOfFolder(f.home)).toMatchObject({ root: f.home });
      const candidate = await failedSeatCandidate({
        roomId: f.roomId,
        authorId: f.authorId,
        agentPath: f.home,
        sessionId: f.priorId,
      });
      if (policy === 'eligible') {
        expect(candidate).not.toBeNull();
        expect(candidate?.authority).toMatchObject({ root: f.root, accountId: 'fixture-account' });
        expect(candidate?.currentAllowed()).toBe(true);
        f.config.setDot('runtimes.claudeCode.projectAccounts', {
          [f.home]: { allow: ['different-account'] },
        });
        expect(candidate?.currentAllowed()).toBe(false);
      } else expect(candidate).toBeNull();
      expect(f.store.getRoomSession(f.roomId, f.authorId)).toBe(f.priorId);
      expect(f.db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(0);
      expect(await readFile(f.oldNative, 'utf8')).toBe(f.originalTranscript);
    }
  );
  it.each<Variant>([
    'wrong-witness',
    'unknown-bill',
    'crash-loop',
    'mixed-auth',
    'unregistered-account',
  ])('does not recover %s or claim a new public voice', async (variant) => {
    const f = await fixture(variant);
    expect(
      await failedSeatCandidate({
        roomId: f.roomId,
        authorId: f.authorId,
        agentPath: f.home,
        sessionId: f.priorId,
      })
    ).toBeNull();
    await f.submit();
    expect(f.store.getRoomSession(f.roomId, f.authorId)).toBe(f.priorId);
    expect(f.db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(0);
    expect(
      f.store
        .listEntries(f.roomId, { limit: 100 })
        .filter((entry) => entry.kind === 'post' && entry.authorId === f.authorId)
    ).toHaveLength(0);
    expect(await readFile(f.oldNative, 'utf8')).toBe(f.originalTranscript);
    const failed = f.warn.mock.calls.find(
      ([message]) => message === '[rooms] handoff did not post'
    )?.[1];
    expect(failed).toMatchObject({
      handoffId: expect.any(String),
      dispatchId: expect.any(String),
      attempt: 0,
      oldSessionId: f.priorId,
      freshSessionId: null,
      typedCause: variant === 'crash-loop' ? 'crash-loop' : 'server-error',
    });
    expect(JSON.stringify(failed)).not.toContain(NOTICE);
    expect(JSON.stringify(failed)).not.toContain(NEW_DRAFT);
  });
});
