import { initBoundary } from '../../../../../lib/boundary.js';
import { rawByteHash } from '../checkbox-bytes.js';
import { currentRoomDueServicePort } from '../../service.js';
import { stopInstallationFileWrites } from '../installation-file-writes.js';
/** Real FILE SQLite, owner singleton, source files and consumed operator approval. */
import { vi } from 'vitest';
import { openServerDatabase } from '@dorkos/db/internal-server';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import { docInstallationOwner } from '../../current/doc-source-policy.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agents, user, authors, eq, sessionMetadata, createDb, runMigrations } from '@dorkos/db';
import { initAuth, readOwnerAccount } from '../../../../core/auth/index.js';
import { env } from '../../../../../env.js';
import { ApprovalService } from '../../../../core/approvals/approval-service.js';
import { createRoomSubsystem, resolveOperatorAuthor } from '../../../../rooms/index.js';
import { RoomTurnBudget } from '../../../../rooms/limits/turn-budget.js';
import { createTurnBudgetLimits } from '../../../../rooms/limits/room-limits.js';
import { RoomRepoStore } from '../../../../rooms/repo/room-repo-store.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import {
  createDocChannelHttpComposition,
  readDocSourceDescriptor,
} from '../../http-composition.js';
import { DocChannelGrants } from '../../grants.js';
import { DocCheckboxAuthority } from '../authority.js';
import { observeCheckboxSource } from '../authority-snapshot.js';
import type { CheckboxRequest } from '../checkbox-evidence.js';

