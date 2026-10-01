/** Production HTTP composition over the existing canvas, room, owner and approval services. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  agents,
  agentIdentityTokens,
  authors,
  sessionMetadata,
  and,
  eq,
  isNull,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { DocChannelHttp } from '../../../routes/canvas-doc-events.js';
import { resolveCaller } from '../../../routes/room-caller.js';
import { getRequestAgentIdentity } from '../../../middleware/agent-identity.js';
import { isContained } from '../../../lib/boundary.js';
import { readOwnerAccount, type RequestUser } from '../../core/auth/index.js';
import {
  TOKEN_ABSOLUTE_TTL_MS,
  TOKEN_IDLE_TTL_MS,
} from '../../core/agent-identity/agent-identity-service.js';
import type { ApprovalService } from '../../core/approvals/approval-service.js';
import {
  createServerPrincipal,
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../connectors/principal/server-principal.js';
import { queueKeyOf } from '../../session/session-key-registry.js';
import type { RoomService } from '../../rooms/room-service.js';
import type { RoomStore } from '../../rooms/room-store.js';
import type { RoomRepoStore } from '../../rooms/repo/room-repo-store.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import { canvasSourcePath } from '../document-key.js';
import { parseScope } from '../scopes.js';
import { DocChannelAuthorization, DocChannelNotFoundError } from './authorization.js';
import { DocChannelStore } from './store.js';
import { DocChannelService } from './service.js';
import { DocChannelGrants } from './grants.js';
import { DocChannelIngest } from './ingest.js';
import { DocRouteGrantError, type DocGrantAuthority } from './grant-policy.js';

/** Use real server-owned instances; no independent physical document writer or transcript store. */
export function createDocChannelHttpComposition(deps: {
  db: Db;
  documents: CanvasDocumentStore;
  rooms: RoomService;
  roomStore: RoomStore;
  roomRepos: RoomRepoStore;
  approvals: ApprovalService;
  installationId: string;
  runtimePrincipalCurrent?: (proof: ServerPrincipalProof) => boolean;
  revalidateRuntime?: (proof: ServerPrincipalProof) => Promise<boolean>;
}): DocChannelHttp & {
  grants: DocChannelGrants;
  channels: DocChannelStore;
  authorization: DocChannelAuthorization;
} {
  const channels = new DocChannelStore(deps.db);
  const tokens = new WeakMap<ServerPrincipalProof, string>();
  const currentOwner = (): ConnectorOwnerAuthority => {
    const owner = readOwnerAccount();
    return owner
      ? { kind: 'user', userId: owner.id }
      : { kind: 'local_install', installationId: deps.installationId };
  };
  const sameOwner = (claims: ServerPrincipalClaims) => {
    const owner = currentOwner();
    return owner.kind === 'user'
      ? claims.owner.kind === 'user' && claims.owner.userId === owner.userId
      : claims.owner.kind === 'local_install' &&
          claims.owner.installationId === owner.installationId;
  };
  const principalCurrent = (proof: ServerPrincipalProof): boolean => {
    if (!isServerPrincipal(proof) || !sameOwner(proof.claims)) return false;
    const claims = proof.claims;
    if (claims.kind === 'operator') return true;
    if (claims.kind === 'runtime') return deps.runtimePrincipalCurrent?.(proof) === true;
    if (claims.kind !== 'agent') return false; // Runtime turn proofs use their own composition in the dispatch layer.
    const digest = tokens.get(proof);
    const token = digest
      ? deps.db
          .select()
          .from(agentIdentityTokens)
          .where(eq(agentIdentityTokens.tokenHash, digest))
          .get()
      : undefined;
    const agent = deps.db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
    const now = Date.now();
    const created = Date.parse(token?.createdAt ?? '');
    const used = Date.parse(token?.lastUsedAt ?? token?.createdAt ?? '');
    return (
      !!token &&
      !token.revokedAt &&
      token.agentPath === claims.agentPath &&
      Number.isFinite(created) &&
      now - created <= TOKEN_ABSOLUTE_TTL_MS &&
      now - (Number.isFinite(used) ? used : created) <= TOKEN_IDLE_TTL_MS &&
      agent?.status === 'active' &&
      agent.projectPath === claims.agentPath
    );
  };
  const membership = (roomId: string, claims: ServerPrincipalClaims) => {
    const key =
      claims.kind === 'agent' || claims.kind === 'runtime'
        ? claims.agentPath
        : claims.kind === 'operator'
          ? claims.owner.kind === 'user'
            ? `user:${claims.owner.userId}`
            : 'local'
          : null;
    if (!key) return undefined;
    const kind = claims.kind === 'operator' ? 'human' : 'agent';
    const author = deps.db
      .select()
      .from(authors)
      .where(and(eq(authors.kind, kind), eq(authors.naturalKey, key), isNull(authors.retiredAt)))
      .get();
    if (!author) return undefined;
    if (
      (claims.kind === 'agent' || claims.kind === 'runtime') &&
      author.mintedForManifestId !== claims.agentId
    )
      return undefined;
    try {
      return deps.rooms.requireMembership(roomId, author.id);
    } catch {
      return undefined;
    }
  };
  const authorization = new DocChannelAuthorization(deps.db, deps.documents, {
    ownsInstallation: sameOwner,
    principalCurrent,
    roomMembership: membership,
    revalidateRuntime: (proof) => deps.revalidateRuntime?.(proof) ?? Promise.resolve(false),
  });
  const resolveTarget: DocGrantAuthority['resolveTarget'] = (input, tx) => {
    const scope = deps.documents.lifecycle.resolveScope(input.scope);
    const parsed = parseScope(scope);
    if (input.route.to === 'log')
      return { agentId: null, agentPath: null, sessionId: null, runtime: null, scope };
    const agentId =
      input.route.to === 'agent:owner' || input.route.to === 'room:self'
        ? input.openerAgentId
        : input.route.to.slice(6);
    const executor = tx ?? deps.db;
    const agent = agentId
      ? executor.select().from(agents).where(eq(agents.id, agentId)).get()
      : undefined;
    if (!agent || agent.status !== 'active') throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    let sessionId: string | null = parsed.kind === 'session' ? parsed.id : null;
    if (parsed.kind === 'session' && input.route.to !== 'agent:owner') {
      const candidates = executor
        .select()
        .from(sessionMetadata)
        .where(
          and(
            eq(sessionMetadata.agentPath, agent.projectPath),
            eq(sessionMetadata.runtime, agent.runtime)
          )
        )
        .all();
      const canonical = new Set(
        candidates.map((candidate) =>
          deps.documents.lifecycle
            .resolveScope(`session:${queueKeyOf(candidate.sessionId)}`)
            .slice(8)
        )
      );
      if (canonical.size !== 1) throw new DocRouteGrantError('TARGET_UNAVAILABLE');
      sessionId = [...canonical][0]!;
    }
    if (parsed.kind === 'room') {
      const author = executor
        .select()
        .from(authors)
        .where(
          and(
            eq(authors.kind, 'agent'),
            eq(authors.naturalKey, agent.projectPath),
            isNull(authors.retiredAt)
          )
        )
        .get();
      if (
        !author ||
        !membership(parsed.id, {
          kind: 'agent',
          owner: currentOwner(),
          agentId: agent.id,
          agentPath: agent.projectPath,
        })
      )
        throw new DocRouteGrantError('TARGET_UNAVAILABLE');
      sessionId = deps.roomStore.getRoomSession(parsed.id, author.id);
    }
    if (!sessionId) throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    sessionId = deps.documents.lifecycle.resolveScope(`session:${queueKeyOf(sessionId)}`).slice(8);
    const session = executor
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (
      !session?.runtime ||
      session.agentPath !== agent.projectPath ||
      session.runtime !== agent.runtime
    )
      throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    return {
      agentId: agent.id,
      agentPath: agent.projectPath,
      sessionId,
      runtime: session.runtime,
      scope,
    };
  };
  const resolveSourceRoot = (documentId: string, tx?: DbTransaction): string | null => {
    const identity = deps.documents.lookupIdentity(documentId);
    if (!identity) throw new DocChannelNotFoundError();
    const document = deps.documents.get(identity.scope, documentId);
    if (!document) throw new DocChannelNotFoundError();
    const source = canvasSourcePath(document.content);
    if (!source) {
      if (
        'url' in document.content &&
        typeof document.content.url === 'string' &&
        document.content.url.startsWith('file:')
      )
        throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      return null;
    }
    const executor = tx ?? deps.db;
    const parsed = parseScope(deps.documents.lifecycle.resolveScope(identity.scope));
    let root = document.resolvedCwd;
    if (parsed.kind === 'session') {
      const session = executor
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, parsed.id))
        .get();
      if (!session?.agentPath) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      const current = fs.realpathSync(session.agentPath);
      if (root && fs.realpathSync(root) !== current)
        throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      root = current;
    } else if (parsed.kind === 'room') {
      if (!root) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      const canonical = fs.realpathSync(root);
      if (document.treeKind === 'room-main' || document.treeKind === 'worktree') {
        if (!deps.roomRepos.getRow(parsed.id))
          throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
        const allowed = fs.realpathSync(
          document.treeKind === 'room-main'
            ? deps.roomRepos.repoPath(parsed.id)
            : deps.roomRepos.worktreesPath(parsed.id)
        );
        if (!isContained(canonical, allowed))
          throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      } else {
        const author = executor
          .select()
          .from(authors)
          .where(eq(authors.id, document.authorId))
          .get();
        const agent =
          author?.kind === 'agent'
            ? executor.select().from(agents).where(eq(agents.projectPath, author.naturalKey)).get()
            : undefined;
        if (!agent || agent.status !== 'active' || fs.realpathSync(agent.projectPath) !== canonical)
          throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
      }
      root = canonical;
    }
    if (!root) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    const canonicalRoot = fs.realpathSync(root);
    const file = fs.realpathSync(path.resolve(canonicalRoot, source));
    if (!isContained(file, canonicalRoot)) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    // Use the server-owned canonical app root: nested files cannot bypass ancestor manifest rules.
    return canonicalRoot;
  };
  const sourceRoot = (documentId: string, tx?: DbTransaction): string | null => {
    try {
      return resolveSourceRoot(documentId, tx);
    } catch (error) {
      if (error instanceof DocRouteGrantError || error instanceof DocChannelNotFoundError)
        throw error;
      throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    }
  };
  const grants = new DocChannelGrants({
    db: deps.db,
    store: channels,
    approvals: deps.approvals,
    authority: {
      resolveScope: (scope) => deps.documents.lifecycle.resolveScope(scope),
      requireCurrent: (documentId, actor, write, tx) =>
        authorization.requireCurrent(documentId, actor, write, tx),
      resolveTarget,
      sourceRoot,
      originCurrent: (documentId, opener, tx) => {
        const channel = channels.getChannel(documentId, tx);
        const agent = (tx ?? deps.db).select().from(agents).where(eq(agents.id, opener)).get();
        return channel?.openerAgentId === opener && agent?.status === 'active';
      },
      requireGrantedCurrent: (grant, tx) => {
        // Persisted grant evidence is verified by DocChannelGrants. Recheck the owning physical scope here,
        // without minting an operator principal or borrowing an expired opener-turn proof.
        const identity = deps.documents.lookupIdentity(grant.documentId);
        const channel = channels.getChannel(grant.documentId, tx);
        if (!identity || !channel || channel.closedAt !== null || grant.revokedAt)
          throw new DocChannelNotFoundError();
        deps.documents.lifecycle.assertReady(grant.documentId);
        const scope = deps.documents.lifecycle.resolveScope(identity.scope);
        if (
          channel.scope !== scope ||
          deps.documents.lifecycle.resolveScope(
            String(
              (grant.approvalEvidence as { binding?: { scope?: string } }).binding?.scope ?? ''
            )
          ) !== scope
        )
          throw new DocChannelNotFoundError();
        const parsed = parseScope(scope);
        if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
        if (parsed.kind === 'room') {
          const owner = membership(parsed.id, { kind: 'operator', owner: currentOwner() });
          if (!owner || owner.archived) throw new DocChannelNotFoundError();
        }
        return { id: identity.id, scope };
      },
    },
  });
  return {
    grants,
    channels,
    authorization,
    service: new DocChannelService(deps.documents, channels, authorization, {
      ingest: new DocChannelIngest(channels),
      grants,
    }),
    actor(req, res) {
      resolveCaller(req, res); // Refuse unknown/revoked agent headers before minting a principal.
      const identity = getRequestAgentIdentity(res);
      const owner = currentOwner();
      if (identity) {
        const agent = deps.db
          .select()
          .from(agents)
          .where(eq(agents.projectPath, identity.agentPath))
          .get();
        if (!agent || agent.status !== 'active') throw new DocChannelNotFoundError();
        const principal = createServerPrincipal({
          kind: 'agent',
          owner,
          agentId: agent.id,
          agentPath: agent.projectPath,
        });
        const raw = req.headers['x-dorkos-agent'];
        if (typeof raw !== 'string') throw new DocChannelNotFoundError();
        tokens.set(principal, createHash('sha256').update(raw).digest('hex'));
        return { surface: 'http', principal };
      }
      const user = res.locals.user as RequestUser | undefined;
      if (user && (owner.kind !== 'user' || owner.userId !== user.userId))
        throw new DocChannelNotFoundError();
      return { surface: 'http', principal: createServerPrincipal({ kind: 'operator', owner }) };
    },
  };
}
