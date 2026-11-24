/**
 * DOR-4626 oracle. A room chat's turn fails with a server error, the server stops, and a new
 * server process opens the same SQLite file: a hand-off still recovers that chat once, from the
 * server's own durable record, carrying the failed turn's marks. Each "process" is a fresh module
 * graph (`vi.resetModules`) over the reopened file with a new real ClaudeCodeRuntime, RoomService,
 * production room runner and mover; only the external `SDK.query` is fake.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import type { Db } from '@dorkos/db';

interface Paths {
  scratch: string;
  home: string;
  root: string;
  dorkHome: string;
  databasePath: string;
}
interface Ids {
  roomId?: string;
  authorId?: string;
  prior: string;
  fresh: string;
}

/** Every live owner a booted process holds, drained before the next boots. */
let live: { stop(): Promise<void> } | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await live?.stop();
  live = undefined;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

const OLD_TEXT = 'Prior instruction never to replay.';
const DRAFT = 'The release is ready.';
const NOTICE = 'API Error: upstream unavailable';

/** What one booted process does differently. */
interface BootOptions {
  /** The recovery candidate check throws, as a storage fault between claim and move would. */
  candidateThrows?: boolean;
  /** Called each time the mover asks for a recovery candidate. */
  onCandidate?: () => void;
}

