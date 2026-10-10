/** Original Room canvas conformance over two real native agent homes. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agents, eq, runMigrations, sessionMetadata, roomTurnSpend, type Db } from '@dorkos/db';
import { openServerDatabase } from '@dorkos/db/internal-server';
import type { AgentRuntime, AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { ConnectorRuntimeTools } from '../../runtimes/connector-tools.js';
import { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import { ConnectorThreadKeyRegistry } from '../../connectors/principal/thread-keys.js';
import { docInstallationOwner } from '../../canvas/doc-channel/current/doc-source-policy.js';
import { clearCanvasService } from '../../canvas/index.js';
import { initAuth, readOwnerAccount } from '../../core/auth/index.js';
import {
  replaceAgentHomeRegistry,
  getAgentIdentityService,
  type AgentHomeRegistry,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../core/agent-identity/index.js';
import {
  runtimeRegistry,
  readOriginalRuntimeRegistrySelection,
  readOriginalRegisteredRuntime,
} from '../../core/runtime-registry.js';
import {
  createRoomSubsystem,
  setRoomService,
  clearRoomService,
  resolveOperatorAuthor,
} from '../../rooms/index.js';
import {
  createSessionRoomTurnRunner,
  readOriginalRoomRunnerPlacedContext,
} from '../../rooms/room-turn-runner.js';
import { followSessionRekeys } from '../../rooms/session-bindings/room-session-convergence.js';
import { SessionEventStore } from '../session-event-store.js';
import {
  setSessionEventStore,
  getSessionEventStore,
  disposeProjector,
} from '../session-state-projector.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
  getMessageQueueStore,
} from '../message-queue-store.js';
import { resetMessageDispatcher } from '../message-dispatcher.js';
import { resetStagedContextStore } from '../staged-context-store.js';
import { uiTurnFacts } from '../browser-seat/ui-turn-facts.js';
import { controlUi } from '../browser-seat/ui-control.js';
import { initBoundary } from '../../../lib/boundary.js';
import { env } from '../../../env.js';
import type { RoomCanvasTurnOutcome } from './durable-turn-harness.js';

/** Actual on-disk home and same-Db session for one original Room member. */
export interface RoomCanvasTarget {
  readonly agentPath: string;
  readonly sessionId: string;
  readonly agentId: string;
}
/** Provider doubles receive original constructor dependencies, never a replacement runtime or runner. */
export interface RoomCanvasRuntimeConstruction {
  readonly db: Db;
  readonly home: string;
  readonly targets: readonly RoomCanvasTarget[];
  readonly principals: ConnectorRuntimePrincipalService;
  readonly mesh: AgentRegistryPort;
  readonly tools: ConnectorRuntimeTools;
  /** Called only from the SDK query/runStreamed/promptAsync boundary. Returns its real session id. */
  readonly providerTurn: (cwd: string, headers?: Record<string, string>) => Promise<string>;
}

