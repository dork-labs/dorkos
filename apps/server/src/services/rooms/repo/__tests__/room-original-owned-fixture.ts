/** Test-only original owning construction. No authority is registered from a DTO or mock verifier. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { expect } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { createDb, runMigrations, user, agents, sessionMetadata, eq, type Db } from '@dorkos/db';
import { commitAll, type GitIdentity } from '../room-repo-git.js';
import { openServerDatabase } from '@dorkos/db/internal-server';
import { currentRoomDueServicePort } from '../../../canvas/doc-channel/service.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { docInstallationOwner } from '../../../canvas/doc-channel/current/doc-source-policy.js';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
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
import { createSessionRoomTurnRunner } from '../../room-turn-runner.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomMergeService } from '../room-merge-service.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { RoomFilesService } from '../room-files.js';
import { RoomFileEditor, type RoomFileAnnouncement } from '../room-file-editor.js';
import { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import {
  InstallationFileWrites,
  readInstallationFileRoomWrites,
  stopInstallationFileWrites,
} from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import { createDocChannelHttpComposition } from '../../../canvas/doc-channel/http-composition.js';
import roomsRouter from '../../../../routes/rooms.js';
import { errorHandler } from '../../../../middleware/error-handler.js';
import { resolveAgentIdentity } from '../../../../middleware/agent-identity.js';
import { silenceGitAutoMaintenance } from './fixture-git.js';
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
export interface OriginalOwnedRoomFixture {
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
  merge: RoomMergeService;
  files: RoomFilesService;
  editor: RoomFileEditor;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  close: () => Promise<void>;
  stopWrites: () => Promise<void>;
  commitAll: (checkout: string, message: string, identity: GitIdentity) => Promise<string>;
  afterFailedWrite: (lock: string, lockedBefore: boolean, error: unknown) => Promise<void>;
  refresh: (
    target: RoomWorktreeRefreshTarget,
    deps: RoomWorktreeRefreshDeps
  ) => ReturnType<typeof refreshRoomWorktree>;
}

/** Native setup and teardown share one owner. Register close immediately after acquiring the temp root. */
export async function createOriginalOwnedRoomFixture(
  options: {
    seed?: boolean;
    nativeDatabase?: boolean;
    homeParent?: string;
    room?: { title: string; topic?: string; agentPaths?: string[] };
    operatorGitName?: () => string | null;
    onPin?: (roomId: string, authorId: string) => void;
    onFileAnnouncement?: (roomId: string, input: RoomFileAnnouncement) => void;
  } = {}
): Promise<OriginalOwnedRoomFixture> {
  await initBoundary(tmpdir());
  silenceGitAutoMaintenance();
  const dir = await mkdtemp(path.join(options.homeParent ?? tmpdir(), 'original-room-owning-'));
  let db: Db | undefined,
    channels: DocChannelStore | undefined,
    owner: InstallationFileWrites | undefined;
  let http: ReturnType<typeof createDocChannelHttpComposition> | undefined;
  let capturedStop: (() => Promise<void>) | undefined;
  let capturedCheckboxStop: (() => Promise<void>) | undefined;
  let capturedDueStop: (() => Promise<void>) | undefined;
  let native: ReturnType<typeof openServerDatabase> | undefined;
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let stopWritesPromise: Promise<void> | undefined;
  const stopWrites = (): Promise<void> =>
    (stopWritesPromise ??= (async () => {
      let failed = false,
        cause: unknown;
      // Invoke the exact captured owning stop before any await. A failed drain
      // retains the open Db/root for recovery instead of tearing down admitted work.
      let stopping: Promise<void> | undefined;
      try {
        if (capturedStop) stopping = capturedStop();
        else if (owner && db && channels)
          stopping = stopInstallationFileWrites(owner, db, channels);
      } catch (error) {
        failed = true;
        cause = error;
      }
      let checkboxStopping: Promise<void> | undefined;
      try {
        if (capturedCheckboxStop) checkboxStopping = capturedCheckboxStop();
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      if (checkboxStopping)
        checkboxStopping = checkboxStopping.catch((error) => {
          if (!failed) {
            failed = true;
            cause = error;
          }
        });
      let dueStopping: Promise<void> | undefined;
      try {
        if (capturedDueStop) dueStopping = capturedDueStop();
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      if (dueStopping)
        dueStopping = dueStopping.catch((error) => {
          if (!failed) {
            failed = true;
            cause = error;
          }
        });
      if (stopping)
        try {
          await stopping;
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      if (checkboxStopping) await checkboxStopping;
      if (dueStopping) await dueStopping;
      if (failed) throw cause;
    })());
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      let failed = false,
        cause: unknown;
      try {
        await stopWrites();
      } catch (error) {
        failed = true;
        cause = error;
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
        if (db?.$client.open) throw new Error('Original Room fixture Db did not close.');
      } catch (error) {
        failed = true;
        cause = error;
      }
      // A failed actual Db close cannot authorize deleting its owned repository.
      if (failed) throw cause;
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
    configManager.set('rooms', {
      ...configManager.get('rooms'),
      repo: { ...configManager.get('rooms').repo, enabled: true },
    });
    configManager.set('auth', { ...configManager.get('auth'), enabled: false });
    if (options.nativeDatabase) native = openServerDatabase(path.join(dir, 'fixture.sqlite'));
    db = native?.db ?? createDb(path.join(dir, 'fixture.sqlite'));
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
        name: 'Original Owner',
      });
    expect(signup.status).toBe(200);
    const ownerId: string = signup.body.user.id;
    expect(readOwnerAccount()?.id).toBe(ownerId);
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
    for (const [index, agentPath] of (options.room?.agentPaths ?? []).entries()) {
      const at = new Date().toISOString();
      db.insert(agents)
        .values({
          id: `original-repo-agent-${index}`,
          name: `original-repo-agent-${index}`,
          displayName: 'Agent',
          runtime: 'claude-code',
          projectPath: agentPath,
          behaviorJson: '{"responseMode":"silent"}',
          registeredAt: at,
          updatedAt: at,
        })
        .run();
    }
    const runner = createSessionRoomTurnRunner();
    // The default lookup reads actual native agent rows. A supplied scripted
    // Runner, member DTO, authorId or TestMode output never attests file rights.
    const subsystem = createRoomSubsystem({ db, turns: runner });
    setRoomService(subsystem.service);
    const operator = resolveOperatorAuthor(subsystem.authors),
      member = subsystem.authors.human(memberId);
    const room = subsystem.service.createRoom(
      {
        kind: 'channel',
        title: options.room?.title ?? 'Original owning fixture',
        ...(options.room?.topic === undefined ? {} : { topic: options.room.topic }),
        members: [],
        agentPaths: options.room?.agentPaths ?? [],
      },
      operator.id
    );
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
        operatorGitName: () =>
          options.operatorGitName ? options.operatorGitName() : 'Original Owner',
        caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
        maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
        pinRoomMd: (id, author) => {
          options.onPin?.(id, author);
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
    setRoomRepoService(repo);
    const manager = new RoomWorktreeManager(
      {
        store: repos,
        hasRepo: (id) => repo.hasRepo(id),
        listStrandedWorktrees: (id) => repo.listStrandedWorktrees(id),
        reapAfterDays: () => 14,
        busyAgentPaths: () => subsystem.service.listBusyAgentPaths(),
      },
      { ...owning, mutex }
    );
    setRoomWorktreeManager(manager);
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
      owning
    );
    setRoomMergeService(merge);
    const files = new RoomFilesService({
      store: repos,
      hasRepo: (id) => repo.hasRepo(id),
      maxFileBytes: () => configManager.get('rooms').repo.maxFileBytes,
    });
    setRoomFilesService(files);
    // Same original writer/queue and actual RoomService policy as production.
    // Mounting the editor alone never grants a caller write permission.
    const editor = new RoomFileEditor({
      store: repos,
      mutex,
      installationRoomWrites: writer,
      enabled: () => configManager.get('rooms').repo.enabled,
      queueWaitMs: () => 5000,
      assertCanWriteFiles: (id, author) => subsystem.service.assertCanWriteFiles(id, author),
      operatorGitName: () =>
        options.operatorGitName ? options.operatorGitName() : 'Original Owner',
      personName: (id) =>
        subsystem.authors.isOwner(id, readOwnerAccount()?.id ?? null)
          ? (readOwnerAccount()?.name ?? null)
          : (subsystem.authors.getById(id)?.displayName ?? null),
      announce: (id, input) => {
        subsystem.service.postFileChangeEvent(id, input);
        options.onFileAnnouncement?.(id, input);
      },
      uploadStagingRoot: () => path.join(dir, '.temp', 'room-uploads'),
      files,
    });
    setRoomFileEditor(editor);
    let principals: ConnectorRuntimePrincipalService | undefined;
    if (native) {
      const originalDb = db;
      const installationOwner = () => docInstallationOwner('original-room-owning-fixture');
      // Same native SQL policy as the existing original native launch fixture.
      // No runtime principal is minted or supplied by this owner-only focus control.
      principals = new ConnectorRuntimePrincipalService({
        db: originalDb,
        authority: {
          authorizeTurn: async (input) => {
            const agent = originalDb
              .select()
              .from(agents)
              .where(eq(agents.projectPath, input.agentPath))
              .get();
            const session = originalDb
              .select()
              .from(sessionMetadata)
              .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
              .get();
            if (
              !agent ||
              agent.status !== 'active' ||
              agent.runtime !== input.runtime ||
              !session ||
              session.agentPath !== input.agentPath ||
              session.runtime !== input.runtime ||
              input.canonicalCwd !== input.agentPath
            )
              throw new Error('Original native agent/session unavailable');
            return { owner: installationOwner(), agentId: agent.id };
          },
          revalidateTurn: async (claims) => {
            const agent = originalDb
              .select()
              .from(agents)
              .where(eq(agents.id, claims.agentId))
              .get();
            const session = originalDb
              .select()
              .from(sessionMetadata)
              .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
              .get();
            return (
              !!agent &&
              agent.status === 'active' &&
              agent.projectPath === claims.agentPath &&
              agent.runtime === claims.runtime &&
              !!session &&
              session.agentPath === claims.agentPath &&
              session.runtime === claims.runtime &&
              JSON.stringify(claims.owner) === JSON.stringify(installationOwner())
            );
          },
        },
      });
      await principals.initializeBoot();
    }
    http = createDocChannelHttpComposition({
      db,
      documents: subsystem.canvasDocuments,
      rooms: subsystem.service,
      roomStore: subsystem.store,
      roomRepos: repos,
      approvals: new ApprovalService(db),
      roomRepoService: repo,
      roomFileEditor: editor,
      roomMergeService: merge,
      roomWorktreeManager: manager,
      installationId: 'original-room-owning-fixture',
      ...(native ? { roomConstruction: native.serverNativeRoomConstruction } : {}),
      ...(principals ? { nativeRuntimePrincipals: principals } : {}),
      owningFileWrites: { channels, fileWrites: owner },
    });
    capturedStop = http.stopFileWrites.bind(http);
    capturedCheckboxStop = http.stopCheckboxWrites.bind(http);
    if (native) {
      const due = currentRoomDueServicePort(http.service);
      capturedDueStop = due.stopPump.bind(due);
    }
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
    app.use('/api/rooms', roomsRouter);
    app.use(errorHandler);
    if (options.seed !== false) {
      const enabled = await request(server!)
        .post(`/api/rooms/${room.id}/repo`)
        .set('Authorization', `Bearer ${ownerKey.key}`);
      expect(enabled.status).toBe(201);
      expect(enabled.body.repo.roomId).toBe(room.id);
    }
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
      merge,
      files,
      editor,
      http,
      close,
      stopWrites,
      commitAll: (checkout, message, identity) =>
        withRecognizedInstallationRoomNamespace(writer, room.id, (scope) =>
          commitAll(
            checkout,
            message,
            identity,
            repos.homeDir(room.id),
            readInstallationRoomMutationContext(writer, room.id, scope)
          )
        ),
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