/** Boot one server process over the database file; nothing in memory survives from the last. */
async function boot(p: Paths, ids: Ids, options: BootOptions = {}) {
  vi.resetModules();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { sdkSimpleText, wrapSdkQuery } = await import('./sdk-scenarios.js');
  const db = await import('@dorkos/db');
  const { initBoundary } = await import('../../../../lib/boundary.js');
  const { ClaudeCodeRuntime } = await import('../claude-code-runtime.js');
  const { CLAUDE_CODE_CAPABILITIES } = await import('../runtime-constants.js');
  const { initConfigManager } = await import('../../../core/config-manager.js');
  const { runtimeRegistry } = await import('../../../core/runtime-registry.js');
  const { composeRegistry } = await import('../../../core/capabilities/index.js');
  const { initAgentIdentityService, resetAgentIdentityService } =
    await import('../../../core/agent-identity/agent-identity-service.js');
  const { registerTestHomes, clearTestHomes } =
    await import('../../../core/agent-identity/__tests__/agent-home-fixture.js');
  const turnLevels = await import('../../../core/turn-power/turn-levels.js');
  const { AccountUsageStore } = await import('../../../core/usage/account-usage-store.js');
  const { setAccountUsageStore } = await import('../../../core/usage/current-usage-store.js');
  const { initAccountSigninPolicy, accountSigninPolicy } =
    await import('../../../health/account-signin-policy.js');
  const { AgentPauseService, initAgentPause, resetAgentPause } =
    await import('../../../mesh/pause/agent-pause.js');
  const { createRoomHarness, agentLookupFor, roomVoice } =
    await import('../../../rooms/__tests__/room-test-harness.js');
  const { createSessionRoomTurnRunner } = await import('../../../rooms/room-turn-runner.js');
  const { setRoomService } = await import('../../../rooms/index.js');
  const { roomsDomain } = await import('../../../rooms/room-capabilities.js');
  const { RoomSeatMover } = await import('../../../rooms/reseat/seat-mover.js');
  const { failedSeatCandidate } = await import('../../../rooms/reseat/failed-seat-candidate.js');
  const { SessionEventStore } = await import('../../../session/session-event-store.js');
  const { setSessionEventStore, disposeProjector } =
    await import('../../../session/session-state-projector.js');
  const { setRoomSeatReports, disposeRoomSeatMessages } =
    await import('../../../session/chat-messages/chat-message-current.js');
  const { claudeTranscriptPath } = await import('../../../session/fleet/carry-over-summary.js');
  const { HandoffTerminalSource } =
    await import('../../../rooms/handoff/handoff-terminal-source.js');
  const { HandoffTerminalNotices } =
    await import('../../../rooms/handoff/handoff-terminal-notices.js');
  const { PrivateSessionMessageAcceptanceService } =
    await import('../../../session/private-messages/acceptance.js');
  const { MessageQueueStore } = await import('../../../session/message-queue-store.js');
  const { initPermissionGate, resetPermissionGate } =
    await import('../../../core/capabilities/permission-enforcement.js');
  const { buildRoomContext } = await import('../../../rooms/room-context.js');
  const { runInDispatch } = await import('../../../../lib/dispatch-context.js');

  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
  await initBoundary(p.scratch);
  const config = initConfigManager(p.dorkHome);
  config.setDot('runtimes.claudeCode.accounts', [
    { id: 'actual-account', label: 'Fixture', path: p.root },
  ]);
  config.setDot('runtimes.claudeCode.defaultAccount', 'actual-account');
  registerTestHomes([p.home]);
  initAccountSigninPolicy(p.dorkHome);
  accountSigninPolicy()!.seed([{ root: p.root, identity: null }], new Date());
  const usage = new AccountUsageStore({
    dorkHome: p.dorkHome,
    readConfig: async () => config.getAll(),
    resolveDefaultRoot: () => ({ path: p.root, warnings: [] }),
    timings: { scanIntervalMs: 3600000 },
  });
  await usage.load();
  usage.record('claude-code', { path: p.root }, [
    { key: 'five_hour', usedPct: 10, observedAt: new Date().toISOString(), source: 'sdk_event' },
  ]);
  setAccountUsageStore(usage);
  const database: Db = db.createDb(p.databasePath);
  db.runMigrations(database);
  runtimeRegistry.setDb(database);
  initAgentPause(new AgentPauseService({ db: database }));
  database
    .insert(db.agents)
    .values({
      id: 'registered-agent',
      name: 'fixture',
      runtime: 'claude-code',
      projectPath: p.home,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  const identities = initAgentIdentityService(database);
  if (!ids.roomId) await identities.mint({ agentPath: p.home, displayName: 'Fixture' });
  const events = new SessionEventStore(database);
  setSessionEventStore(events);
  const runtime: ClaudeCodeRuntime = new ClaudeCodeRuntime(p.dorkHome, p.home);
  runtimeRegistry.register(runtime);
  runtime.setSessionSettings(runtimeRegistry);
  const productionRunner = createSessionRoomTurnRunner({
    waitMs: () => 10000,
    ceilingMs: () => 15000,
  });
  const runner = Object.assign(productionRunner, { turns: [], interrupted: [] }, roomVoice());
  const h = createRoomHarness({
    db: database,
    agents: agentLookupFor({
      [p.home]: {
        id: 'registered-agent',
        name: 'fixture',
        displayName: 'Fixture',
        responseMode: 'mention-only',
      },
    }),
    runner,
    turnLimitsEnabled: true,
    maxAutomaticTurnsTotalPerHour: 100,
    seatMover: () => mover,
  });
  setRoomService(h.service);
  const registry = composeRegistry([roomsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms: h.service },
  });
  const terminalSource = new HandoffTerminalSource(database, h.store.handoffOutbox);
  const acceptance = new PrivateSessionMessageAcceptanceService(
    database,
    new MessageQueueStore(database),
    [terminalSource],
    'restart-oracle'
  );
  const notices = new HandoffTerminalNotices(
    h.store.handoffOutbox,
    terminalSource,
    acceptance,
    () => {}
  );
  h.service.handoffs.initializeDurable(() => notices.flush());
  const mover: InstanceType<typeof RoomSeatMover> = new RoomSeatMover({
    recoveryCandidate: async (seat) => {
      options.onCandidate?.();
      if (options.candidateThrows) throw new Error('fixture fault between claim and move');
      return failedSeatCandidate(seat);
    },
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
    transcriptState: async (seat) => {
      const transcript = seat.sessionId
        ? claudeTranscriptPath(p.root, p.home, seat.sessionId)
        : null;
      if (!transcript) return 'unknown';
      try {
        return (await stat(transcript)).isFile() ? 'present' : 'missing';
      } catch {
        return 'unknown';
      }
    },
    summaryOf: async () => {
      throw new Error('No replay summary');
    },
    recordActivity() {},
    recordSeatMove: (id, r, a) => h.store.sessionLedger.recordSeatMove(id, r, a),
    newSessionId: () => ids.fresh,
  });

  const launches: Array<{ id: string; options: Options }> = [];
  const children = new Set<string>();
  const quiet = new Set<string>();
  /** How each of the seat's own turns ends, in order; a failure when none is queued. */
  const priorOutcomes: Array<'fail' | 'ok'> = [];
  let priorRuns = 0;
  vi.mocked(query, { partial: true }).mockImplementation(({ options }) => {
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(p.root);
    // Only the seat's own repeated turns resume; every other chat launches fresh.
    const id = (options!.sessionId ?? options!.resume)!;
    if (id !== ids.prior) expect(options?.resume).toBeUndefined();
    launches.push({ id, options: options! });
    async function* sdk() {
      const native = claudeTranscriptPath(p.root, p.home, id)!;
      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(
        native,
        JSON.stringify({
          type: 'user',
          uuid: randomUUID(),
          sessionId: id,
          cwd: p.home,
          message: { role: 'user', content: id === ids.prior ? OLD_TEXT : DRAFT },
        }) + '\n'
      );
      yield {
        type: 'system',
        subtype: 'init',
        session_id: id,
        cwd: p.home,
        apiKeySource: 'oauth',
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        skills: [],
        plugins: [],
      } as unknown as SDKMessage;
      const outcome = id === ids.prior ? (priorOutcomes.shift() ?? 'fail') : undefined;
      if (outcome === 'ok' || quiet.has(id)) {
        for await (const frame of sdkSimpleText('Done.', id))
          if (frame.type !== 'system') yield frame;
        return;
      }
      if (outcome === 'fail') {
        yield {
          type: 'assistant',
          error: 'server_error',
          isApiErrorMessage: true,
          message: { role: 'assistant', content: [{ type: 'text', text: NOTICE }] },
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: id,
          errors: [NOTICE],
          is_error: true,
        } as unknown as SDKMessage;
        return;
      }
      const context = {
        identity: {
          agentPath: p.home,
          displayName: 'Fixture',
          createdAt: new Date().toISOString(),
        },
        sessionId: id,
        retryChannel: 'mcp-argument' as const,
      };
      const gate = await options!.canUseTool!(
        'mcp__dorkos__post_to_room',
        { roomId: ids.roomId!, text: DRAFT },
        {
          signal: new AbortController().signal,
          toolUseID: `post-${id}`,
          requestId: `post-${id}`,
          mcpServer: { name: 'dorkos', source: 'sdk' },
        }
      );
      expect(gate?.behavior).toBe('allow');
      if (children.has(id)) {
        const result = (await registry.invoke(
          'rooms.post',
          { roomId: ids.roomId!, text: DRAFT },
          context
        )) as { handedOff: boolean };
        expect(result.handedOff).toBe(true);
      } else {
        await registry.invoke('rooms.read_history', { roomId: ids.roomId! }, context);
        await registry.invoke(
          'rooms.post',
          { roomId: ids.roomId!, text: DRAFT, confirm: true },
          context
        );
      }
      for await (const frame of sdkSimpleText('Shared.', id))
        if (frame.type !== 'system') yield frame;
    }
    return wrapSdkQuery(sdk());
  });

  const owned = new Set<string>([ids.prior, ids.fresh]);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    h.service.dispose();
    usage.stop();
    await runtime.endSessionsWhere(() => true);
    await h.service.handoffs.idle();
    await h.service.triggersIdle();
    await runtime.endSessionsWhere(() => true);
    await usage.flush();
    for (const id of owned) disposeProjector(id);
    disposeRoomSeatMessages();
    setRoomSeatReports(undefined);
    setAccountUsageStore(undefined);
    setSessionEventStore(undefined);
    resetAgentPause();
    resetAgentIdentityService();
    clearTestHomes();
    resetPermissionGate();
    if (database.$client.open) database.$client.close();
  };
  live = { stop };

  /** A person's chat asks its agent to share a draft: an admitted hand-off to the room seat. */
  const handOff = async () => {
    const child = randomUUID();
    owned.add(child);
    children.add(child);
    await runtimeRegistry.persistSessionRuntime(
      child,
      'claude-code',
      { kind: 'interactive' },
      p.home
    );
    await runtimeRegistry.saveSessionSettings(child, { permissionMode: 'plan', fastMode: false });
    const childRuntime = await runtimeRegistry.resolveForSession(child);
    for await (const event of childRuntime.sendMessage(child, 'Share the approved draft', {
      cwd: p.home,
      accountHint: 'actual-account',
      forAgent: p.home,
    }))
      void event;
    await h.service.handoffs.idle();
    await h.service.triggersIdle();
  };

  /** A plain person's chat turn that says a line and posts nothing. */
  const quietTurn = async () => {
    const chat = randomUUID();
    owned.add(chat);
    quiet.add(chat);
    await runtimeRegistry.persistSessionRuntime(
      chat,
      'claude-code',
      { kind: 'interactive' },
      p.home
    );
    await runtimeRegistry.saveSessionSettings(chat, { permissionMode: 'plan', fastMode: false });
    const chatRuntime = await runtimeRegistry.resolveForSession(chat);
    for await (const event of chatRuntime.sendMessage(chat, 'Hello', {
      cwd: p.home,
      accountHint: 'actual-account',
      forAgent: p.home,
    }))
      void event;
    return chat;
  };

  /** One of the seat's own room turns, through the production runner; the first creates the room. */
  const failPriorTurn = async (outcome: 'fail' | 'ok' = 'fail') => {
    if (!ids.roomId) {
      const created = h.service.createRoom(
        { kind: 'channel', title: 'Restart recovery', members: [], agentPaths: [p.home] },
        h.human
      );
      ids.roomId = created.id;
      ids.authorId = h.authors.resolveAgent(p.home, 'Fixture').id;
      h.store.bindRoomSession(created.id, ids.authorId, ids.prior, new Date().toISOString());
      await runtimeRegistry.saveSessionSettings(ids.prior, {
        permissionMode: 'plan',
        fastMode: false,
      });
    }
    const room = h.store.getRoom(ids.roomId)!;
    priorOutcomes.push(outcome);
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
    const context = buildRoomContext(
      {
        store: h.store,
        reactions: h.reactions,
        authors: h.authors,
        agents: agentLookupFor({ [p.home]: { name: 'fixture', displayName: 'Fixture' } }),
        isOwnerAuthor: (id) => id === h.human,
        bridgedFraming: () => null,
        topicNamesFor: () => new Map(),
        attachmentsFor: () => new Map(),
        canvasFor: () => null,
      },
      {
        room,
        agentAuthorId: ids.authorId!,
        cwd: p.home,
        entry,
        lastReadSeq: 0,
        working: [],
        budget: { room: null, global: null },
        repliesLeftInThisChain: null,
        engaged: null,
      }
    );
    const dispatchId = `restart-prior-dispatch-${priorRuns++}`;
    await runInDispatch({ dispatchId, origin: 'room', entryId }, () =>
      productionRunner.run({
        room,
        authorId: ids.authorId!,
        agentPath: p.home,
        cwd: p.home,
        additionalDirectories: [],
        worktree: null,
        sessionId: ids.prior,
        entry,
        externalAuthor: false,
        carriedOutsider: true,
        permissionCeiling: { asks: 'always', reach: 'edit', outsider: true },
        roomContext: context.context,
        attachmentProjection: context.projection,
        prompt: OLD_TEXT,
        onWaiting() {},
        onActivity() {},
        onSessionBound(id) {
          h.store.rebindRoomSession(room.id, ids.authorId!, id);
        },
      })
    );
  };

  const seat = () => ({
    roomId: ids.roomId!,
    authorId: ids.authorId!,
    agentPath: p.home,
    sessionId: ids.prior,
  });
  return {
    database,
    db,
    h,
    runtime,
    turnLevels,
    launches,
    handOff,
    quietTurn,
    failPriorTurn,
    stop,
    candidate: () => failedSeatCandidate(seat()),
    /** Take the account's usage away, as before the first read after boot, or give it back. */
    usageRead: (read: boolean) => setAccountUsageStore(read ? usage : undefined),
    nativeOf: (id: string) => claudeTranscriptPath(p.root, p.home, id)!,
    requiredLaunches: () => runtimeRegistry.requiredLaunches(),
  };
}

