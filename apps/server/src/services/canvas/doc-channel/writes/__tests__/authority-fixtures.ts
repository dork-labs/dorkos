/** Real FILE SQLite, owner singleton, source files and consumed operator approval. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agents, user, authors, eq, sessionMetadata, createDb, runMigrations } from '@dorkos/db';
import { initAuth } from '../../../../core/auth/index.js';
import { ApprovalService } from '../../../../core/approvals/approval-service.js';
import { createRoomSubsystem } from '../../../../rooms/index.js';
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
  const grants = new DocChannelGrants({
    db,
    store: http.channels,
    approvals,
    authority: { ...http.grantAuthority, resolveWriteBinding: () => binding },
    now,
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
    setRuntimeLive: (value: boolean) => {
      runtimeLive = value;
    },
    cleanup: async () => {
      db.$client.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
