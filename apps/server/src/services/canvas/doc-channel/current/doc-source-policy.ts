/** Current source and owner row policies without HTTP or room orchestration initialization. */
import { agents, authors, eq, type Db, type DbTransaction } from '@dorkos/db';
import {
  readPreparedPhysicalDocument,
  readPreparedSourceSession,
} from '../readers/prepared-readers.js';
import { UiCanvasContentSchema } from '@dorkos/shared/schemas';
import { readOwnerAccount } from '../../../core/auth/index.js';
import type { ConnectorOwnerAuthority } from '../../../connectors/principal/server-principal.js';
import {
  readOwnedRoomRepoSource,
  readOwnedRoomRepoTransactionSource,
  type RoomRepoStore,
} from '../../../rooms/repo/room-repo-store.js';
import { join } from 'node:path';
import type { CanvasDocumentStore } from '../../canvas-document-store.js';
import { canvasSourcePath } from '../../document-key.js';
import { parseScope } from '../../scopes.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { DocRouteGrantError } from '../grant-policy.js';

/** Read the actual current install owner, sharing the existing local-install/account policy. */
export function docInstallationOwner(installationId: string): ConnectorOwnerAuthority {
  const owner = readOwnerAccount();
  return owner ? { kind: 'user', userId: owner.id } : { kind: 'local_install', installationId };
}
/** Exact persisted/current owner equality, shared by HTTP and original write authority. */
export function sameDocOwnerAuthority(recorded: unknown, owner: ConnectorOwnerAuthority): boolean {
  if (!recorded || typeof recorded !== 'object' || !('kind' in recorded)) return false;
  return owner.kind === 'user'
    ? recorded.kind === 'user' && 'userId' in recorded && recorded.userId === owner.userId
    : recorded.kind === 'local_install' &&
        'installationId' in recorded &&
        recorded.installationId === owner.installationId;
}

/** Pure server-owned source inputs shared by legacy HTTP reads and async write observations. */
export interface DocSourceDescriptor {
  id: string;
  scope: string;
  openedAt: string;
  authorId: string;
  sourceIdentity: string | null;
  sourcePath: string | null;
  resolvedCwd: string | null;
  treeKind: string | null;
  rootCandidate: string | null;
  matchRoot: string | null;
  allowedRoot: string | null;
}
/** Same authoritative stores as HTTP composition; methods here must read current rows, not cached grants. */
export interface DocSourceDependencies {
  db: Db;
  documents: CanvasDocumentStore;
  roomRepos: RoomRepoStore;
}
function synchronousSource<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    void Promise.resolve(value).catch(() => {});
    throw new Error('Document source descriptors must be synchronous.');
  }
  return value;
}
/** Read source binding and current tree policy WITHOUT filesystem calls, including inside a supplied tx. */
export function readDocSourceDescriptor(
  deps: DocSourceDependencies,
  documentId: string,
  tx?: DbTransaction
): DocSourceDescriptor {
  const executor = tx ?? deps.db;
  const physical = readPreparedPhysicalDocument(executor, documentId);
  if (!physical) throw new DocChannelNotFoundError();
  const scope = synchronousSource(deps.documents.lifecycle.resolveScope(physical.scope));
  const content = UiCanvasContentSchema.parse(physical.content);
  const sourcePath = canvasSourcePath(content);
  if (
    !sourcePath &&
    'url' in content &&
    typeof content.url === 'string' &&
    content.url.startsWith('file:')
  )
    throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
  const result: DocSourceDescriptor = {
    id: physical.id,
    scope,
    openedAt: physical.openedAt,
    authorId: physical.authorId,
    sourceIdentity: physical.sourceKey,
    sourcePath,
    resolvedCwd: physical.resolvedCwd,
    treeKind: physical.treeKind,
    rootCandidate: physical.resolvedCwd,
    matchRoot: null,
    allowedRoot: null,
  };
  if (!sourcePath) return result;
  const parsed = parseScope(scope);
  if (parsed.kind === 'session') {
    const session = readPreparedSourceSession(executor, parsed.id);
    if (!session?.agentPath) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    result.rootCandidate = session.agentPath;
    result.matchRoot = physical.resolvedCwd;
  } else if (parsed.kind === 'room') {
    if (!physical.resolvedCwd) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    if (physical.treeKind === 'room-main' || physical.treeKind === 'worktree') {
      const original = tx
        ? readOwnedRoomRepoTransactionSource(deps.roomRepos, deps.db, parsed.id)
        : readOwnedRoomRepoSource(deps.roomRepos, deps.db, parsed.id);
      if (!original.row) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      result.allowedRoot =
        physical.treeKind === 'room-main' ? original.repo : join(original.home, 'worktrees');
    } else {
      const author = executor.select().from(authors).where(eq(authors.id, physical.authorId)).get();
      const agent =
        author?.kind === 'agent'
          ? executor.select().from(agents).where(eq(agents.projectPath, author.naturalKey)).get()
          : undefined;
      if (!agent || agent.status !== 'active')
        throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      result.matchRoot = agent.projectPath;
    }
  }
  if (!result.rootCandidate) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
  return result;
}