async function paths(): Promise<Paths> {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), '4626-restart-')));
  const home = path.join(scratch, 'agent');
  const root = path.join(scratch, 'account');
  const dorkHome = path.join(scratch, 'dork');
  const osHome = path.join(dorkHome, 'os-home');
  const env = {
    HOME: osHome,
    USERPROFILE: osHome,
    DORK_HOME: dorkHome,
    CLAUDE_CONFIG_DIR: root,
    CODEX_HOME: path.join(osHome, '.codex'),
    XDG_CONFIG_HOME: path.join(osHome, 'config'),
    XDG_DATA_HOME: path.join(osHome, 'data'),
    XDG_CACHE_HOME: path.join(osHome, 'cache'),
    XDG_STATE_HOME: path.join(osHome, 'state'),
    XDG_RUNTIME_DIR: path.join(osHome, 'run'),
    APPDATA: path.join(osHome, 'appdata'),
    LOCALAPPDATA: path.join(osHome, 'local-appdata'),
    OPENCODE_CONFIG_DIR: path.join(osHome, 'config', 'opencode'),
  };
  await Promise.all(
    [home, root, dorkHome, ...Object.values(env)].map((dir) => mkdir(dir, { recursive: true }))
  );
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubEnv('OPENCODE_DB', path.join(env.XDG_DATA_HOME, 'opencode', 'owned.sqlite'));
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    vi.stubEnv(name, '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Network forbidden in the restart oracle');
    })
  );
  for (const accountRoot of [root, path.join(osHome, '.claude')])
    await mkdir(path.join(accountRoot, 'projects'), { recursive: true });
  await writeFile(
    path.join(root, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: randomUUID(), organizationUuid: randomUUID() } })
  );
  return { scratch, home, root, dorkHome, databasePath: path.join(dorkHome, 'restart.sqlite') };
}

