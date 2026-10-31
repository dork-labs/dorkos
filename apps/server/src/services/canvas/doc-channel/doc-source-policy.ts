/** Current source and owner row policies without HTTP or room orchestration initialization. */
import { agents, authors, eq, type Db, type DbTransaction } from '@dorkos/db';
import {
  readPreparedPhysicalDocument,
  readPreparedSourceSession,
} from './readers/prepared-readers.js';
import { UiCanvasContentSchema } from '@dorkos/shared/schemas';
import { readOwnerAccount } from '../../core/auth/index.js';
import type { ConnectorOwnerAuthority } from '../../connectors/principal/server-principal.js';
import type { RoomRepoStore } from '../../rooms/repo/room-repo-store.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import { canvasSourcePath } from '../document-key.js';
import { parseScope } from '../scopes.js';
import { DocChannelNotFoundError } from './authorization.js';
import { DocRouteGrantError } from './grant-policy.js';

/** Read the actual current install owner, sharing the existing local-install/account policy. */
export function docInstallationOwner(installationId: string): ConnectorOwnerAuthority {
  const owner = readOwnerAccount();
  return owner ? { kind: 'user', userId: owner.id } : { kind: 'local_install', installationId };
}
/**
 * Whether `recorded` names this installation (`local_install` with its id).
 *
 * The connector runtime mints every agent-turn proof with this owner, whether
 * or not an owner account exists, so an agent-turn proof is checked against it
 * rather than against the account: without that, an agent could never
 * configure or approve a document route once its person had created an account.
 *
 * @param recorded - The owner a server-minted proof, or its persisted copy, carries.
 * @param installationId - This server's installation id.
 */
export function isInstallationAuthority(recorded: unknown, installationId: string): boolean {
  return (
    !!recorded &&
    typeof recorded === 'object' &&
    'kind' in recorded &&
    recorded.kind === 'local_install' &&
    'installationId' in recorded &&
    recorded.installationId === installationId
  );
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
/**
 * Which root a session document's file may resolve under.
 *
 * - `agent`: the session's registered agent directory, and nothing else.
 * - `agent-or-recorded-cwd`: the agent directory when the session has one; for a
 *   session with no agent, the directory the server itself recorded for the
 *   document when the session opened it (`resolvedCwd`). Never a caller's path.
 */
type SessionSourceRoot = 'agent' | 'agent-or-recorded-cwd';

/** Read source binding and current tree policy WITHOUT filesystem calls, including inside a supplied tx. */
function readSourceDescriptor(
  deps: Pick<DocSourceDependencies, 'db' | 'documents'> &
    Partial<Pick<DocSourceDependencies, 'roomRepos'>>,
  documentId: string,
  tx: DbTransaction | undefined,
  sessionRoot: SessionSourceRoot
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
    if (session?.agentPath) {
      result.rootCandidate = session.agentPath;
      result.matchRoot = physical.resolvedCwd;
    } else if (session && sessionRoot === 'agent-or-recorded-cwd' && physical.resolvedCwd) {
      // A chat with no agent has no agent directory to confine the file to, so
      // its root is the folder the server recorded when the session opened the
      // document. The row is reread on every check: binding the session to an
      // agent later moves the root to that agent and refuses a stale capture.
      //
      // Descriptors compare as strings, never resolved paths: this reader makes
      // no filesystem calls because it runs inside SQLite transactions. So if
      // the chat later gets an agent whose path spells the same folder another
      // way (`/tmp/x` against a recorded `/private/tmp/x`), save evidence
      // recorded before the binding no longer matches and its recovery answers
      // "not available". That is fail-closed by design; a new save works.
      result.rootCandidate = physical.resolvedCwd;
      result.matchRoot = physical.resolvedCwd;
    } else {
      throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    }
  } else if (parsed.kind === 'room') {
    if (!physical.resolvedCwd) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    if (physical.treeKind === 'room-main' || physical.treeKind === 'worktree') {
      if (!deps.roomRepos || !synchronousSource(deps.roomRepos.getRow(parsed.id)))
        throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      result.allowedRoot =
        physical.treeKind === 'room-main'
          ? deps.roomRepos.repoPath(parsed.id)
          : deps.roomRepos.worktreesPath(parsed.id);
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

/** Existing general source policy, preserving Room callers unchanged. */
export function readDocSourceDescriptor(
  deps: DocSourceDependencies,
  documentId: string,
  tx?: DbTransaction
): DocSourceDescriptor {
  return readSourceDescriptor(deps, documentId, tx, 'agent');
}

/**
 * Ordinary document saves read only current session/agent-cwd source policy, without Room dependencies.
 *
 * A session with no agent falls back to the document's server-recorded folder
 * (see {@link SessionSourceRoot}). A source this policy will not admit is the
 * save path's usual disclosure-safe "not available", never a server fault.
 */
export function readSessionDocSourceDescriptor(
  deps: Pick<DocSourceDependencies, 'db' | 'documents'>,
  documentId: string,
  tx?: DbTransaction
): DocSourceDescriptor {
  let source: DocSourceDescriptor;
  try {
    source = readSourceDescriptor(deps, documentId, tx, 'agent-or-recorded-cwd');
  } catch (error) {
    if (error instanceof DocRouteGrantError) throw new DocChannelNotFoundError({ cause: error });
    throw error;
  }
  if (parseScope(source.scope).kind !== 'session') throw new DocChannelNotFoundError();
  return source;
}
