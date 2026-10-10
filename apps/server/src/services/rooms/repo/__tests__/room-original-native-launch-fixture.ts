/** Test-only original owning construction. No authority is registered from a DTO or mock verifier. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import request from '@dorkos/test-utils/supertest';
import { agents, authors, eq, sessionMetadata, runMigrations, user, type Db } from '@dorkos/db';
import { openServerDatabase } from '@dorkos/db/internal-server';
import { randomUUID } from 'node:crypto';
import type { AgentRuntime, AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import {
  replaceAgentHomeRegistry,
  type AgentHomeRegistry,
} from '../../../core/agent-identity/index.js';
import { currentRoomDueServicePort } from '../../../canvas/doc-channel/service.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { docInstallationOwner } from '../../../canvas/doc-channel/current/doc-source-policy.js';
import {
  TestModeRuntime,
  readTestModeOriginalPreparedRoomContext,
  readTestModeOriginalCanonicalSessionId,
  readTestModeOriginalActiveStream,
  resolveTestModeOriginalNativeStreamPrincipal,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { followSessionRekeys } from '../../session-bindings/room-session-convergence.js';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { MessageQueueStore, setMessageQueueStore } from '../../../session/message-queue-store.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import {
  disposeProjector,
  peekProjector,
  setSessionEventStore,
} from '../../../session/session-state-projector.js';
import { isTurnInFlight, resetMessageDispatcher } from '../../../session/message-dispatcher.js';
import {
  ROOM_REPO_CAP_DEFAULTS,
  RoomMergeResultSchema,
  type RoomMergeResult,
  type RoomRepoCaps,
} from '@dorkos/shared/room-repo';
import { composeRegistry } from '../../../core/capabilities/registry.js';
import { roomsDomain } from '../../room-capabilities.js';
import { logger } from '../../../../lib/logger.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { env } from '../../../../env.js';
import { initConfigManager, configManager } from '../../../core/config-manager.js';
import {
  initAuth,
  sessionGate,
  toNodeHandler,
  readOwnerAccount,
  type Auth,
} from '../../../core/auth/index.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import {
  createRoomSubsystem,
  type RoomSubsystem,
  setRoomService,
  resolveOperatorAuthor,
  setRoomRepoService,
  setRoomMergeService,
  setRoomWorktreeManager,
  setRoomFilesService,
  setRoomFileEditor,
} from '../../index.js';
import {
  createSessionRoomTurnRunner,
  readOriginalRoomRunnerPlacedContext,
  type RoomTurnRunnerOptions,
} from '../../room-turn-runner.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomMergeService } from '../room-merge-service.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { RoomRepoReconciler } from '../room-repo-reconciler.js';
import { RoomFilesService } from '../room-files.js';
import { RoomFileEditor } from '../room-file-editor.js';
import { readOperatorDisplayName } from '../../../core/config/operator-display-name.js';
import { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import {
  InstallationFileWrites,
  readInstallationFileRoomWrites,
  stopInstallationFileWrites,
} from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import { createDocChannelHttpComposition } from '../../../canvas/doc-channel/http-composition.js';
import roomsRouter from '../../../../routes/rooms.js';
import { resolveAgentIdentity } from '../../../../middleware/agent-identity.js';
import { auditActor } from '../../../../middleware/audit-actor.js';
import { errorHandler } from '../../../../middleware/error-handler.js';

import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  refreshRoomWorktree,
  afterFailedWrite,
  type RoomWorktreeRefreshTarget,
  type RoomWorktreeRefreshDeps,
} from '../room-worktree-refresh.js';

/** Portable public fixture types retain the real constructors and shared native Db. */
export interface OriginalNativeLaunchFixture {
  dir: string;
  db: Db;
  auth: Auth;
  app: Express;
  server: Server;
  roomId: string;
  subsystem: RoomSubsystem;
  runner: ReturnType<typeof createSessionRoomTurnRunner>;
  operator: ReturnType<typeof resolveOperatorAuthor>;
  member: ReturnType<RoomSubsystem['authors']['human']>;
  ownerId: string;
  memberId: string;
  ownerKey: { id: string; key: string };
  memberKey: { id: string; key: string };
  owner: InstallationFileWrites;
  channels: DocChannelStore;
  writer: ReturnType<typeof readInstallationFileRoomWrites>;
  repos: RoomRepoStore;
  mutex: RoomRepoMutex;
  repo: RoomRepoService;
  manager: RoomWorktreeManager;
  reconciler?: RoomRepoReconciler;
  merge: RoomMergeService;
  files: RoomFilesService;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  close: () => Promise<void>;
  stopNative: () => Promise<void>;
  bootNativeAgent: () => Promise<
    Readonly<{ agentPath: string; sessionId: string; authorId: string }>
  >;
  bootNativePair: () => Promise<
    readonly Readonly<{ agentPath: string; sessionId: string; authorId: string }>[]
  >;
  bootNativeMergePair: () => Promise<
    readonly Readonly<{ agentPath: string; sessionId: string; authorId: string }>[]
  >;
  readPreparedContext: (
    sessionId: string
  ) => ReturnType<typeof readTestModeOriginalPreparedRoomContext>;
  holdNativeSession: (sessionId: string) => void;
  holdCanonicalSession: (sessionId: string) => void;
  stepCanonicalSession: (sessionId: string) => boolean;
  readCanonicalSession: (sessionId: string) => string | undefined;
  finishCanonicalSession: (sessionId: string) => Promise<void>;
  readBoundPlacedContext: (
    sessionId: string
  ) => ReturnType<typeof readOriginalRoomRunnerPlacedContext>;
  readBoundPreparedContext: (
    sessionId: string
  ) => ReturnType<typeof readTestModeOriginalPreparedRoomContext>;
  finishNativeSession: (sessionId: string) => Promise<void>;
  finishNativePair: () => Promise<void>;
  pauseNextNativePlacement: () => void;
  readPlacedContext: (sessionId: string) => ReturnType<typeof readOriginalRoomRunnerPlacedContext>;
  releaseNativePlacement: () => void;
  mergeNative: (sessionId: string, summary: string) => Promise<RoomMergeResult>;
  afterFailedWrite: (lock: string, lockedBefore: boolean, error: unknown) => Promise<void>;
  refresh: (
    target: RoomWorktreeRefreshTarget,
    deps: RoomWorktreeRefreshDeps
  ) => ReturnType<typeof refreshRoomWorktree>;
}