it('recovers a failed room chat once after a restart, carrying its marks, and never again', async () => {
  const p = await paths();
  const ids: Ids = { prior: randomUUID(), fresh: randomUUID() };

  // First process: the seat's room turn fails with a server error.
  const first = await boot(p, ids);
  await first.failPriorTurn();
  expect(first.runtime.readFailedSeatAuthority(ids.prior)).toMatchObject({
    dispatchId: 'restart-prior-dispatch-0',
    root: p.root,
    accountId: 'actual-account',
  });
  const failedLevel = first.turnLevels.lastTurnLevelOf(ids.prior);
  const failedMarks = first.turnLevels.marksOf(ids.prior, undefined);
  expect(failedLevel).toMatchObject({ asks: 'always', reach: 'read', outsider: true });
  expect(failedMarks).toMatchObject({ outsider: true });
  // Its own process never reads the durable record: once its process is gone, live memory alone
  // still decides, exactly as before (no in-process loosening).
  await first.runtime.endSessionsWhere(() => true);
  expect(first.runtime.readFailedSeatAuthority(ids.prior)).toBeNull();
  const original = await readFile(first.nativeOf(ids.prior), 'utf8');
  await first.stop();

  // Second process over the reopened file: memory holds nothing about the failed turn.
  const second = await boot(p, ids);
  expect(second.turnLevels.lastTurnLevelOf(ids.prior)).toBeUndefined();
  expect(second.runtime.readFailedSeatAuthority(ids.prior)).toMatchObject({
    dispatchId: 'restart-prior-dispatch-0',
    root: p.root,
    accountId: 'actual-account',
    inference: 'own-account',
    billing: 'subscription',
    restored: true,
  });
  // Outside an attempt that spent the record, a restored authority stands for nothing.
  expect(await second.candidate()).toBeNull();
  await second.handOff();
  expect(second.launches.map((launch) => launch.id)).toEqual([
    expect.any(String), // the person's chat that handed off
    ids.fresh,
  ]);
  expect(second.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.fresh);
  expect(
    second.h.store
      .listEntries(ids.roomId!, { limit: 100 })
      .filter((entry) => entry.kind === 'post' && entry.authorId === ids.authorId)
  ).toHaveLength(1);
  // M4: the recovered turn carries no less than the failed one held, and no looser a level.
  expect(second.turnLevels.marksOf(ids.fresh, undefined)).toMatchObject(failedMarks);
  expect(second.turnLevels.lastTurnLevelOf(ids.fresh)).toMatchObject({
    asks: 'always',
    reach: 'read',
    outsider: true,
  });
  expect(second.requiredLaunches().forSession(ids.fresh)).toMatchObject({
    root: p.root,
    inference: 'own-account',
    billing: 'subscription',
    state: 'settled',
  });
  expect(await readFile(second.nativeOf(ids.prior), 'utf8')).toBe(original);
  const spent = second.database
    .select()
    .from(second.db.roomSeatFailures)
    .where(second.db.eq(second.db.roomSeatFailures.sessionId, ids.prior))
    .get();
  expect(spent?.consumedAt).toEqual(expect.any(Number));
  // No credential is ever written: the record names the account folder and bill only.
  expect(spent?.payload).not.toMatch(/token|key|secret|password/i);
  await second.stop();

  // Third process: the spent record grants nothing, however the chat is asked about.
  const third = await boot(p, ids);
  expect(third.runtime.readFailedSeatAuthority(ids.prior)).toBeNull();
  expect(await third.candidate()).toBeNull();
  await third.stop();
}, 60000);

