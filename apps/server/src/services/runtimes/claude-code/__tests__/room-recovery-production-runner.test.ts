/** Production room runner, Claude runtime/pump, mover and SQLite; only external SDK.query is fake. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, roomSeatLaunchRequirements } from '@dorkos/db';
import { initBoundary } from '../../../../lib/boundary.js';
import { runInDispatch } from '../../../../lib/dispatch-context.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { sdkSimpleText, wrapSdkQuery } from './sdk-scenarios.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/agent-identity-service.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { lastTurnLevelOf, marksOf } from '../../../core/turn-power/turn-levels.js';
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
import {
  createRoomHarness,
  agentLookupFor,
  roomVoice,
  type ScriptedTurnRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { buildRoomContext } from '../../../rooms/room-context.js';
import { createSessionRoomTurnRunner } from '../../../rooms/room-turn-runner.js';
import { setRoomService } from '../../../rooms/index.js';
import { roomsDomain } from '../../../rooms/room-capabilities.js';
import { RoomSeatMover } from '../../../rooms/reseat/seat-mover.js';
import { failedSeatCandidate } from '../../../rooms/reseat/failed-seat-candidate.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import { setSessionEventStore } from '../../../session/session-state-projector.js';
import { latestClaudeRoomServerFailure } from '../../../session/history/latest-room-failure.js';
import { claudeTranscriptPath } from '../../../session/fleet/carry-over-summary.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
let scratch: string | undefined;
let runtime: ClaudeCodeRuntime | undefined;
let usage: AccountUsageStore | undefined;
afterEach(async () => {
  await runtime?.endSessionsWhere(() => true);
  runtime = undefined;
  usage?.stop();
  await usage?.flush();
  usage = undefined;
  setAccountUsageStore(undefined);
  setSessionEventStore(undefined);
  resetAgentPause();
  resetAgentIdentityService();
  clearTestHomes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
it.each(['eligible', 'paused'] as const)(
  'handles %s actual Claude recovery with strict SDK options, history and constraints',
  async (variant) => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), '4328-production-room-')));
    await initBoundary(scratch);
    const home = path.join(scratch, 'agent');
    const root = path.join(scratch, 'account');
    const dorkHome = path.join(scratch, 'dork');
    await Promise.all([home, root, dorkHome].map((dir) => mkdir(dir, { recursive: true })));
    vi.stubEnv('DORK_HOME', dorkHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
      vi.stubEnv(name, '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network forbidden in production room oracle');
      })
    );
    const config = initConfigManager(dorkHome);
    config.setDot('runtimes.claudeCode.accounts', [
      { id: 'actual-account', label: 'Fixture', path: root },
    ]);
    config.setDot('runtimes.claudeCode.defaultAccount', 'actual-account');
    registerTestHomes([home]);
    await writeFile(
      path.join(root, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: randomUUID(), organizationUuid: randomUUID() },
      })
    );
    initAccountSigninPolicy(dorkHome);
    accountSigninPolicy()!.seed([{ root, identity: null }], new Date());
    usage = new AccountUsageStore({
      dorkHome,
      readConfig: async () => config.getAll(),
      resolveDefaultRoot: () => ({ path: root, warnings: [] }),
      timings: { scanIntervalMs: 3600000 },
    });
    await usage.load();
    usage.record('claude-code', { path: root }, [
      { key: 'five_hour', usedPct: 10, observedAt: new Date().toISOString(), source: 'sdk_event' },
    ]);
    setAccountUsageStore(usage);
    const db = createTestDb();
    runtimeRegistry.setDb(db);
    const pauses = new AgentPauseService({ db });
    initAgentPause(pauses);
    db.insert(agents)
      .values({
        id: 'registered-agent',
        name: 'fixture',
        runtime: 'claude-code',
        projectPath: home,
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    await initAgentIdentityService(db).mint({ agentPath: home, displayName: 'Fixture' });
    const events = new SessionEventStore(db);
    setSessionEventStore(events);
    runtime = new ClaudeCodeRuntime(dorkHome, home);
    runtimeRegistry.register(runtime);
    runtime.setSessionSettings(runtimeRegistry);
    const productionRunner = createSessionRoomTurnRunner({
      waitMs: () => 10000,
      ceilingMs: () => 15000,
    });
    const runner: ScriptedTurnRunner = Object.assign(
      productionRunner,
      { turns: [], interrupted: [] },
      roomVoice()
    );
    const h = createRoomHarness({
      db,
      agents: agentLookupFor({
        [home]: { name: 'fixture', displayName: 'Fixture', responseMode: 'mention-only' },
      }),
      runner,
      turnLimitsEnabled: false,
      seatMover: () => mover,
    });
    setRoomService(h.service);
    const room = h.service.createRoom(
      { kind: 'channel', title: 'Actual recovery', members: [], agentPaths: [home] },
      h.human
    );
    const authorId = h.authors.resolveAgent(home, 'Fixture').id;
    const prior = randomUUID();
    const fresh = randomUUID();
    const entryId = randomUUID();
    const entry = h.store.appendEntry({
      id: entryId,
      roomId: room.id,
      authorId: h.human,
      kind: 'post',
      body: { text: 'Prior work' },
      mentions: [],
      sessionId: null,
      cascadeRoot: entryId,
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      createdAt: new Date().toISOString(),
    });
    h.store.bindRoomSession(room.id, authorId, prior, new Date().toISOString());
    await runtimeRegistry.saveSessionSettings(prior, { permissionMode: 'plan', fastMode: false });
    const registry: CapabilityRegistry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: h.service },
    });
    const launches: Array<{ id: string; options: Options }> = [];
    const oldText = 'Prior instruction never to replay.';
    const draft = 'The release is ready.';
    const notice = 'API Error: upstream unavailable';
    vi.mocked(query, { partial: true }).mockImplementation(({ options }) => {
      expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(root);
      expect(options?.resume).toBeUndefined();
      expect(options?.forkSession).not.toBe(true);
      const id = options?.sessionId;
      expect([prior, fresh]).toContain(id);
      launches.push({ id: id!, options: options! });
      async function* sdk() {
        const native = claudeTranscriptPath(root, home, id!)!;
        await mkdir(path.dirname(native), { recursive: true });
        // Native output belongs to the external SDK edge, only after its actual launch options passed.
        await writeFile(
          native,
          JSON.stringify({
            type: 'user',
            uuid: randomUUID(),
            sessionId: id,
            cwd: home,
            message: { role: 'user', content: id === prior ? oldText : draft },
          }) + '\n'
        );
        yield {
          type: 'system',
          subtype: 'init',
          session_id: id,
          cwd: home,
          apiKeySource: 'oauth',
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          skills: [],
          plugins: [],
        } as unknown as SDKMessage;
        if (id === prior)
          yield {
            type: 'assistant',
            error: 'server_error',
            isApiErrorMessage: true,
            message: { role: 'assistant', content: [{ type: 'text', text: notice }] },
          } as unknown as SDKMessage;
        else {
          const context = {
            identity: {
              agentPath: home,
              displayName: 'Fixture',
              createdAt: new Date().toISOString(),
            },
            sessionId: id,
            retryChannel: 'mcp-argument' as const,
          };
          const gate = await options!.canUseTool!(
            'mcp__dorkos__post_to_room',
            { roomId: room.id, text: draft },
            {
              signal: new AbortController().signal,
              toolUseID: 'actual-fresh-post',
              requestId: 'actual-fresh-post',
              mcpServer: { name: 'dorkos', source: 'sdk' },
            }
          );
          expect(gate?.behavior).toBe('allow');
          await registry.invoke('rooms.read_history', { roomId: room.id }, context);
          await registry.invoke(
            'rooms.post',
            { roomId: room.id, text: draft, confirm: true },
            context
          );
        }
        if (id !== prior) {
          // A post effect is not completion. Use real main-thread SDK text/result shapes
          // so the production windower completes, rather than refusing an empty turn.
          for await (const frame of sdkSimpleText('Shared.', id))
            if (frame.type !== 'system') yield frame;
        } else
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            session_id: id,
            errors: [notice],
            is_error: true,
          } as unknown as SDKMessage;
      }
      return wrapSdkQuery(sdk());
    });
    const initialContext = buildRoomContext(
      {
        store: h.store,
        reactions: h.reactions,
        authors: h.authors,
        agents: agentLookupFor({ [home]: { name: 'fixture', displayName: 'Fixture' } }),
        isOwnerAuthor: (id) => id === h.human,
        bridgedFraming: () => null,
        topicNamesFor: () => new Map(),
        attachmentsFor: () => new Map(),
        canvasFor: () => null,
      },
      {
        room,
        agentAuthorId: authorId,
        cwd: home,
        entry,
        lastReadSeq: 0,
        working: [],
        budget: { room: null, global: null },
        repliesLeftInThisChain: null,
        engaged: null,
      }
    );
    await runInDispatch({ dispatchId: 'actual-prior-dispatch', origin: 'room', entryId }, () =>
      productionRunner.run({
        room,
        authorId,
        agentPath: home,
        cwd: home,
        additionalDirectories: [],
        worktree: null,
        sessionId: prior,
        entry,
        externalAuthor: false,
        carriedOutsider: true,
        permissionCeiling: { asks: 'always', reach: 'edit', outsider: true },
        roomContext: initialContext.context,
        attachmentProjection: initialContext.projection,
        prompt: oldText,
        onWaiting() {},
        onActivity() {},
        onSessionBound(id) {
          h.store.rebindRoomSession(room.id, authorId, id);
        },
      })
    );
    expect(
      latestClaudeRoomServerFailure(events.readLatestTurnStrict(prior), room.id)
    ).toMatchObject({ dispatchId: 'actual-prior-dispatch' });
    expect(runtime.readFailedSeatAuthority(prior)).toMatchObject({
      root,
      accountId: 'actual-account',
      inference: 'own-account',
      billing: 'subscription',
    });
    const oldNative = claudeTranscriptPath(root, home, prior)!;
    const original = await readFile(oldNative, 'utf8');
    const oldSettings = await runtimeRegistry.getSessionSettings(prior);
    const oldMarks = marksOf(prior, undefined);
    expect(oldMarks).toMatchObject({ outsider: true });
    expect(lastTurnLevelOf(prior)).toMatchObject({ asks: 'always', reach: 'read', outsider: true });
    const mover = new RoomSeatMover({
      recoveryCandidate: failedSeatCandidate,
      requiredLaunches: runtimeRegistry.requiredLaunches(),
      runtimeOf: async () => 'claude-code',
      newSeatRuntime: async () => 'claude-code',
      rebind: (r, a, s) => h.store.rebindRoomSession(r, a, s),
      settingsOf: (id) => runtimeRegistry.getSessionSettings(id),
      saveSettings: (id, s) => runtimeRegistry.saveSessionSettings(id, s),
      declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
      effectiveModeOf: async () => 'plan',
      ranking: async () => {
        throw new Error('No account failover');
      },
      accountOf: async () => {
        throw new Error('No preference fallback');
      },
      transcriptState: async () => 'present',
      summaryOf: async () => {
        throw new Error('No replay summary');
      },
      recordActivity() {},
      recordSeatMove: (id, r, a) => h.store.sessionLedger.recordSeatMove(id, r, a),
      newSessionId: () => fresh,
    });
    if (variant === 'paused')
      await pauses.pause('registered-agent', {
        accountId: 'fixture-owner',
        kind: 'person',
        name: 'Owner',
      });
    const candidate = await failedSeatCandidate({
      roomId: room.id,
      authorId,
      agentPath: home,
      sessionId: prior,
    });
    if (variant === 'paused') expect(candidate).toBeNull();
    else expect(candidate).not.toBeNull();
    await registry.invoke(
      'rooms.post',
      { roomId: room.id, text: draft },
      {
        identity: { agentPath: home, displayName: 'Fixture', createdAt: new Date().toISOString() },
        sessionId: 'actual-child',
        retryChannel: 'mcp-argument',
      }
    );
    await h.service.handoffs.idle();
    await h.service.triggersIdle();
    if (variant === 'paused') {
      expect(launches.map((x) => x.id)).toEqual([prior]);
      expect(h.store.getRoomSession(room.id, authorId)).toBe(prior);
      expect(db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(0);
      expect(await readFile(oldNative, 'utf8')).toBe(original);
      return;
    }
    expect(launches.map((x) => x.id)).toEqual([prior, fresh]);
    expect(h.store.getRoomSession(room.id, authorId)).toBe(fresh);
    expect(
      h.store
        .listEntries(room.id, { limit: 100 })
        .filter((x) => x.kind === 'post' && x.authorId === authorId)
    ).toHaveLength(1);
    expect(await readFile(oldNative, 'utf8')).toBe(original);
    expect(await runtimeRegistry.getSessionSettings(fresh)).toEqual(oldSettings);
    expect(marksOf(fresh, undefined)).toMatchObject(oldMarks);
    expect(runtimeRegistry.requiredLaunches().forSession(fresh)).toMatchObject({
      runtime: 'claude-code',
      root,
      inference: 'own-account',
      billing: 'subscription',
      state: 'settled',
    });
    expect(db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(1);
  }
);
