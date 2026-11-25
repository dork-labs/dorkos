/** Real recorded child -> Registry -> durable RoomService -> production runner/Claude pump/required mover. Only external SDK.query is fake. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { ScriptedTurnRunner } from '../../../rooms/__tests__/room-test-harness.js';
import type { CapabilityRegistry } from '../../../core/capabilities/index.js';
import type { Db } from '@dorkos/db';
let cleanup: (() => void) | undefined;
let service: import('../../../rooms/room-service.js').RoomService | undefined;
let ownedDb: Db | undefined;
let scratch: string | undefined;
let runtime: ClaudeCodeRuntime | undefined;
let usage: AccountUsageStore | undefined;
let releaseHeldCandidate: (() => void) | undefined;
let environmentBefore: Record<string, string | undefined> | undefined;
const ownedRuntimes: ClaudeCodeRuntime[] = [];
const ownedTurns: Promise<void>[] = [];
const fixtureSessionIds: string[] = [];
afterEach(async () => {
  let ownersDrained = false;
  try {
    // Seal admission and future callbacks before releasing held fixture work.
    service?.dispose();
    usage?.stop();
    releaseHeldCandidate?.();
    await Promise.all(ownedRuntimes.map((owned) => owned.endSessionsWhere(() => true)));
    await Promise.allSettled(ownedTurns);
    await service?.handoffs.idle();
    await service?.triggersIdle();
    // The released child may have reached its final runtime continuation while draining.
    await Promise.all(ownedRuntimes.map((owned) => owned.endSessionsWhere(() => true)));
    for (const owned of ownedRuntimes) {
      for (const sessionId of fixtureSessionIds) {
        expect(owned.isTurnOpen(sessionId)).toBe(false);
        expect(owned.getSessionWarmth(sessionId)).toBe('cold');
      }
    }
    cleanup?.();
    await usage?.flush();
    ownersDrained = true;
  } finally {
    // A failed drain keeps the isolated environment and scratch alive. Never let
    // a surviving callback regain the operator's home through an eager restore.
    if (ownersDrained) {
      try {
        cleanup = undefined;
        service = undefined;
        runtime = undefined;
        usage = undefined;
        releaseHeldCandidate = undefined;
        ownedRuntimes.length = 0;
        ownedTurns.length = 0;
        fixtureSessionIds.length = 0;
        vi.resetModules();
        if (ownedDb?.$client.open) ownedDb.$client.close();
        ownedDb = undefined;
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        // Vitest restores credential stubs too; the explicit snapshot contains
        // only fixture path variables, never the operator's credential values.
        vi.unstubAllEnvs();
        if (environmentBefore) {
          for (const [name, value] of Object.entries(environmentBefore)) {
            expect(process.env[name]).toBe(value);
          }
        }
        environmentBefore = undefined;
        if (scratch) await rm(scratch, { recursive: true, force: true });
        scratch = undefined;
      }
    }
  }
});
it.each(['eligible', 'paused', 'rejoined', 'independent-reseat'] as const)(
  'handles %s actual Claude recovery with strict SDK options, history and constraints',
  async (variant) => {
    if (environmentBefore !== undefined) {
      throw new Error(
        'The previous fixture did not drain; its isolated environment must remain sealed.'
      );
    }
    vi.resetModules();
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), '4328-production-room-')));

    const home = path.join(scratch, 'agent');
    const root = path.join(scratch, 'account');
    const dorkHome = path.join(scratch, 'dork');
    const osHome = path.join(dorkHome, 'os-home');
    const ownedEnvironment = {
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
    environmentBefore = Object.fromEntries(
      Object.keys(ownedEnvironment).map((name) => [name, process.env[name]])
    );
    await Promise.all(
      [home, root, dorkHome, ...Object.values(ownedEnvironment)].map((dir) =>
        mkdir(dir, { recursive: true })
      )
    );
    // Worker-local fixture overrides precede EVERY app/runtime value import.
    for (const [name, value] of Object.entries(ownedEnvironment)) vi.stubEnv(name, value);
    vi.stubEnv(
      'OPENCODE_DB',
      path.join(ownedEnvironment.XDG_DATA_HOME, 'opencode', 'owned.sqlite')
    );
    const assertOwned = async (dir: string): Promise<void> => {
      const canonical = await realpath(dir);
      const inside = path.relative(scratch!, canonical);
      expect(inside).not.toBe('..');
      expect(inside.startsWith(`..${path.sep}`)).toBe(false);
      expect(path.isAbsolute(inside)).toBe(false);
    };
    expect(await realpath(os.homedir())).toBe(osHome);
    await assertOwned(os.homedir());
    // All real root-set branches qualify; an empty/narrowed answer cannot pass.
    const defaultRoot = path.join(osHome, '.claude');
    const creditsRoot = path.join(dorkHome, 'runtimes', 'claude-code', 'credits');
    await Promise.all(
      [root, defaultRoot, creditsRoot].map((accountRoot) =>
        mkdir(path.join(accountRoot, 'projects'), { recursive: true })
      )
    );
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
      vi.stubEnv(name, '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network forbidden in production room oracle');
      })
    );
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { sdkSimpleText, wrapSdkQuery } = await import('./sdk-scenarios.js');

    const { agents, roomSeatLaunchRequirements } = await import('@dorkos/db');
    const { initBoundary } = await import('../../../../lib/boundary.js');
    const { runInDispatch } = await import('../../../../lib/dispatch-context.js');
    const { ClaudeCodeRuntime } = await import('../claude-code-runtime.js');
    const { CLAUDE_CODE_CAPABILITIES } = await import('../runtime-constants.js');
    const { initConfigManager } = await import('../../../core/config-manager.js');
    const { runtimeRegistry } = await import('../../../core/runtime-registry.js');
    const { composeRegistry } = await import('../../../core/capabilities/index.js');
    const { initAgentIdentityService, resetAgentIdentityService } =
      await import('../../../core/agent-identity/agent-identity-service.js');
    const { registerTestHomes, clearTestHomes } =
      await import('../../../core/agent-identity/__tests__/agent-home-fixture.js');
    const { lastTurnLevelOf, marksOf } = await import('../../../core/turn-power/turn-levels.js');
    const { AccountUsageStore } = await import('../../../core/usage/account-usage-store.js');
    const { setAccountUsageStore } = await import('../../../core/usage/current-usage-store.js');
    const { initAccountSigninPolicy, accountSigninPolicy } =
      await import('../../../health/account-signin-policy.js');
    const { AgentPauseService, initAgentPause, resetAgentPause } =
      await import('../../../mesh/pause/agent-pause.js');
    const { createRoomHarness, agentLookupFor, roomVoice } =
      await import('../../../rooms/__tests__/room-test-harness.js');
    const { buildRoomContext } = await import('../../../rooms/room-context.js');
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
    const { latestClaudeRoomServerFailure } =
      await import('../../../session/history/latest-room-failure.js');
    const { claudeTranscriptPath } = await import('../sessions/project-slug.js');
    // What the server's startup registers (DOR-4928), in this fresh module graph.
    (await import('../../../../startup/register-claude-code-facts.js')).registerClaudeCodeFacts();
    const { HandoffTerminalSource } =
      await import('../../../rooms/handoff/handoff-terminal-source.js');
    const { HandoffTerminalNotices } =
      await import('../../../rooms/handoff/handoff-terminal-notices.js');
    const { PrivateSessionMessageAcceptanceService } =
      await import('../../../session/private-messages/acceptance.js');
    const { MessageQueueStore } = await import('../../../session/message-queue-store.js');
    const { initPermissionGate, resetPermissionGate } =
      await import('../../../core/capabilities/permission-enforcement.js');
    const { roomTurnSpend, roomMembers, createDb, runMigrations, eq, and } =
      await import('@dorkos/db');
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    cleanup = () => {
      for (const sessionId of fixtureSessionIds) disposeProjector(sessionId);
      disposeRoomSeatMessages();
      setRoomSeatReports(undefined);
      setAccountUsageStore(undefined);
      setSessionEventStore(undefined);
      resetAgentPause();
      resetAgentIdentityService();
      clearTestHomes();
      resetPermissionGate();
    };
    await initBoundary(scratch);

    const config = initConfigManager(dorkHome);
    config.setDot('runtimes.claudeCode.accounts', [
      { id: 'actual-account', label: 'Fixture', path: root },
    ]);
    config.setDot('runtimes.claudeCode.defaultAccount', 'actual-account');
    const { resolveClaudeRootSet } = await import('../claude-config-dir.js');
    const { creditsClaudeRoot } = await import('../credits-root.js');
    const { resolveDorkHome } = await import('../../../../lib/dork-home.js');
    const actualRoots = resolveClaudeRootSet();
    expect(actualRoots).toEqual(expect.arrayContaining([root, defaultRoot, creditsRoot]));
    for (const dir of [
      ...actualRoots,
      resolveDorkHome(),
      creditsClaudeRoot(),
      home,
      ...Object.values(ownedEnvironment),
    ])
      await assertOwned(dir);
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
    const databasePath = path.join(dorkHome, 'oracle.sqlite');
    const db = createDb(databasePath);
    runMigrations(db);
    ownedDb = db;
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
    ownedRuntimes.push(runtime);
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
        [home]: {
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
    service = h.service;
    const room = h.service.createRoom(
      { kind: 'channel', title: 'Actual recovery', members: [], agentPaths: [home] },
      h.human
    );
    const authorId = h.authors.resolveAgent(home, 'Fixture').id;
    const prior = randomUUID();
    const fresh = randomUUID();
    const child = randomUUID();
    fixtureSessionIds.push(prior, fresh, child);
    let handoffId: string | undefined;
    let admittedEnvelope: string | undefined;
    let candidateHeld = false;
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    releaseHeldCandidate = () => releaseCandidate();
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
    const terminalSource = new HandoffTerminalSource(db, h.store.handoffOutbox);
    const acceptance = new PrivateSessionMessageAcceptanceService(
      db,
      new MessageQueueStore(db),
      [terminalSource],
      'actual-runtime-oracle'
    );
    const notices = new HandoffTerminalNotices(
      h.store.handoffOutbox,
      terminalSource,
      acceptance,
      () => {}
    );
    h.service.handoffs.initializeDurable(() => notices.flush());
    const launches: Array<{ id: string; options: Options }> = [];
    const oldText = 'Prior instruction never to replay.';
    const draft = 'The release is ready.';
    const notice = 'API Error: upstream unavailable';
    vi.mocked(query, { partial: true }).mockImplementation(({ options }) => {
      expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(root);
      expect(options?.resume).toBeUndefined();
      expect(options?.forkSession).not.toBe(true);
      const id = options?.sessionId;
      expect([prior, child, fresh]).toContain(id);
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
          if (id === child) {
            const result = (await registry.invoke(
              'rooms.post',
              { roomId: room.id, text: draft },
              context
            )) as { handedOff: boolean; handoffId: string };
            expect(result.handedOff).toBe(true);
            handoffId = result.handoffId;
            const row = h.store.handoffOutbox.readOwned(handoffId, authorId)!;
            expect(row).toBeDefined();
            admittedEnvelope = row.envelopeJson;
            expect(JSON.parse(admittedEnvelope).source.callerSessionId).toBe(child);
            expect(JSON.parse(admittedEnvelope).carry.outsideWords).toBe(true);
          } else {
            await registry.invoke('rooms.read_history', { roomId: room.id }, context);
            await registry.invoke(
              'rooms.post',
              { roomId: room.id, text: draft, confirm: true },
              context
            );
          }
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
      recoveryCandidate: async (seat) => {
        const candidate = await failedSeatCandidate(seat);
        if (variant === 'paused' || variant === 'rejoined' || variant === 'independent-reseat') {
          expect(candidate).not.toBeNull();
          candidateHeld = true;
          await candidateGate;
        }
        return candidate;
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
        const transcript = seat.sessionId ? claudeTranscriptPath(root, home, seat.sessionId) : null;
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
      newSessionId: () => fresh,
    });
    const candidate = await failedSeatCandidate({
      roomId: room.id,
      authorId,
      agentPath: home,
      sessionId: prior,
    });
    expect(candidate).not.toBeNull();
    // Actual interactive child uses the same registered runtime/owner, not a forged recorder fixture.
    // Seed its positive server metadata through the production binding port before its real SDK turn.
    await runtimeRegistry.persistSessionRuntime(
      child,
      'claude-code',
      { kind: 'interactive' },
      home
    );
    await runtimeRegistry.saveSessionSettings(child, { permissionMode: 'plan', fastMode: false });
    const childRuntime = await runtimeRegistry.resolveForSession(child);
    const childTurn = (async () => {
      for await (const event of childRuntime.sendMessage(child, 'Share the approved draft', {
        cwd: home,
        accountHint: 'actual-account',
        forAgent: home,
      }))
        void event;
    })();
    ownedTurns.push(childTurn);
    void childTurn.catch(() => undefined); // Observe immediately; the actual case still awaits and asserts it.
    if (variant === 'paused' || variant === 'rejoined' || variant === 'independent-reseat') {
      try {
        await vi.waitFor(() => expect(candidateHeld).toBe(true), { timeout: 5000 });
        if (variant === 'paused') {
          await pauses.pause('registered-agent', {
            accountId: 'fixture-owner',
            kind: 'person',
            name: 'Owner',
          });
        } else if (variant === 'rejoined') {
          // Real roster generation changes while the original binding/claim remains: isolates admitted-generation guard.
          const member = db
            .select()
            .from(roomMembers)
            .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.authorId, authorId)))
            .get()!;
          db.delete(roomMembers)
            .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.authorId, authorId)))
            .run();
          db.insert(roomMembers)
            .values({
              ...member,
              joinedAt: new Date(Date.parse(member.joinedAt) + 1).toISOString(),
            })
            .run();
        } else {
          // Independent real seat move: same author/room is not native conversation identity.
          h.store.sessionLedger.recordSeatMove(prior, room.id, authorId);
          h.store.rebindRoomSession(room.id, authorId, 'independent-successor');
        }
      } finally {
        releaseCandidate();
      }
    }
    await childTurn;
    await h.service.handoffs.idle();
    await h.service.triggersIdle();
    expect(handoffId).toEqual(expect.any(String));
    const durable = h.store.handoffOutbox.readOwned(handoffId!, authorId)!;
    expect(durable.envelopeJson).toBe(admittedEnvelope);
    expect(JSON.parse(durable.envelopeJson).seat.sessionId).toBe(prior);
    expect(durable.waitDeadlineAt - durable.enqueuedAt).toBe(60 * 60 * 1000);
    if (variant !== 'eligible') {
      expect(launches.map((x) => x.id)).toEqual([prior, child]);
      expect(h.store.getRoomSession(room.id, authorId)).toBe(
        variant === 'independent-reseat' ? 'independent-successor' : prior
      );
      expect(durable.state).toBe('declined');
      expect(db.select().from(roomTurnSpend).all()).toHaveLength(0);
      expect(db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(0);
      expect(await readFile(oldNative, 'utf8')).toBe(original);
      return;
    }
    expect(launches.map((x) => x.id)).toEqual([prior, child, fresh]);
    expect(durable.state).toBe('posted');
    expect(db.select().from(roomTurnSpend).all()).toHaveLength(1);
    const deadline = durable.waitDeadlineAt;
    h.service.handoffs.flushTerminals();
    expect(h.store.handoffOutbox.readOwned(handoffId!, authorId)?.waitDeadlineAt).toBe(deadline);
    expect(db.select().from(roomTurnSpend).all()).toHaveLength(1);
    expect(h.store.getRoomSession(room.id, authorId)).toBe(fresh);
    expect(h.store.sessionLedger.bindingForSession(prior)).toBeUndefined();
    expect(h.store.sessionLedger.seatMovedFrom(prior)).toMatchObject({ roomId: room.id, authorId });
    expect(h.store.sessionLedger.bindingForSession(fresh)).toMatchObject({
      roomId: room.id,
      authorId,
      sessionId: fresh,
    });
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
    // Retire the actual runtime and reopen the actual SQLite file: the settled
    // destination requirement remains launch authority, independently of live objects.
    const requiredBefore = runtimeRegistry.requiredLaunches().forSession(fresh)!;
    h.service.dispose();
    await h.service.handoffs.idle();
    await h.service.triggersIdle();
    service = undefined;
    await runtime.endSessionsWhere(() => true);
    db.$client.close();
    ownedDb = undefined;
    const reopened = createDb(databasePath);
    runMigrations(reopened);
    ownedDb = reopened;
    runtimeRegistry.setDb(reopened);
    initAgentPause(new AgentPauseService({ db: reopened }));
    setSessionEventStore(new SessionEventStore(reopened));
    const { HandoffOutboxStore } =
      await import('../../../rooms/handoff/outbox/handoff-outbox-store.js');
    const reopenedSource = new HandoffOutboxStore(reopened);
    expect(reopenedSource.readOwned(handoffId!, authorId)).toMatchObject({
      state: 'posted',
      envelopeJson: admittedEnvelope,
      waitDeadlineAt: deadline,
    });
    expect(runtimeRegistry.requiredLaunches().forSession(fresh)).toEqual(requiredBefore);
    expect(await runtimeRegistry.getSessionSettings(fresh)).toEqual(oldSettings);
    runtime = new ClaudeCodeRuntime(dorkHome, home);
    ownedRuntimes.push(runtime);
    runtimeRegistry.register(runtime);
    runtime.setSessionSettings(runtimeRegistry);
    // Actual final configuration reads this owned account file; no SDK/provider call is allowed.
    await writeFile(
      path.join(root, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-only-invalid-billing-key' } })
    );
    const callsBefore = vi.mocked(query).mock.calls.length;
    let refusal: unknown;
    try {
      for await (const event of runtime.sendMessage(fresh, 'Do not launch on a different bill', {
        cwd: home,
        accountHint: 'actual-account',
        forAgent: home,
      }))
        void event;
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/billing choice cannot be preserved/);
    expect(query).toHaveBeenCalledTimes(callsBefore);
    expect(reopened.select().from(roomTurnSpend).all()).toHaveLength(1);
    expect(await readFile(oldNative, 'utf8')).toBe(original);
  },
  20000
);