/** A restarted process's view of the failed chat's durable row. */
function rowOf(b: Awaited<ReturnType<typeof boot>>, sessionId: string) {
  return b.database
    .select()
    .from(b.db.roomSeatFailures)
    .where(b.db.eq(b.db.roomSeatFailures.sessionId, sessionId))
    .get();
}

it('keeps the failed turn’s marks when the new process already holds a level for the old chat', async () => {
  const p = await paths();
  const ids: Ids = { prior: randomUUID(), fresh: randomUUID() };
  const first = await boot(p, ids);
  await first.failPriorTurn();
  const failedMarks = first.turnLevels.marksOf(ids.prior, undefined);
  expect(failedMarks).toMatchObject({ outsider: true });
  await first.stop();

  const second = await boot(p, ids);
  // A level for the old chat with no durable turn behind it: a clean chat's turn carried onto
  // the old id, as a runtime rename does. It must not stand in for the failed turn's record.
  const clean = await second.quietTurn();
  second.turnLevels.aliasTurnLevel(clean, ids.prior);
  expect(second.turnLevels.lastTurnLevelOf(ids.prior)).toBeDefined();
  expect(second.turnLevels.marksOf(ids.prior, undefined).outsider).toBeUndefined();
  await second.handOff();
  expect(second.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.fresh);
  expect(second.turnLevels.marksOf(ids.fresh, undefined)).toMatchObject(failedMarks);
  expect(rowOf(second, ids.prior)?.consumedAt).toEqual(expect.any(Number));
  await second.stop();
}, 60000);