/** Native setup and teardown share one owner. Register close immediately after acquiring the temp root. */
export async function createOriginalNativeLaunchFixture(
  options: {
    seed?: boolean;
    operatorName?: string;
    /** Legal production collection window; omission retains the shipped default. */
    collectDebounceMs?: number;
    homeParent?: string;
    now?: () => number;
    maintenance?: boolean;
    caps?: () => RoomRepoCaps;
    /** Existing original constructor timing DATA; no timer or clock substitution. */
    replyBounds?: Pick<RoomTurnRunnerOptions, 'waitMs' | 'ceilingMs' | 'waitingGraceMs'>;
    observeRun?: RoomTurnRunnerOptions['observeRun'];
    observeBeforeDispatch?: RoomTurnRunnerOptions['observeBeforeDispatch'];
    observeOriginalLaunch?: (data: Readonly<{ sessionId: string; roomId: string }>) => void;
    /** Native stored runtime type; nondefault requires its genuine constructor factory. */
    nativeRuntimeType?: 'claude-code' | 'codex' | 'opencode';
    /** Existing constructor reader; omission preserves this fixture's original repo reader. */
    roomConventions?: RoomTurnRunnerOptions['roomConventions'];
    /** Exercise the production default reader rather than injecting a fixture reader. */
    defaultRoomConventions?: boolean;
    /** Embedded Room assemblies may intentionally omit repo singleton publication. */
    publishRepoService?: boolean;
    roomTitle?: string;
    /** Supported original constructor only; provider doubles stay at the SDK boundary. */
    createNativeRuntime?: (construction: {
      dir: string;
      db: Db;
      principals: ConnectorRuntimePrincipalService;
      mesh: AgentRegistryPort;
      targets: readonly Readonly<{ agentPath: string; sessionId: string; authorId: string }>[];
    }) => AgentRuntime;
    /** Release a held provider independently of native interrupts before joining drains. */
    releaseProvider?: () => void | Promise<void>;
  } = {}
): Promise<OriginalNativeLaunchFixture> {
  await initBoundary(tmpdir());

  // Native Git registration and runtime grants name the canonical filesystem root.
  // Resolve the existing parent before acquiring a temp root, so a failed read
  // cannot strand a newly acquired fixture outside its registered close owner.
  const homeParent = await realpath(options.homeParent ?? tmpdir());
  const dir = await mkdtemp(path.join(homeParent, 'original-room-owning-'));
  let db: Db | undefined,
    channels: DocChannelStore | undefined,
    owner: InstallationFileWrites | undefined;
  let http: ReturnType<typeof createDocChannelHttpComposition> | undefined;
  let capturedStop: (() => Promise<void>) | undefined;
  let capturedCheckboxStop: (() => Promise<void>) | undefined;
  let capturedDueStop: (() => Promise<void>) | undefined;
  let capturedMaintenanceStop: (() => Promise<void>) | undefined;
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let stopNative: (() => Promise<void>) | undefined;
  let nativeBootStarted = false;
  let stopFollowingRekeys: (() => void) | undefined;
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      let failed = false,
        cause: unknown;
      const remember = (error: unknown): void => {
        if (!failed) {
          failed = true;
          cause = error;
        }
      };
      const startStop = (stop: (() => Promise<void>) | undefined): Promise<void> | undefined => {
        try {
          // Observe rejection immediately, including rejection with undefined.
          return stop?.().catch(remember);
        } catch (error) {
          remember(error);
          return undefined;
        }
      };
      // Start every exact owned producer cancellation before joining any drain.
      // A failed drain retains the open Db/root for recovery.
      const originalOwner = owner;
      const originalDb = db;
      const originalChannels = channels;
      const nativeStopping = startStop(stopNative);
      const fileStopping = startStop(
        capturedStop ??
          (originalOwner && originalDb && originalChannels
            ? () => stopInstallationFileWrites(originalOwner, originalDb, originalChannels)
            : undefined)
      );
      const checkboxStopping = startStop(capturedCheckboxStop);
      const dueStopping = startStop(capturedDueStop);
      const maintenanceStopping = startStop(capturedMaintenanceStop);
      const outcomes = await Promise.allSettled([
        nativeStopping,
        fileStopping,
        checkboxStopping,
        dueStopping,
        maintenanceStopping,
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') remember(outcome.reason);
      }
      // Keep native rekey following installed until the original native drain joins.
      try {
        stopFollowingRekeys?.();
      } catch (error) {
        remember(error);
      }
      try {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve()))
          );
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      if (failed) throw cause;
      try {
        if (db?.$client.open) db.$client.close();
      } catch (error) {
        failed = true;
        cause = error;
      }
      if (failed) throw cause;
      if (db?.$client.open) throw new Error('Original native Db did not positively close.');
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      if (failed) throw cause;
    })());
  try {
    initConfigManager(dir);
    if (options.operatorName !== undefined)
      configManager.set('profile', {
        ...configManager.get('profile'),
        displayName: options.operatorName,
      });
    configManager.set('rooms', {
      ...configManager.get('rooms'),
      ...(options.collectDebounceMs !== undefined
        ? { collectDebounceMs: options.collectDebounceMs }
        : {}),
      repo: { ...configManager.get('rooms').repo, enabled: true },
    });
    configManager.set('auth', { ...configManager.get('auth'), enabled: false });
    const opened = openServerDatabase(path.join(dir, 'fixture.sqlite'));
    db = opened.db;
    runMigrations(db);
    const auth = initAuth(db, dir),
      app = express();
    app.all('/api/auth/*splat', toNodeHandler(auth));
    server = createServer(app);
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const signup = await request(server!)
      .post('/api/auth/sign-up/email')
      .set('Origin', origin)
      .send({
        email: 'owner@original-room-fixture.test',
        password: 'actual-original-owner-password',
        name: options.operatorName ?? 'Original Owner',
      });
    assert.equal(signup.status, 200);
    const ownerId: string = signup.body.user.id;
    assert.equal(readOwnerAccount()?.id, ownerId);
    const now = new Date(),
      memberId = 'original-room-member';
    db.insert(user)
      .values({
        id: memberId,
        name: 'Member',
        email: 'member@original-room-fixture.test',
        role: 'user',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    let pauseNextPlacement = false;
    let placementRelease: (() => void) | undefined;
    const placementCapture: { roomId?: string; conventionRepo?: RoomRepoService } = {};
    // This is the existing constructor-owned conventions reader. It never
    // registers a request or supplies placement/currentness to the original Runner.
    const runner = createSessionRoomTurnRunner(
      options.defaultRoomConventions
        ? {
            ...options.replyBounds,
            ...(options.observeRun ? { observeRun: options.observeRun } : {}),
            ...(options.observeBeforeDispatch
              ? { observeBeforeDispatch: options.observeBeforeDispatch }
              : {}),
          }
        : {
            ...options.replyBounds,
            ...(options.observeRun ? { observeRun: options.observeRun } : {}),
            ...(options.observeBeforeDispatch
              ? { observeBeforeDispatch: options.observeBeforeDispatch }
              : {}),
            roomConventions:
              options.roomConventions ??
              (async (currentRoom) => {
                if (pauseNextPlacement && currentRoom.id === placementCapture.roomId) {
                  pauseNextPlacement = false;
                  await new Promise<void>((resolve) => {
                    placementRelease = resolve;
                  });
                  placementRelease = undefined;
                }
                return (await placementCapture.conventionRepo?.conventionsFor(currentRoom)) ?? null;
              }),
          }
    );
    // The default lookup reads actual native agent rows. A supplied scripted
    // Runner, member DTO, authorId or TestMode output never attests file rights.
    const subsystem = createRoomSubsystem({
      db,
      turns: runner,
      ...(options.observeOriginalLaunch
        ? { observeOriginalLaunch: options.observeOriginalLaunch }
        : {}),
    });
    setRoomService(subsystem.service);
    const operator = resolveOperatorAuthor(subsystem.authors),
      member = subsystem.authors.human(memberId);
    const room = subsystem.service.createRoom(
      {
        kind: 'channel',
        title: options.roomTitle ?? 'Original owning fixture',
        members: [],
        agentPaths: [],
      },
      operator.id
    );
    placementCapture.roomId = room.id;
    subsystem.service.addMember(room.id, operator.id, { authorId: member.id });
    const repos = new RoomRepoStore(db, dir),
      mutex = new RoomRepoMutex();
    channels = new DocChannelStore(db);
    owner = new InstallationFileWrites({ db, store: channels, roomRepos: repos, roomMutex: mutex });
    const writer = readInstallationFileRoomWrites(owner, db, channels, repos);
    const owning = {
      owner,
      writer,
      db,
      channels,
      rooms: subsystem.service,
      roomStore: subsystem.store,
    };
    const repo = new RoomRepoService(
      {
        store: repos,
        mutex,
        queueWaitMs: () => 5000,
        enabled: () => configManager.get('rooms').repo.enabled,
        getRoom: (id, viewer) => subsystem.service.getRoom(id, viewer),
        isOwnerAuthor: (id) => subsystem.authors.isOwner(id, readOwnerAccount()?.id ?? null),
        operatorGitName: readOperatorDisplayName,
        caps: () => options.caps?.() ?? { ...ROOM_REPO_CAP_DEFAULTS },
        maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
        pinRoomMd: (id, author) => {
          subsystem.service.canvas.open(
            id,
            author,
            { type: 'file', sourcePath: 'ROOM.md' },
            { pinned: true }
          );
        },
      },
      owning
    );
    placementCapture.conventionRepo = repo;
    if (options.publishRepoService !== false) setRoomRepoService(repo);
    const manager = new RoomWorktreeManager(
      {
        store: repos,
        hasRepo: (id) => repo.hasRepo(id),
        listStrandedWorktrees: (id) => repo.listStrandedWorktrees(id),
        reapAfterDays: () => 14,
        busyAgentPaths: () => subsystem.service.listBusyAgentPaths(),
        ...(options.now ? { now: options.now } : {}),
      },
      { ...owning, mutex }
    );
    setRoomWorktreeManager(manager);
    const reconciler = options.maintenance
      ? new RoomRepoReconciler(repos, 300000, manager, { ...owning, repos, mutex })
      : undefined;
    if (reconciler) capturedMaintenanceStop = reconciler.stop.bind(reconciler);
    const files = new RoomFilesService({
      store: repos,
      hasRepo: (id) => repo.hasRepo(id),
      maxFileBytes: () => ROOM_REPO_CAP_DEFAULTS.maxFileBytes,
    });
    setRoomFilesService(files);
    // The same original writer/mutex own a genuine authenticated file save.
    // No public editor call substitutes a constructor-owned request lifetime.
    const fileEditor = new RoomFileEditor({
      store: repos,
      mutex,
      installationRoomWrites: writer,
      enabled: () => configManager.get('rooms').repo.enabled,
      queueWaitMs: () => configManager.get('rooms').repo.mergeQueueWaitMs,
      assertCanWriteFiles: (id, author) => subsystem.service.assertCanWriteFiles(id, author),
      operatorGitName: readOperatorDisplayName,
      personName: (id) =>
        subsystem.authors.isOwner(id, readOwnerAccount()?.id ?? null)
          ? readOperatorDisplayName()
          : (subsystem.authors.getById(id)?.displayName ?? null),
      announce: (id, input) => subsystem.service.postFileChangeEvent(id, input),
      uploadStagingRoot: () => path.join(dir, '.temp', 'room-uploads'),
      files,
    });
    setRoomFileEditor(fileEditor);
    // The original principal constructor is shared by this installation and
    // its TestMode child. Policy always re-reads actual agent/session rows.
    const nativeOwner = () => docInstallationOwner('original-room-owning-fixture');
    const principals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async (input) => {
          const a = opened.db
            .select()
            .from(agents)
            .where(eq(agents.projectPath, input.agentPath))
            .get();
          const session = opened.db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
            .get();
          if (
            !a ||
            a.status !== 'active' ||
            a.runtime !== input.runtime ||
            !session ||
            session.agentPath !== input.agentPath ||
            session.runtime !== input.runtime ||
            input.canonicalCwd !== input.agentPath
          )
            throw new Error('Original native agent/session unavailable');
          return { owner: nativeOwner(), agentId: a.id };
        },
        revalidateTurn: async (claims) => {
          const a = opened.db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
          const session = opened.db
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
            session.agentPath === claims.agentPath &&
            session.runtime === claims.runtime &&
            JSON.stringify(claims.owner) === JSON.stringify(nativeOwner())
          );
        },
      },
    });
    await principals.initializeBoot();
    const merge = new RoomMergeService(
      {
        store: repos,
        mutex,
        enabled: () => configManager.get('rooms').repo.enabled,
        mergeQueueWaitMs: () => 5000,
        requireMembership: (id, author) => subsystem.service.requireMembership(id, author),
        listAgentMembers: (id) => subsystem.service.listAgentMembers(id),
        listStrandedWorktrees: (id) => repo.listStrandedWorktrees(id),
        announce: (id, input) => subsystem.service.postMergeEvent(id, input),
        isOwnerAuthor: (id) => subsystem.authors.isOwner(id, readOwnerAccount()?.id ?? null),
      },
      { ...owning, nativePrincipals: principals }
    );
    setRoomMergeService(merge);

    http = createDocChannelHttpComposition({
      db,
      documents: subsystem.canvasDocuments,
      rooms: subsystem.service,
      roomStore: subsystem.store,
      roomRepos: repos,
      approvals: new ApprovalService(db),
      roomRepoService: repo,
      roomMergeService: merge,
      roomWorktreeManager: manager,
      ...(reconciler ? { roomRepoReconciler: reconciler } : {}),
      roomFileEditor: fileEditor,
      installationId: 'original-room-owning-fixture',
      roomConstruction: opened.serverNativeRoomConstruction,
      nativeRuntimePrincipals: principals,
      runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
      revalidateRuntime: (proof) => principals.revalidatePrincipal(proof),
      owningFileWrites: { channels, fileWrites: owner },
    });
    capturedStop = http.stopFileWrites.bind(http);
    capturedCheckboxStop = http.stopCheckboxWrites.bind(http);
    const due = currentRoomDueServicePort(http.service);
    capturedDueStop = due.stopPump.bind(due);
    const ownerKey = await auth.api.createApiKey({
      body: { userId: ownerId, name: 'genuine-owner-control' },
    });
    const memberKey = await auth.api.createApiKey({
      body: { userId: memberId, name: 'genuine-member-control' },
    });
    configManager.set('auth', { ...configManager.get('auth'), enabled: true });
    app.use(express.json({ limit: '1mb' }));
    app.use(sessionGate);
    app.use(resolveAgentIdentity);
    app.use(auditActor);
    app.use('/api/rooms', roomsRouter);
    app.use(errorHandler);
    if (options.seed !== false) {
      const enabled = await request(server!)
        .post(`/api/rooms/${room.id}/repo`)
        .set('Authorization', `Bearer ${ownerKey.key}`);
      assert.equal(enabled.status, 201);
      assert.equal(enabled.body.repo.roomId, room.id);
    }
    const capabilities = composeRegistry(
      [roomsDomain],
      { logger, roomDeps: { rooms: subsystem.service, merges: merge } },
      undefined,
      { service: merge, nativePrincipals: principals, db: opened.db }
    );
    let nativeRuntime: AgentRuntime | undefined;
    let nativeSessions = new Set<string>();
    const nativeTargetAuthors = new Map<string, string>();
    const bootNative = async (names: readonly string[]) => {
      if (nativeBootStarted) throw new Error('Original native fixture boot already attempted');
      nativeBootStarted = true;
      const actualDb = opened.db;
      const runtimeType = options.nativeRuntimeType ?? 'claude-code';
      if (runtimeType !== 'claude-code' && !options.createNativeRuntime)
        throw new Error('Original nondefault runtime requires its constructor factory');
      const targets: { agentPath: string; sessionId: string; authorId: string }[] = [];
      for (const name of names) {
        const agentPath = path.join(
            dir,
            name === 'Native Agent' ? 'native-agent' : name.toLowerCase()
          ),
          sessionId = randomUUID(),
          agentId = randomUUID(),
          now = new Date().toISOString();
        await mkdir(agentPath);
        actualDb
          .insert(agents)
          .values({
            id: agentId,
            name,
            displayName: name,
            runtime: runtimeType,
            projectPath: agentPath,
            registeredAt: now,
            updatedAt: now,
          })
          .run();
        actualDb
          .insert(sessionMetadata)
          .values({ sessionId, agentPath, runtime: runtimeType, createdAt: now })
          .run();
        subsystem.service.addMember(room.id, operator.id, { agentPath });
        const author = actualDb
          .select()
          .from(authors)
          .where(eq(authors.naturalKey, agentPath))
          .get();
        if (!author || author.mintedForManifestId !== agentId)
          throw new Error('Original native agent author missing');
        subsystem.store.bindRoomSession(room.id, author.id, sessionId, now);
        targets.push(Object.freeze({ agentPath, sessionId, authorId: author.id }));
      }
      const nativeCapture: { runtime?: AgentRuntime; homeRegistry?: AgentHomeRegistry } = {};
      const oldMode = env.DORKOS_TEST_RUNTIME;
      let stop: Promise<void> | undefined;
      stopNative = () =>
        (stop ??= (async () => {
          let failed = false,
            first: unknown;
          const remember = (error: unknown) => {
            if (!failed) {
              failed = true;
              first = error;
            }
          };
          // Cancel the original held conventions read before joining its Room claim.
          pauseNextPlacement = false;
          try {
            placementRelease?.();
          } catch (error) {
            remember(error);
          }
          // Same-owner actual bindings may now name a freshly minted first-turn
          // id rather than the bootstrap placeholder. Capture those DATA ids for
          // cancellation/retirement only; this set never issues a native request.
          const retiringSessionIds = new Set(targets.map((target) => target.sessionId));
          for (const target of targets) {
            try {
              const bound = subsystem.store.getRoomSession(room.id, target.authorId);
              if (bound !== null) retiringSessionIds.add(bound);
            } catch (error) {
              remember(error);
            }
          }
          const peers = [
            Promise.resolve().then(() => options.releaseProvider?.()),
            Promise.resolve()
              .then(() => subsystem.service.haltRoom(room.id, operator.id))
              .finally(() => placementRelease?.()),
            ...[...retiringSessionIds].map((sessionId) =>
              Promise.resolve().then(() => nativeCapture.runtime?.interruptQuery(sessionId))
            ),
          ];
          for (const result of await Promise.allSettled(peers))
            if (result.status === 'rejected') remember(result.reason);
          try {
            await subsystem.service.triggersIdle();
          } catch (error) {
            remember(error);
          }
          if (failed) throw first;
          if (
            nativeCapture.homeRegistry &&
            !replaceAgentHomeRegistry(nativeCapture.homeRegistry, undefined)
          )
            throw new Error('Original provider agent home bootstrap changed during cleanup');
          resetMessageDispatcher();
          for (const sessionId of retiringSessionIds) disposeProjector(sessionId);
          setMessageQueueStore(undefined);
          setSessionEventStore(undefined);
          env.DORKOS_TEST_RUNTIME = oldMode;
        })());
      stopFollowingRekeys = followSessionRekeys(subsystem.store);
      const mesh: AgentRegistryPort = {
        getByPath: (cwd) => {
          const agent = actualDb.select().from(agents).where(eq(agents.projectPath, cwd)).get();
          return agent?.status === 'active'
            ? {
                id: agent.id,
                name: agent.name,
                ...(agent.displayName ? { displayName: agent.displayName } : {}),
              }
            : undefined;
        },
        listWithPaths: () =>
          actualDb
            .select()
            .from(agents)
            .where(eq(agents.status, 'active'))
            .all()
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              projectPath: agent.projectPath,
              ...(agent.displayName ? { displayName: agent.displayName } : {}),
            })),
        updateLastSeen: (id) =>
          actualDb
            .update(agents)
            .set({ lastSeenAt: new Date().toISOString() })
            .where(eq(agents.id, id))
            .run(),
      };
      if (options.createNativeRuntime) {
        const homeRegistry: AgentHomeRegistry = {
          isRegisteredHome: (cwd) => mesh.getByPath(cwd) !== undefined,
          listRegisteredHomes: () => mesh.listWithPaths().map((agent) => agent.projectPath),
          managedWorkspaceOwner: () => null,
          roomsDir: path.join(dir, 'rooms'),
        };
        if (!replaceAgentHomeRegistry(undefined, homeRegistry))
          throw new Error('Foreign provider agent home bootstrap is installed');
        nativeCapture.homeRegistry = homeRegistry;
      }
      if (!options.createNativeRuntime) env.DORKOS_TEST_RUNTIME = true;
      nativeCapture.runtime = options.createNativeRuntime
        ? options.createNativeRuntime({ dir, db: actualDb, principals, mesh, targets })
        : new TestModeRuntime('claude-code', principals);
      if (nativeCapture.runtime.type !== runtimeType)
        throw new Error('Original fixture runtime type changed');
      for (const target of targets)
        nativeCapture.runtime.ensureSession(target.sessionId, {
          cwd: target.agentPath,
          permissionMode: 'default',
        });
      nativeRuntime = nativeCapture.runtime;
      nativeSessions = new Set(targets.map((target) => target.sessionId));
      for (const target of targets) nativeTargetAuthors.set(target.sessionId, target.authorId);
      setMessageQueueStore(new MessageQueueStore(actualDb));
      setSessionEventStore(new SessionEventStore(actualDb));
      runtimeRegistry.setDb(actualDb);
      runtimeRegistry.register(nativeCapture.runtime);
      runtimeRegistry.setDefault(runtimeType);
      return Object.freeze(targets);
    };
    // A native stream can retire before its projector/dispatcher finally releases
    // the real runtime lock. Successor turns require that complete owned frontier.
    const waitNativeSettlement = async (sessionIds: readonly string[]): Promise<void> => {
      const selected = runtimeRegistry.get(options.nativeRuntimeType ?? 'claude-code');
      assert.ok(nativeRuntime);
      assert.equal(readOriginalRegisteredRuntime(selected), nativeRuntime);
      for (let i = 0; i < 1000; i++) {
        if (
          sessionIds.every(
            (sessionId) =>
              !isTurnInFlight(sessionId, selected) &&
              peekProjector(sessionId)?.getStatus().lifecycle === 'idle'
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error('Original native dispatcher/projector settlement required');
    };
    return {
      dir,
      db,
      auth,
      app,
      server: server!,
      roomId: room.id,
      subsystem,
      runner,
      operator,
      member,
      ownerId,
      memberId,
      ownerKey,
      memberKey,
      owner,
      channels,
      writer,
      repos,
      mutex,
      repo,
      manager,
      reconciler,
      merge,
      files,
      http,
      close,
      stopNative: () => stopNative?.() ?? Promise.resolve(),
      bootNativeAgent: async () => (await bootNative(['Native Agent']))[0]!,
      bootNativePair: () => bootNative(['Ana', 'Bo']),
      bootNativeMergePair: () => bootNative(['Ana', 'Ben']),
      readPreparedContext: (sessionId) => {
        if (!nativeRuntime || !nativeSessions.has(sessionId))
          throw new Error('Original native session is absent');
        return readTestModeOriginalPreparedRoomContext(nativeRuntime, sessionId);
      },
      holdNativeSession: (sessionId) => {
        if (
          !nativeRuntime ||
          !nativeSessions.has(sessionId) ||
          readTestModeOriginalActiveStream(nativeRuntime, sessionId)
        )
          throw new Error('Original idle native session required');
        scenarioStore.setForSession(sessionId, 'warm-echo');
      },
      holdCanonicalSession: (sessionId) => {
        if (
          !nativeRuntime ||
          !nativeSessions.has(sessionId) ||
          readTestModeOriginalActiveStream(nativeRuntime, sessionId)
        )
          throw new Error('Original idle native session required');
        scenarioStore.setForSession(sessionId, 'native-canonical-rekey');
      },
      stepCanonicalSession: (sessionId) => {
        if (
          !nativeRuntime ||
          !nativeSessions.has(sessionId) ||
          readTestModeOriginalCanonicalSessionId(nativeRuntime, sessionId)?.canonicalId
        )
          throw new Error('Original first canonical barrier required');
        // A projected turn_start precedes the original native open; absence does not release a step.
        if (!readTestModeOriginalActiveStream(nativeRuntime, sessionId)) return false;
        return interactionGate.step(sessionId);
      },
      readCanonicalSession: (sessionId) => {
        if (!nativeRuntime || !nativeSessions.has(sessionId))
          throw new Error('Original native session is absent');
        return readTestModeOriginalCanonicalSessionId(nativeRuntime, sessionId)?.canonicalId;
      },
      finishCanonicalSession: async (sessionId) => {
        if (
          !nativeRuntime ||
          !nativeSessions.has(sessionId) ||
          !readTestModeOriginalCanonicalSessionId(nativeRuntime, sessionId)?.canonicalId ||
          !readTestModeOriginalActiveStream(nativeRuntime, sessionId)
        )
          throw new Error('Original held canonical turn required');
        // Clear only future selection before releasing this actual captured barrier.
        scenarioStore.clearSession(sessionId);
        let released = false;
        for (let i = 0; i < 1000 && !released; i++) {
          if (
            !readTestModeOriginalCanonicalSessionId(nativeRuntime, sessionId)?.canonicalId ||
            !readTestModeOriginalActiveStream(nativeRuntime, sessionId)
          )
            throw new Error('Original canonical turn retired before release');
          released = interactionGate.step(sessionId);
          if (!released) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (!released) throw new Error('Original second canonical barrier required');
        await subsystem.service.triggersIdle();
      },
      readBoundPlacedContext: (sessionId) => {
        const authorId = nativeTargetAuthors.get(sessionId);
        if (!authorId) throw new Error('Original native target is absent');
        const current = subsystem.store.getRoomSession(room.id, authorId);
        return current ? readOriginalRoomRunnerPlacedContext(runner, current) : undefined;
      },
      readBoundPreparedContext: (sessionId) => {
        const authorId = nativeTargetAuthors.get(sessionId);
        if (!nativeRuntime || !authorId) throw new Error('Original native target is absent');
        const current = subsystem.store.getRoomSession(room.id, authorId);
        return current
          ? readTestModeOriginalPreparedRoomContext(nativeRuntime, current)
          : undefined;
      },
      finishNativeSession: async (sessionId) => {
        if (!nativeRuntime || !nativeSessions.has(sessionId) || !interactionGate.step(sessionId))
          throw new Error('Original native scenario step is not held');
        await subsystem.service.triggersIdle();
        scenarioStore.clearSession(sessionId);
        await waitNativeSettlement([sessionId]);
      },
      finishNativePair: async () => {
        if (!nativeRuntime || nativeSessions.size !== 2)
          throw new Error('Original native pair is absent');
        // Release both real barriers before awaiting the room-wide idle drain.
        // A missing barrier remains a failure; owning close retires its peers.
        let failed = false;
        for (const sessionId of nativeSessions) if (!interactionGate.step(sessionId)) failed = true;
        if (failed) throw new Error('Original native pair is not held');
        await subsystem.service.triggersIdle();
        for (const sessionId of nativeSessions) scenarioStore.clearSession(sessionId);
        await waitNativeSettlement([...nativeSessions]);
      },
      pauseNextNativePlacement: () => {
        if (!nativeRuntime || pauseNextPlacement || placementRelease)
          throw new Error('Original native placement pause is unavailable');
        pauseNextPlacement = true;
      },
      readPlacedContext: (sessionId) => {
        if (!nativeSessions.has(sessionId)) throw new Error('Original native session is absent');
        return readOriginalRoomRunnerPlacedContext(runner, sessionId);
      },
      releaseNativePlacement: () => {
        if (!placementRelease) throw new Error('Original native placement is not held');
        placementRelease();
      },
      mergeNative: async (sessionId, summary) => {
        if (!nativeRuntime || !nativeSessions.has(sessionId))
          throw new Error('Original native session required');
        const stream = readTestModeOriginalActiveStream(nativeRuntime, sessionId);
        if (!stream) throw new Error('Original active native stream required');
        const principal = await resolveTestModeOriginalNativeStreamPrincipal(nativeRuntime, stream);
        if (
          principal.status !== 'resolved' ||
          readTestModeOriginalActiveStream(nativeRuntime, sessionId) !== stream
        )
          throw new Error('Original native merge producer retired');
        const target = opened.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, sessionId))
          .get();
        if (!target?.agentPath) throw new Error('Original native target missing');
        const result = await capabilities.invoke(
          'rooms.merge',
          { roomId: room.id, summary },
          {
            serverPrincipal: principal.principal,
            sessionId,
            cwd: target.agentPath,
            mcpServer: 'in-session',
          }
        );
        return RoomMergeResultSchema.parse(result);
      },
      afterFailedWrite: (lock, lockedBefore, error) =>
        withRecognizedInstallationRoomNamespace(writer, room.id, (scope) =>
          afterFailedWrite(
            lock,
            lockedBefore,
            error,
            readInstallationRoomMutationContext(writer, room.id, scope)
          )
        ),
      // Unit controls enter the real owning namespace; they do not mint a
      // Trigger placement, native request or runtime launch authority.
      refresh: (target, deps) =>
        withRecognizedInstallationRoomNamespace(writer, room.id, (scope) =>
          refreshRoomWorktree(
            target,
            deps,
            readInstallationRoomMutationContext(writer, room.id, scope)
          )
        ),
    };
  } catch (error) {
    try {
      await close();
    } catch {
      /* Original setup failure, including undefined, stays first. */
    }
    throw error;
  }
}