/** Drive two original Room dispatches; the first creates one canvas document and the second reads it. */
export async function driveRoomCanvasTurn(options: {
  runtime: 'claude-code' | 'codex' | 'opencode' | 'doe';
  testMode?: boolean;
  createRuntime: (construction: RoomCanvasRuntimeConstruction) => AgentRuntime;
  releaseProvider?: () => void | Promise<void>;
}): Promise<RoomCanvasTurnOutcome> {
  if (getAgentIdentityService() !== undefined)
    throw new Error('Foreign agent identity bootstrap is already installed');
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'room-canvas-conformance-')));
  let db: Db | undefined;
  let subsystem: ReturnType<typeof createRoomSubsystem> | undefined;
  let runtime: AgentRuntime | undefined;
  let roomId: string | undefined;
  let human: string | undefined;
  let stopRekeys: (() => void) | undefined;
  let homeRegistry: AgentHomeRegistry | undefined;
  let agentIdentity: ReturnType<typeof initAgentIdentityService> | undefined;
  let closed = false;
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const targets: RoomCanvasTarget[] = [];
  const contexts = new Map<string, RoomContextData>();
  let dispatched = 0;
  let queueStore: MessageQueueStore | undefined;
  let eventStore: SessionEventStore | undefined;
  let outcome: RoomCanvasTurnOutcome | undefined;
  try {
    await initBoundary(home);
    db = openServerDatabase(path.join(home, 'native.sqlite')).db;
    const actualDb = db;
    runMigrations(actualDb);
    const auth = initAuth(actualDb, home);
    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const signup = await auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({
          name: 'Room canvas owner',
          email: 'room-canvas@fixture.test',
          password: 'original-room-canvas-password',
        }),
      })
    );
    await signup.arrayBuffer();
    if (signup.status !== 200 || !readOwnerAccount())
      throw new Error('Original Room canvas owner unavailable');
    const now = new Date().toISOString();
    for (const name of ['ana', 'ben']) {
      const agentPath = path.join(home, name),
        agentId = randomUUID(),
        sessionId = randomUUID();
      await mkdir(path.join(agentPath, '.dork'), { recursive: true });
      await writeFile(
        path.join(agentPath, '.dork', 'agent.json'),
        JSON.stringify({
          id: agentId,
          name,
          runtime: options.runtime,
          capabilities: [],
          behavior: { responseMode: 'always' },
          registeredAt: now,
          registeredBy: 'test',
        })
      );
      actualDb
        .insert(agents)
        .values({
          id: agentId,
          name,
          displayName: name,
          runtime: options.runtime,
          projectPath: agentPath,
          behaviorJson: '{"responseMode":"always"}',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      actualDb
        .insert(sessionMetadata)
        .values({
          sessionId,
          agentPath,
          runtime: options.runtime,
          createdAt: now,
        })
        .run();
      targets.push(Object.freeze({ agentPath, agentId, sessionId }));
    }
    homeRegistry = {
      isRegisteredHome: (cwd) =>
        actualDb
          .select()
          .from(agents)
          .where(eq(agents.projectPath, cwd))
          .all()
          .some((a) => a.status === 'active'),
      listRegisteredHomes: () =>
        actualDb
          .select()
          .from(agents)
          .where(eq(agents.status, 'active'))
          .all()
          .map((a) => a.projectPath),
      managedWorkspaceOwner: () => null,
      roomsDir: path.join(home, 'rooms'),
    };
    if (!replaceAgentHomeRegistry(undefined, homeRegistry))
      throw new Error('Foreign agent home bootstrap is already installed');
    if (getAgentIdentityService() !== undefined)
      throw new Error('Agent identity bootstrap changed during setup');
    agentIdentity = initAgentIdentityService(actualDb);
    const owner = () => docInstallationOwner('original-room-canvas-conformance');
    const threadKeys = new ConnectorThreadKeyRegistry();
    const principals = new ConnectorRuntimePrincipalService({
      db: actualDb,
      threadKeys,
      authority: {
        authorizeTurn: async (input) => {
          const a = actualDb
            .select()
            .from(agents)
            .where(eq(agents.projectPath, input.agentPath))
            .get();
          const session = actualDb
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
            .get();
          if (
            !a ||
            a.status !== 'active' ||
            a.runtime !== input.runtime ||
            !session ||
            session.agentPath !== a.projectPath ||
            session.runtime !== input.runtime ||
            input.canonicalCwd !== a.projectPath
          )
            throw new Error('Original Room canvas agent/session unavailable');
          return { owner: owner(), agentId: a.id };
        },
        revalidateTurn: async (claims) => {
          const a = actualDb.select().from(agents).where(eq(agents.id, claims.agentId)).get();
          const session = actualDb
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
            .get();
          return (
            !!a &&
            a.status === 'active' &&
            a.projectPath === claims.agentPath &&
            a.runtime === claims.runtime &&
            !!session &&
            session.agentPath === a.projectPath &&
            session.runtime === claims.runtime &&
            JSON.stringify(claims.owner) === JSON.stringify(owner())
          );
        },
      },
    });
    await principals.initializeBoot();
    const mesh: AgentRegistryPort = {
      getByPath: (cwd) => {
        const a = actualDb.select().from(agents).where(eq(agents.projectPath, cwd)).get();
        return a?.status === 'active'
          ? {
              id: a.id,
              name: a.name,
              ...(a.displayName ? { displayName: a.displayName } : {}),
            }
          : undefined;
      },
      updateLastSeen: (id) =>
        actualDb
          .update(agents)
          .set({ lastSeenAt: new Date().toISOString() })
          .where(eq(agents.id, id))
          .run(),
      listWithPaths: () =>
        actualDb
          .select()
          .from(agents)
          .where(eq(agents.status, 'active'))
          .all()
          .map((a) => ({
            id: a.id,
            name: a.name,
            projectPath: a.projectPath,
            ...(a.displayName ? { displayName: a.displayName } : {}),
          })),
    };
    const runner = createSessionRoomTurnRunner({
      roomConventions: async () => {
        for (const target of targets) {
          const context = readOriginalRoomRunnerPlacedContext(runner, target.sessionId);
          if (context) {
            dispatched++;
            contexts.set(target.sessionId, context);
          }
        }
        return null;
      },
    });
    subsystem = createRoomSubsystem({ db: actualDb, turns: runner });
    const rooms = subsystem;
    setRoomService(rooms.service);
    human = resolveOperatorAuthor(rooms.authors).id;
    const room = rooms.service.createRoom(
      {
        kind: 'channel',
        title: 'Conformance',
        members: [],
        agentPaths: targets.map((t) => t.agentPath),
      },
      human
    );
    roomId = room.id;
    const memberIds = targets.map((target) => {
      const author = rooms.authors.resolveAgent(target.agentPath, path.basename(target.agentPath));
      if (author.mintedForManifestId !== target.agentId)
        throw new Error('Original Room canvas author is foreign');
      rooms.store.bindRoomSession(room.id, author.id, target.sessionId, now);
      return author.id;
    });
    const tools: ConnectorRuntimeTools = {
      principals,
      threadKeys,
      listenerUrl: 'http://127.0.0.1:1/mcp/connections',
      agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
      isConnectorCapabilityId: () => false,
    };
    let canvasProduced = false;
    const providerTurn = async (cwd: string, headers?: Record<string, string>) => {
      const target = targets.find((t) => t.agentPath === cwd);
      if (!target) throw new Error('Provider entered a foreign Room canvas home');
      if (headers !== undefined) {
        const authorization = headers.Authorization;
        if (
          !authorization?.startsWith('Bearer ') ||
          headers['X-DorkOS-Connector-Runtime'] !== options.runtime ||
          headers['X-DorkOS-Connector-Cwd'] !== encodeURIComponent(cwd)
        )
          throw new Error('Original SDK connector headers unavailable');
        const resolved = await principals.resolve({
          bearer: authorization.slice(7),
          expectedRuntime: options.runtime,
          expectedCanonicalCwd: cwd,
        });
        if (
          resolved.status !== 'resolved' ||
          resolved.principal.claims.kind !== 'runtime' ||
          resolved.principal.claims.canonicalSessionId !== target.sessionId ||
          resolved.principal.claims.agentId !== target.agentId ||
          resolved.principal.claims.agentPath !== cwd
        )
          throw new Error('Original SDK principal does not own this Room target');
      }
      const session = actualDb
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, target.sessionId))
        .get();
      const facts = uiTurnFacts.read(target.sessionId);
      if (
        session?.agentPath !== cwd ||
        session.runtime !== options.runtime ||
        facts.roomTurn?.roomId !== room.id ||
        facts.roomTurn.authorId !== memberIds[targets.indexOf(target)]
      )
        throw new Error('Provider has no actual current Room turn');
      if (target === targets[0]) {
        if (canvasProduced) throw new Error('Room canvas provider entered twice');
        canvasProduced = true;
        await controlUi(
          {
            action: 'open_canvas',
            content: { type: 'json', data: {}, title: 'The plan' },
          },
          { sessionId: target.sessionId, cwd }
        );
      }
      return target.sessionId;
    };
    const previousMode = env.DORKOS_TEST_RUNTIME;
    try {
      if (options.testMode) env.DORKOS_TEST_RUNTIME = true;
      runtime = options.createRuntime({
        db: actualDb,
        home,
        targets,
        principals,
        mesh,
        tools,
        providerTurn,
      });
    } finally {
      env.DORKOS_TEST_RUNTIME = previousMode;
    }
    if (runtime.type !== options.runtime) throw new Error('Original Room canvas runtime changed');
    for (const target of targets)
      runtime.ensureSession(target.sessionId, {
        cwd: target.agentPath,
        permissionMode: 'default',
      });
    if (getMessageQueueStore() !== undefined || getSessionEventStore() !== undefined)
      throw new Error('Foreign session persistence bootstrap is already installed');
    queueStore = new MessageQueueStore(actualDb);
    eventStore = new SessionEventStore(actualDb);
    setMessageQueueStore(queueStore);
    setSessionEventStore(eventStore);
    resetMessageDispatcher();
    resetStagedContextStore();
    stopRekeys = followSessionRekeys(rooms.store);
    runtimeRegistry.setDb(actualDb);
    runtimeRegistry.register(runtime);
    runtimeRegistry.setDefault(runtime.type);
    rooms.service.updateMembership(room.id, human, memberIds[1]!, 'silent');
    rooms.service.updateMembership(room.id, human, memberIds[0]!, 'always');
    rooms.service.post(room.id, { authorId: human, text: 'put the plan up' });
    await rooms.service.triggersIdle();
    const turnsDispatchedByTheCanvasChange = dispatched;
    const committedTurns = actualDb
      .select()
      .from(roomTurnSpend)
      .where(eq(roomTurnSpend.roomId, room.id))
      .all().length;
    if (committedTurns !== turnsDispatchedByTheCanvasChange)
      throw new Error('Original requested Room turns did not all commit');
    const canvas = rooms.service.canvas.list(room.id);
    const canvasEntries = rooms.service
      .listEntries(room.id, human, { limit: 200 })
      .filter((entry) => entry.body.canvas !== undefined).length;
    rooms.service.updateMembership(room.id, human, memberIds[1]!, 'always');
    rooms.service.updateMembership(room.id, human, memberIds[0]!, 'silent');
    rooms.service.post(room.id, {
      authorId: human,
      text: 'what do you make of it?',
    });
    await rooms.service.triggersIdle();
    outcome = {
      documents: canvas.map((document) => ({
        id: document.id,
        title: document.title,
        authorId: document.authorId,
      })),
      nextTurnContextTitles: (contexts.get(targets[1]!.sessionId)?.canvas?.documents ?? []).map(
        (document) => document.title
      ),
      turnsDispatchedByTheCanvasChange,
      canvasEntries,
    };
  } catch (cause) {
    remember(cause);
  } finally {
    let cleanupFailed = false;
    const attempt = async (fn: () => unknown) => {
      try {
        await fn();
      } catch (cause) {
        cleanupFailed = true;
        remember(cause);
      }
    };
    // Start original halt and adapter interrupts independently before joining Room completion.
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        subsystem && roomId && human ? subsystem.service.haltRoom(roomId, human) : undefined
      ),
      ...targets.map((target) =>
        Promise.resolve().then(() => runtime?.interruptQuery(target.sessionId))
      ),
    ]);
    for (const result of results)
      if (result.status === 'rejected') {
        cleanupFailed = true;
        remember(result.reason);
      }
    await attempt(() => subsystem?.service.triggersIdle());
    await attempt(() => options.releaseProvider?.());
    // Failure/unknown setup retains the owning Db and files; no absent owner implies closure.
    if (!cleanupFailed && subsystem && runtime && db) {
      await attempt(() => {
        const selected = readOriginalRuntimeRegistrySelection(
          runtimeRegistry,
          db!,
          options.runtime
        );
        if (!selected || readOriginalRegisteredRuntime(selected) !== runtime)
          throw new Error('Original same-Db runtime registry changed during cleanup');
        if (getAgentIdentityService() !== agentIdentity)
          throw new Error('Agent identity bootstrap changed during cleanup');
      });
    }
    if (!cleanupFailed && subsystem && runtime) {
      await attempt(() => stopRekeys?.());
      await attempt(() => resetMessageDispatcher());
      for (const target of targets) await attempt(() => disposeProjector(target.sessionId));
      await attempt(() => subsystem!.service.canvas.dispose());
      await attempt(() => {
        if (!clearRoomService(subsystem!.service)) throw new Error('Room bootstrap is foreign');
      });
      await attempt(() => {
        if (!clearCanvasService(subsystem!.canvas)) throw new Error('Canvas bootstrap is foreign');
      });
      await attempt(() => {
        if (getAgentIdentityService() !== agentIdentity)
          throw new Error('Agent identity bootstrap is foreign');
        resetAgentIdentityService();
      });
      if (homeRegistry)
        await attempt(() => {
          if (!replaceAgentHomeRegistry(homeRegistry, undefined))
            throw new Error('Agent home bootstrap is foreign');
        });
      await attempt(() => {
        if (getMessageQueueStore() !== queueStore)
          throw new Error('Session queue bootstrap is foreign');
        setMessageQueueStore(undefined);
      });
      await attempt(() => {
        if (getSessionEventStore() !== eventStore)
          throw new Error('Session event bootstrap is foreign');
        setSessionEventStore(undefined);
      });
      if (!cleanupFailed) {
        await attempt(() => db!.$client.close());
        closed = db?.$client.open === false;
      }
      if (closed) await attempt(() => rm(home, { recursive: true, force: true }));
    }
  }
  if (failed) throw first;
  if (!closed || !outcome) throw new Error('Original Room canvas fixture did not positively close');
  return outcome;
}