/** Explicit portable fixture shape over real production service instances. */
export interface AuthorityFixture {
  dir: string;
  file: string;
  path: string;
  scope: string;
  db: import('@dorkos/db').Db;
  rooms: import('../../../../rooms/index.js').RoomSubsystem;
  roomRepos: RoomRepoStore;
  approvals: ApprovalService;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  grants: DocChannelGrants;
  granted: { kind: 'granted'; grant: import('../../store.js').DocGrantRow };
  actor: import('../../authorization.js').DocChannelActor;
  runtime: import('../../authorization.js').DocChannelActor;
  input: CheckboxRequest;
  authority: DocCheckboxAuthority;
  deps: import('../authority.js').CheckboxAuthorityDependencies;
  binding: import('../checkbox-evidence.js').VerifiedCheckboxAuthority['binding'];
  setGrantClock: (clock: () => Date) => void;
  setGrantTrace: (trace: (phase: string) => void) => void;
  setRuntimeLive: (value: boolean) => void;
  cleanup: () => Promise<void>;
}
/** No mocked policy/grant/approval rows: only a trusted test runtime-binding boundary. */
export async function authorityFixture(
  roomSource = false,
  userOwner = false,
  agentRoute = false,
  routePattern: 'md.task.toggled' | 'md.*' = 'md.task.toggled',
  persistence: {
    content?: string;
    existing?: { dir: string; documentId: string; grantId: string };
  } = {}
): Promise<AuthorityFixture> {
  const dir =
    persistence.existing?.dir ??
    (await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'checkbox-authority-'))));
  await initBoundary(dir);
  const file = join(dir, 'db.sqlite');
  const db = createDb(file);
  runMigrations(db);
  initAuth(db, dir);
  const path = join(dir, 'tasks.md');
  if (!persistence.existing) await fs.writeFile(path, persistence.content ?? '- [ ] actual task\n');
  const now = () => new Date();
  if (userOwner && !persistence.existing)
    db.insert(user)
      .values({
        id: 'original-user',
        name: 'Original',
        email: 'original@example.test',
        updatedAt: new Date(),
      })
      .run();
  const owner = userOwner
    ? { kind: 'user' as const, userId: 'original-user' }
    : { kind: 'local_install' as const, installationId: 'authority-install' };
  const actor = {
    surface: 'http' as const,
    principal: createServerPrincipal({ kind: 'operator', owner }),
  };
  let runtimeLive = true;
  const runtime = {
    surface: 'capability' as const,
    principal: createServerPrincipal({
      kind: 'runtime',
      owner,
      bindingId: 'verified-live-turn',
      runtime: 'codex',
      canonicalSessionId: 'session-a',
      agentId: 'a',
      agentPath: dir,
    }),
  };
  if (!persistence.existing) {
    db.insert(agents)
      .values({
        id: 'a',
        name: 'Actual agent',
        projectPath: dir,
        runtime: 'codex',
        ...(agentRoute ? { status: 'active' as const } : {}),
        registeredAt: now().toISOString(),
        updatedAt: now().toISOString(),
      })
      .run();
    db.insert(sessionMetadata)
      .values({
        sessionId: 'session-a',
        agentPath: dir,
        runtime: 'codex',
        createdAt: now().toISOString(),
      })
      .run();
  }
  const rooms = createRoomSubsystem({ db });
  const roomRepos = new RoomRepoStore(db, dir);
  const approvals = new ApprovalService(db);
  const http = createDocChannelHttpComposition({
    db,
    documents: rooms.canvasDocuments,
    rooms: rooms.service,
    roomStore: rooms.store,
    roomRepos,
    approvals,
    installationId: 'authority-install',
    runtimePrincipalCurrent: () => runtimeLive,
    revalidateRuntime: async () => runtimeLive,
  });
  let scope = 'session:session-a',
    sourceAuthor = agentRoute ? 'agent' : 'owner';
  if (roomSource && !persistence.existing) {
    const human = rooms.authors.localHuman();
    const room = rooms.service.createRoom(
      { kind: 'channel', slug: 'actual-tasks', members: [], agentPaths: [dir] },
      human.id
    );
    scope = `room:${room.id}`;
    sourceAuthor = db.select().from(authors).where(eq(authors.naturalKey, dir)).get()!.id;
  }
  const documentId =
    persistence.existing?.documentId ??
    rooms.canvas.open(
      scope,
      sourceAuthor,
      { type: 'markdown', content: '- [ ] actual task\n', sourcePath: path },
      {
        tree: { resolvedCwd: dir, treeKind: 'agent-cwd', sourceLabel: null, aheadOfMain: null },
        ...(agentRoute ? { principal: runtime.principal } : {}),
      }
    ).id;
  const observed = await observeCheckboxSource(
    () => readDocSourceDescriptor({ db, documents: rooms.canvasDocuments, roomRepos }, documentId),
    () => {
      if (db.$client.inTransaction) throw new Error('FS inside SQL');
      return undefined;
    }
  );
  const binding = {
    operation: 'checkbox-toggle' as const,
    sourceIdentity: observed.descriptor.sourceIdentity!,
    resolvedCwd: dir,
    treeKind: 'agent-cwd' as const,
    canonicalPath: path,
  };
  // Existing composition has no write resolver. Supply the genuine outside-SQL observation explicitly,
  // only for approval preparation; this does not enable any production route.
  let grantClock = now;
  let grantTrace: (phase: string) => void = () => {};
  const originalGrantAuthority = http.grantAuthority;
  const grants = new DocChannelGrants({
    db,
    store: http.channels,
    approvals,
    authority: {
      ...originalGrantAuthority,
      resolveWriteBinding: () => binding,
      resolveScope: (...args) => {
        grantTrace('scope');
        return originalGrantAuthority.resolveScope(...args);
      },
      resolveTarget: (...args) => {
        grantTrace('target');
        return originalGrantAuthority.resolveTarget(...args);
      },
      originCurrent: (...args) => {
        grantTrace('origin');
        return originalGrantAuthority.originCurrent(...args);
      },
    },
    now: () => grantClock(),
  });
  let granted: AuthorityFixture['granted'];
  if (persistence.existing) {
    const originalGrant = http.channels.getGrant(persistence.existing.grantId);
    if (!originalGrant || originalGrant.documentId !== documentId)
      throw new Error('Original persisted approval grant missing.');
    granted = { kind: 'granted', grant: originalGrant };
    const originalChannel = http.channels.getChannel(documentId);
    if (!originalChannel) throw new Error('Original persisted document channel missing.');
    scope = originalChannel.scope;
  } else {
    grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'checkbox',
            on: routePattern,
            to: agentRoute ? 'agent:owner' : 'log',
            turn: agentRoute ? { mode: 'immediate', maxBatch: 1 } : { mode: 'none' },
          },
        ],
      },
      actor,
      agentRoute ? 'a' : undefined
    );
    const request = {
      documentId,
      routeId: 'checkbox',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      write: binding,
    };
    const pending = grants.grant(request, actor);
    if (pending.kind !== 'approval_required') throw new Error('Actual operator approval required');
    approvals.grant(pending.ticket.approvalId);
    const consumed = grants.grant(request, actor, pending.ticket.token);
    if (consumed.kind !== 'granted') throw new Error('Actual consumed approval missing');
    granted = consumed;
  }
  const deps = {
    db,
    documents: rooms.canvasDocuments,
    roomRepos,
    rooms: rooms.service,
    authorization: http.authorization,
    grants,
    store: http.channels,
    installationId: 'authority-install',
    now,
  };
  const authority = new DocCheckboxAuthority(deps);
  const input: CheckboxRequest = {
    documentId,
    eventId: randomUUID(),
    expectedFileVersion: 'opaque-server-version',
    line: 1,
    textHash: 'a'.repeat(64),
    done: true,
  };
  return {
    dir,
    file,
    path,
    scope,
    db,
    rooms,
    roomRepos,
    approvals,
    http,
    grants,
    granted,
    actor,
    runtime,
    input,
    authority,
    deps,
    binding,
    setGrantClock: (clock) => {
      grantClock = clock;
    },
    setGrantTrace: (trace) => {
      grantTrace = trace;
    },
    setRuntimeLive: (value: boolean) => {
      runtimeLive = value;
    },
    cleanup: async () => {
      db.$client.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** Same genuine FILE-configured principal assembly for first boot and actual reopening. */
function nativeFixturePrincipals(
  db: import('@dorkos/db').Db,
  target: {
    installationId: string;
    agentId: string;
    agentPath: string;
    runtime: 'claude-code' | 'codex' | 'opencode';
    canonicalSessionId: string;
  }
) {
  const { installationId, agentId, agentPath } = target;
  const owner = () => docInstallationOwner(installationId);
  return new ConnectorRuntimePrincipalService({
    db,
    authority: {
      authorizeTurn: async (input) => {
        const actual = db.select().from(agents).where(eq(agents.id, agentId)).get();
        const session = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
          .get();
        if (
          !actual ||
          actual.status !== 'active' ||
          actual.projectPath !== input.agentPath ||
          actual.runtime !== input.runtime ||
          !session ||
          session.agentPath !== input.agentPath ||
          session.runtime !== input.runtime ||
          input.canonicalCwd !== agentPath
        )
          throw new Error('Actual native target unavailable.');
        return { owner: owner(), agentId: actual.id };
      },
      revalidateTurn: async (claims) => {
        const actual = db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
        const session = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
          .get();
        const expected = owner();
        return (
          !!actual &&
          actual.status === 'active' &&
          actual.projectPath === claims.agentPath &&
          actual.runtime === claims.runtime &&
          !!session &&
          session.agentPath === claims.agentPath &&
          session.runtime === claims.runtime &&
          JSON.stringify(expected) === JSON.stringify(claims.owner)
        );
      },
    },
  });
}

/** Distinct native Room assembly. No runtime principal is constructed from a DTO. */
/** Portable names expose fixture DATA/services, never construct native authority. */
export interface NativeRoomAuthorityFixture {
  readonly serverNativeRelayConstruction: import('@dorkos/db/internal-server').ServerNativeRelayConstruction;
  dir: string;
  file: string;
  db: import('@dorkos/db').Db;
  rooms: import('../../../../rooms/index.js').RoomSubsystem;
  budget: RoomTurnBudget;
  approvals: ApprovalService;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  principals: ConnectorRuntimePrincipalService;
  originalTarget: {
    installationId: string;
    agentId: string;
    agentPath: string;
    runtime: 'claude-code' | 'codex' | 'opencode';
    canonicalSessionId: string;
  };
  operator: import('../../authorization.js').DocChannelActor;
  documentId: string;
  roomId: string;
  authorId: string;
  granted: { kind: 'granted'; grant: import('../../store.js').DocGrantRow };
  checkboxPath: string | undefined;
  checkboxRequest(done: boolean, eventId?: string): Promise<CheckboxRequest>;
  cleanup(): Promise<void>;
}
export interface NativeCommittedCodexRoomFixture extends NativeRoomAuthorityFixture {
  input: { v: 1; id: string; type: string; payload: { text: string } };
  accepted: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelEventReceipt;
  admission: { admission_id: string; status: string; outcome: string | null };
  runtime: import('../../../../runtimes/codex/codex-runtime.js').CodexRuntime;
  prepared: import('../../current/current-operation-types.js').PreparedRoomResponder;
  committed: import('../../current/current-operation-types.js').OriginalCommittedRoomResponder;
  nativeOperation: object;
}
export interface ReopenedNativeRoomAuthorityFixture {
  db: import('@dorkos/db').Db;
  rooms: import('../../../../rooms/index.js').RoomSubsystem;
  principals: ConnectorRuntimePrincipalService;
  http: ReturnType<typeof createDocChannelHttpComposition>;
  cleanup(): Promise<void>;
}

export async function nativeRoomAuthorityFixture(
  agentPath: string,
  runtime: 'claude-code' | 'codex' | 'opencode',
  canonicalSessionId: string,
  agentId: string,
  options: { checkboxFile?: boolean; coalesceWindowMs?: number } = {}
): Promise<NativeRoomAuthorityFixture> {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-room-authority-')));
  const file = join(dir, 'db.sqlite');
  let returnedDb: import('@dorkos/db').Db | undefined;
  let returnedHttp: ReturnType<typeof createDocChannelHttpComposition> | undefined;
  try {
    // The genuine installation owner captures this original filesystem boundary.
    // Establish it before creating any owning writer; checkbox source stays inside it.
    await initBoundary(agentPath);
    const opened = openServerDatabase(file);
    const db = opened.db;
    returnedDb = db;
    runMigrations(db);
    const auth = initAuth(db, dir);
    // Onboard the actual first account through the original auth handler. The
    // Room pre-effect witness requires its real owner row, not a fixture DTO.
    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const signup = await auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({
          name: 'Native Room Owner',
          email: 'native-room-owner@fixture.test',
          password: 'original-native-owner-password',
        }),
      })
    );
    await signup.arrayBuffer();
    if (signup.status !== 200 || !readOwnerAccount())
      throw new Error('Original native Room owner signup did not complete.');
    const installationId = 'native-room-install';
    const owner = () => docInstallationOwner(installationId);
    const operator = {
      surface: 'http' as const,
      principal: createServerPrincipal({ kind: 'operator', owner: owner() }),
    };
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: agentId,
        name: 'Native Room agent',
        projectPath: agentPath,
        runtime,
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(sessionMetadata)
      .values({ sessionId: canonicalSessionId, agentPath, runtime, createdAt: now })
      .run();
    const budget = new RoomTurnBudget({
      db,
      limits: createTurnBudgetLimits(() => {
        throw new Error('Native fixture requires the fixed original stored Room policy.');
      }, db),
    });
    const rooms = createRoomSubsystem({ db, budget });
    const human = resolveOperatorAuthor(rooms.authors);
    const room = rooms.service.createRoom(
      { kind: 'channel', slug: 'native-room', members: [], agentPaths: [agentPath] },
      human.id
    );
    const author = db.select().from(authors).where(eq(authors.naturalKey, agentPath)).get();
    if (!author || author.mintedForManifestId !== agentId)
      throw new Error('Actual native Room author missing.');
    rooms.store.bindRoomSession(room.id, author.id, canonicalSessionId, now);
    const originalTarget = { installationId, agentId, agentPath, runtime, canonicalSessionId };
    const principals = nativeFixturePrincipals(db, originalTarget);
    await principals.initializeBoot();
    const roomRepos = new RoomRepoStore(db, dir),
      approvals = new ApprovalService(db);
    const http = createDocChannelHttpComposition({
      db,
      documents: rooms.canvasDocuments,
      rooms: rooms.service,
      roomStore: rooms.store,
      roomRepos,
      approvals,
      installationId,
      nativeRuntimePrincipals: principals,
      roomConstruction: opened.serverNativeRoomConstruction,
      runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
      revalidateRuntime: (proof) => principals.revalidatePrincipal(proof),
    });
    returnedHttp = http;
    const checkboxPath = options.checkboxFile
      ? join(agentPath, 'original-checkbox-tasks.md')
      : undefined;
    const initialContent = options.checkboxFile
      ? '- [ ] actual original task\n'
      : 'actual original source';
    if (checkboxPath) await fs.writeFile(checkboxPath, initialContent);
    const documentId = rooms.canvas.open(
      'room:' + room.id,
      checkboxPath ? author.id : human.id,
      {
        type: 'markdown',
        content: initialContent,
        ...(checkboxPath ? { sourcePath: checkboxPath } : {}),
      },
      {
        tree: {
          resolvedCwd: agentPath,
          treeKind: 'agent-cwd',
          sourceLabel: null,
          aheadOfMain: null,
        },
      }
    ).id;
    http.grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'native-room',
            on: 'md.*',
            to: 'room:self',
            turn: { mode: 'coalesce', windowMs: options.coalesceWindowMs ?? 100, maxBatch: 10 },
          },
        ],
      },
      operator,
      agentId
    );
    const request = {
      documentId,
      routeId: 'native-room',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const pending = checkboxPath
      ? await http.grantCheckboxRoute(request, operator)
      : http.grants.grant(request, operator);
    if (pending.kind !== 'approval_required')
      throw new Error('Genuine Room operator approval required.');
    approvals.grant(pending.ticket.approvalId);
    const granted = checkboxPath
      ? await http.grantCheckboxRoute(request, operator, pending.ticket.token)
      : http.grants.grant(request, operator, pending.ticket.token);
    if (granted.kind !== 'granted') throw new Error('Genuine consumed Room approval missing.');
    return {
      dir,
      file,
      db,
      serverNativeRelayConstruction: opened.serverNativeRelayConstruction,
      rooms,
      budget,
      approvals,
      http,
      principals,
      originalTarget,
      operator,
      documentId,
      roomId: room.id,
      authorId: author.id,
      granted,
      checkboxPath,
      checkboxRequest: async (done: boolean, eventId = randomUUID()): Promise<CheckboxRequest> => {
        if (!checkboxPath || db.$client.inTransaction)
          throw new Error('Actual FILE checkbox fixture unavailable.');
        const bytes = await fs.readFile(checkboxPath),
          end = bytes.indexOf(10);
        return {
          documentId,
          eventId,
          line: 1,
          done,
          expectedFileVersion: rawByteHash(bytes),
          textHash: rawByteHash(bytes.subarray(0, end < 0 ? bytes.length : end)),
        };
      },
      cleanup: async () => {
        // Original children and pump must drain before closing this native database or removing its files.
        let drainFailed = false;
        let firstDrainCause: unknown;
        const retainDrainFailure = (cause: unknown): void => {
          if (!drainFailed) {
            drainFailed = true;
            firstDrainCause = cause;
          }
        };
        await Promise.allSettled([
          Promise.resolve()
            .then(() => stopInstallationFileWrites(http.fileWrites, db, http.channels))
            .catch(retainDrainFailure),
          Promise.resolve()
            .then(() => currentRoomDueServicePort(http.service).stopPump())
            .catch(retainDrainFailure),
        ]);
        if (drainFailed) throw firstDrainCause;
        let failed = false;
        let first: unknown;
        try {
          if (db.$client.open) db.$client.close();
        } catch (cause) {
          failed = true;
          first = cause;
        }
        if (failed) throw first;
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        if (failed) throw first;
      },
    };
  } catch (cause) {
    if (returnedHttp && returnedDb) {
      const actualHttp = returnedHttp,
        actualDb = returnedDb;
      const drains = await Promise.allSettled([
        Promise.resolve().then(() =>
          stopInstallationFileWrites(actualHttp.fileWrites, actualDb, actualHttp.channels)
        ),
        Promise.resolve().then(() => currentRoomDueServicePort(actualHttp.service).stopPump()),
      ]);
      if (drains.some((value) => value.status === 'rejected')) throw cause;
    }
    let closed = true;
    try {
      if (returnedDb?.$client.open) returnedDb.$client.close();
    } catch {
      closed = false; /* Preserve the original setup cause, even undefined, and retain native resources. */
    }
    if (closed)
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* Preserve original setup cause. */
      }
    throw cause;
  }
}