it('spends the record before the move, so a fault in between never grants another try', async () => {
  const p = await paths();
  const ids: Ids = { prior: randomUUID(), fresh: randomUUID() };
  const first = await boot(p, ids);
  await first.failPriorTurn();
  await first.stop();

  const second = await boot(p, ids, { candidateThrows: true });
  await second.handOff();
  expect(second.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.prior);
  expect(rowOf(second, ids.prior)?.consumedAt).toEqual(expect.any(Number));
  await second.stop();

  const third = await boot(p, ids);
  expect(third.runtime.readFailedSeatAuthority(ids.prior)).toBeNull();
  await third.handOff();
  expect(third.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.prior);
  await third.stop();
}, 60000);

it('refuses a record whose chat later finished a turn, even though the row was never spent', async () => {
  const p = await paths();
  const ids: Ids = { prior: randomUUID(), fresh: randomUUID() };
  const first = await boot(p, ids);
  await first.failPriorTurn();
  await first.stop();

  // A later process runs the chat once more, and that turn finishes; it writes no record.
  const second = await boot(p, ids);
  await second.failPriorTurn('ok');
  await second.stop();

  const third = await boot(p, ids);
  expect(rowOf(third, ids.prior)?.consumedAt).toBeNull();
  expect(third.runtime.readFailedSeatAuthority(ids.prior)).toMatchObject({ restored: true });
  await third.handOff();
  expect(third.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.prior);
  expect(third.launches.map((launch) => launch.id)).not.toContain(ids.fresh);
  await third.stop();
}, 60000);

it('never lets a restart unlock a chat its own process refused for a crash loop', async () => {
  const p = await paths();
  const ids: Ids = { prior: randomUUID(), fresh: randomUUID() };
  const first = await boot(p, ids);
  // Each fixture turn ends its process without a completed turn, so two failures in a row are
  // two crashes in a row: the crash policy now refuses the chat.
  await first.failPriorTurn();
  await first.failPriorTurn();
  expect(first.runtime.readFailedSeatAuthority(ids.prior)).toBeNull();
  await first.stop();

  const second = await boot(p, ids);
  expect(second.runtime.readFailedSeatAuthority(ids.prior)).toBeNull();
  await second.handOff();
  expect(second.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.prior);
  await second.stop();
}, 60000);

it('waits for the account’s usage before spending the record', async () => {
  const p = await paths();
  const ids: Ids = { prior: randomUUID(), fresh: randomUUID() };
  const first = await boot(p, ids);
  await first.failPriorTurn();
  await first.stop();

  // Usage not read yet since boot: the record is not spent and no candidate is even asked for.
  const asked: Array<number | null | undefined> = [];
  const second = await boot(p, ids, {
    onCandidate: () => asked.push(rowOf(second, ids.prior)?.consumedAt),
  });
  second.usageRead(false);
  await second.handOff();
  expect(asked).toEqual([]);
  expect(rowOf(second, ids.prior)?.consumedAt).toBeNull();
  expect(second.h.store.getRoomSession(ids.roomId!, ids.authorId!)).toBe(ids.prior);
  await second.stop();
}, 60000);