/** Paid SDK behavior alone is replaced; real constructor, FILE DB and original grant custody stay genuine. */
export interface NativeRoomCodexObservation {
  readonly options: readonly unknown[];
  readonly prompts: readonly unknown[];
  releaseProducer(): void;
  completeFutureTurns(): void;
  holdFutureTurns?(): void;
  isProducerHeld?(): boolean;
}
/** Test-only composition: it cannot issue a principal or admission from caller data. */
export async function nativeCommittedCodexRoomFixture(
  observed: NativeRoomCodexObservation,
  disposition: 'settled' | 'acknowledged' | 'unpulled' | 'claimed' = 'settled'
): Promise<NativeCommittedCodexRoomFixture> {
  const agentDir = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'native-room-retention-agent-'))
  );
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  let producer: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
  let producerDone: Promise<void> | undefined;
  let prepared:
    import('../../current/current-operation-types.js').PreparedRoomResponder | undefined;
  let runtime: import('../../../../runtimes/codex/codex-runtime.js').CodexRuntime | undefined;
  let committedStream: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
  let committedFeed: Promise<void> | undefined;
  const sessionId = 'native-retention-source',
    agentId = '01JRETENTION000000000000000';
  try {
    const { initAgentIdentityService, resetAgentIdentityService, setAgentHomeRegistry } =
      await import('../../../../core/agent-identity/index.js');
    const {
      CodexRuntime,
      sendCodexOriginalLockedMessage,
      readCodexPreparedRoomResponder,
      retireCodexPreparedRoomResponder,
      startCodexCommittedRoomResponder,
    } = await import('../../../../runtimes/codex/codex-runtime.js');
    const { CodexThreadMap } = await import('../../../../runtimes/codex/thread-map.js');
    const {
      submitCurrentDocEvent,
      prepareServiceOriginalRoomResponder,
      commitServiceOriginalRoomResponder,
    } = await import('../../service.js');
    const { wakeAuthorizedRoomDue } = await import('../../authorization.js');
    const { docDocumentGeneration } = await import('../../identity/incarnation.js');
    const { canvasDocuments, connectorRuntimeBindings, sql } = await import('@dorkos/db');
    const { feedProjector } = await import('../../../../session/session-event-normalizer.js');
    const { getOrCreateProjector, disposeProjector } =
      await import('../../../../session/session-state-projector.js');
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      let failed = false,
        first: unknown;
      const attempt = async (work: () => Promise<unknown> | void) => {
        try {
          await work();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      await attempt(() => observed.releaseProducer());
      // Initiate genuine native cancellation before joining a feed that may park late.
      const retire = attempt(async () => {
        if (runtime && prepared && readCodexPreparedRoomResponder(runtime, prepared))
          await retireCodexPreparedRoomResponder(runtime, prepared);
      });
      const returned = committedStream
        ? attempt(() => committedStream!.return(undefined))
        : Promise.resolve();
      await Promise.all([retire, returned]);
      if (committedFeed) await attempt(() => committedFeed!);
      if (producer) await attempt(() => producer!.return(undefined));
      if (producerDone) await attempt(() => producerDone!);
      await attempt(() => disposeProjector(sessionId));
      await attempt(() => resetAgentIdentityService());
      await attempt(() => setAgentHomeRegistry(undefined));
      if (h) await attempt(() => h!.cleanup());
      await attempt(() => fs.rm(agentDir, { recursive: true, force: true }));
      if (failed) throw first;
    };
    try {
      await fs.mkdir(join(agentDir, '.dork'), { recursive: true });
      await fs.writeFile(
        join(agentDir, '.dork', 'agent.json'),
        JSON.stringify({
          id: agentId,
          name: 'retention-producer',
          runtime: 'codex',
          capabilities: [],
          behavior: { responseMode: 'always' },
          registeredAt: new Date().toISOString(),
          registeredBy: 'test',
        })
      );
      h = await nativeRoomAuthorityFixture(agentDir, 'codex', sessionId, agentId);
      const actual = h;
      initAgentIdentityService(h.db);
      runtime = new CodexRuntime({
        transport: 'exec',
        threadMap: new CodexThreadMap(h.db),
        resolveBinary: async () => '/bin/codex',
        defaultCwd: agentDir,
      });
      const mesh = {
        getByPath: (path: string) => {
          const row = actual.db.select().from(agents).where(eq(agents.id, agentId)).get();
          return row?.status === 'active' && row.projectPath === path
            ? { id: row.id, name: row.name }
            : undefined;
        },
        updateLastSeen: () => {},
        listWithPaths: () =>
          actual.db
            .select()
            .from(agents)
            .where(eq(agents.status, 'active'))
            .all()
            .map((row) => ({
              id: row.id,
              name: row.name,
              projectPath: row.projectPath,
              ...(row.displayName === null ? {} : { displayName: row.displayName }),
              ...(row.icon === null ? {} : { icon: row.icon }),
              ...(row.color === null ? {} : { color: row.color }),
            })),
      };
      runtime.setMeshCore(mesh);
      // Match the real bootstrap: SDK turn identity derives from registered native homes.
      setAgentHomeRegistry({
        isRegisteredHome: (path) => mesh.getByPath(path) !== undefined,
        listRegisteredHomes: () => mesh.listWithPaths().map((agent) => agent.projectPath),
        managedWorkspaceOwner: () => null, // This fixture creates no managed workspace.
        roomsDir: join(actual.dir, 'rooms'),
      });
      runtime.setConnectorRuntimeTools({
        principals: h.principals,
        listenerUrl: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
      });
      const holder = { on: () => {} };
      if (!runtime.acquireLock(sessionId, 'original-retention-producer', holder))
        throw new Error('Genuine native producer lock unavailable.');
      const beforeOptions = observed.options.length;
      producer = sendCodexOriginalLockedMessage(
        runtime,
        sessionId,
        'actual producer',
        { cwd: agentDir },
        holder,
        sessionId
      );
      if (!producer) throw new Error('Actual Codex constructor missing.');
      producerDone = (async () => {
        for await (const _ of producer!) {
        }
      })();
      // Observe the real constructor arguments; a copied bearer still cannot satisfy original native currentness.
      await vi.waitFor(() => {
        if (observed.options.length <= beforeOptions)
          throw new Error('Actual SDK constructor has not opened.');
      });
      const options = observed.options.at(-1);
      const envDescriptor =
        options && typeof options === 'object'
          ? Object.getOwnPropertyDescriptor(options, 'env')
          : undefined;
      const env = envDescriptor && 'value' in envDescriptor ? envDescriptor.value : undefined;
      const bearerDescriptor =
        env && typeof env === 'object'
          ? Object.getOwnPropertyDescriptor(env, 'DORKOS_CONNECTOR_MCP_AUTHORIZATION')
          : undefined;
      const authorization =
        bearerDescriptor && 'value' in bearerDescriptor ? bearerDescriptor.value : undefined;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
        throw new Error('Actual original SDK authorization missing.');
      const resolved = await h.principals.resolve({
        bearer: authorization.slice(7),
        expectedRuntime: 'codex',
        expectedCanonicalCwd: agentDir,
      });
      if (resolved.status !== 'resolved')
        throw new Error('Actual native producer principal unavailable.');
      const document = h.db
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, h.documentId))
        .get()!;
      const channel = h.http.channels.getChannel(h.documentId)!;
      const input = {
        v: 1 as const,
        id: randomUUID(),
        type: 'md.comment',
        payload: { text: 'original retained 🦉 東京' },
      };
      const accepted = await submitCurrentDocEvent(
        h.http.service,
        h.documentId,
        input,
        { surface: 'capability', principal: resolved.principal },
        { expectedGeneration: docDocumentGeneration(document, channel) }
      );
      if (accepted.receipt.id !== input.id)
        throw new Error('Original acceptance identity changed.');
      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      wakeAuthorizedRoomDue(h.http.authorization);
      observed.releaseProducer();
      await producerDone;
      prepared = await prepareServiceOriginalRoomResponder(
        h.http.service,
        runtime,
        holder,
        sessionId
      );
      if (!prepared) throw new Error('Genuine native responder preparation unavailable.');
      const originalPrepared = readCodexPreparedRoomResponder(runtime, prepared);
      if (!originalPrepared) throw new Error('Original constructor preparation missing.');
      const bindingCount = h.db.select().from(connectorRuntimeBindings).all().length;
      const spendCount = h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n;
      const committed = commitServiceOriginalRoomResponder(h.http.service, runtime, prepared);
      if (
        h.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM room_turn_spend`)!.n !==
        spendCount + 1
      )
        throw new Error('Genuine SAMEbudget native COMMIT missing.');
      observed.completeFutureTurns();
      if (disposition === 'acknowledged') {
        if (!observed.holdFutureTurns || !observed.isProducerHeld)
          throw new Error('Original acknowledged fixture needs an actual held SDK transport.');
        observed.holdFutureTurns();
      }
      if (disposition === 'claimed') {
        // Close the genuine native preparation without starting a model or forging a terminal.
        // Its durable claim remains the real committed uncertainty for the next FILE boot.
        await retireCodexPreparedRoomResponder(runtime, prepared);
      } else {
        committedStream = startCodexCommittedRoomResponder(runtime, prepared, committed);
        if (disposition === 'unpulled') await committedStream.return(undefined);
        else {
          committedFeed = feedProjector(getOrCreateProjector(sessionId), committedStream, {
            originalRoomStream: committedStream,
          });
          void committedFeed.catch(() => {});
          if (disposition === 'acknowledged') {
            await vi.waitFor(() => {
              if (!observed.isProducerHeld!())
                throw new Error('Original SDK responder is not held.');
            });
            const live = readCodexPreparedRoomResponder(runtime, prepared);
            if (!live) throw new Error('Actual committed responder stopped before acknowledgment.');
            const { readInstallationOriginalRoomEmitter } =
              await import('../installation-file-writes.js');
            const { sendOriginalRoomResponderEvent } =
              await import('../../downstream/native-room-emitter.js');
            const emitter = readInstallationOriginalRoomEmitter(
              h.http.fileWrites,
              h.db,
              h.http.channels,
              h.principals
            );
            let failed = false,
              first: unknown;
            try {
              await sendOriginalRoomResponderEvent(
                emitter,
                committed,
                runtime,
                prepared,
                live.nativeOperation,
                {
                  documentId: h.documentId,
                  roomId: h.roomId,
                  eventId: randomUUID(),
                  type: 'app.ack',
                  payload: {
                    batchId: accepted.deliveries[0]!.batchId!,
                    routeId: accepted.deliveries[0]!.routeId,
                    eventIds: [input.id],
                    outcome: 'handled',
                  },
                }
              );
            } catch (cause) {
              failed = true;
              first = cause;
            }
            try {
              observed.releaseProducer();
            } catch (cause) {
              if (!failed) {
                failed = true;
                first = cause;
              }
            }
            try {
              await committedFeed;
            } catch (cause) {
              if (!failed) {
                failed = true;
                first = cause;
              }
            }
            if (failed) throw first;
            const delivery = h.http.channels.listDeliveries(h.documentId, input.id)[0];
            if (delivery?.ackOutcome !== 'handled')
              throw new Error('Original native acknowledgment missing.');
          } else await committedFeed;
        }
      }
      const admission = h.db.get<{ admission_id: string; status: string; outcome: string | null }>(
        sql`SELECT admission_id,status,outcome FROM room_doc_admissions WHERE document_id=${h.documentId}`
      );
      if (
        !admission ||
        admission.status !==
          (disposition === 'settled' || disposition === 'acknowledged'
            ? 'settled'
            : disposition === 'claimed'
              ? 'claimed'
              : 'in_doubt')
      )
        throw new Error('Actual native disposition missing.');
      if (h.db.select().from(connectorRuntimeBindings).all().length !== bindingCount)
        throw new Error('Responder opened a second native turn.');
      return {
        ...h,
        input,
        accepted,
        admission,
        runtime,
        prepared,
        committed,
        nativeOperation: originalPrepared.nativeOperation,
        cleanup,
      };
    } catch (cause) {
      try {
        await cleanup();
      } catch {} // Setup failure stays the exact first cause, including undefined.
      throw cause;
    }
  } catch (cause) {
    try {
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch {}
    throw cause;
  }
}

/** Reopen the actual FILE through a new native construction, without inserting source/authority rows. */
export async function reopenNativeRoomAuthorityFixture(
  original: NativeRoomAuthorityFixture
): Promise<ReopenedNativeRoomAuthorityFixture> {
  if (original.db.$client.open)
    throw new Error('Original FILE must be closed before genuine native reopening.');
  let returnedDb: import('@dorkos/db').Db | undefined;
  let returnedHttp: ReturnType<typeof createDocChannelHttpComposition> | undefined;
  const drainOriginalChildren = async (
    http: ReturnType<typeof createDocChannelHttpComposition>,
    db: import('@dorkos/db').Db
  ) => {
    let failed = false;
    let first: unknown;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    await Promise.allSettled([
      Promise.resolve()
        .then(() => stopInstallationFileWrites(http.fileWrites, db, http.channels))
        .catch(remember),
      Promise.resolve()
        .then(() => currentRoomDueServicePort(http.service).stopPump())
        .catch(remember),
    ]);
    if (failed) throw first;
  };
  try {
    const opened = openServerDatabase(original.file);
    const db = opened.db;
    returnedDb = db;
    runMigrations(db);
    initAuth(db, original.dir);
    const rooms = createRoomSubsystem({ db });
    const principals = nativeFixturePrincipals(db, original.originalTarget);
    await principals.initializeBoot();
    const roomRepos = new RoomRepoStore(db, original.dir);
    const approvals = new ApprovalService(db);
    const http = createDocChannelHttpComposition({
      db,
      documents: rooms.canvasDocuments,
      rooms: rooms.service,
      roomStore: rooms.store,
      roomRepos,
      approvals,
      installationId: original.originalTarget.installationId,
      nativeRuntimePrincipals: principals,
      roomConstruction: opened.serverNativeRoomConstruction,
      runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
      revalidateRuntime: (proof) => principals.revalidatePrincipal(proof),
    });
    returnedHttp = http;
    let cleanup: Promise<void> | undefined;
    return {
      db,
      rooms,
      principals,
      http,
      cleanup: () => {
        if (cleanup) return cleanup;
        // Retain the memo before any original child drain can reenter.
        cleanup = Promise.resolve().then(async () => {
          await drainOriginalChildren(http, db);
          if (db.$client.open) db.$client.close();
        });
        return cleanup;
      },
    };
  } catch (cause) {
    // Unknown partial construction cannot authorize disposal. Keep the original
    // setup cause, Db and persisted native/source evidence for owner recovery.
    if (returnedDb && returnedHttp) {
      let closed = false;
      try {
        await drainOriginalChildren(returnedHttp, returnedDb);
        closed = true;
      } catch {
        /* UNKNOWN retains Db. */
      }
      if (closed)
        try {
          if (returnedDb.$client.open) returnedDb.$client.close();
        } catch {
          /* Keep setup first cause, no retry. */
        }
    }
    throw cause;
  }
}
