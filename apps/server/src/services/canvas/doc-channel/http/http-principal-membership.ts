import { agents, agentIdentityTokens, authors, and, eq, isNull } from '@dorkos/db';
import {
  TOKEN_ABSOLUTE_TTL_MS,
  TOKEN_IDLE_TTL_MS,
} from '../../../core/agent-identity/agent-identity-service.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../../connectors/principal/server-principal.js';
import type { OriginalDocHttpCompositionDependencies } from './http-composition-contracts.js';
import { readOriginalHttpPrincipalMembershipView } from '../http-composition.js';

/** Fixed original composition inputs selected only by its private principal-membership key. */
export interface OriginalHttpPrincipalMembershipView {
  readonly deps: OriginalDocHttpCompositionDependencies;
  readonly tokens: WeakMap<ServerPrincipalProof, string>;
  readonly sameOwner: (claims: ServerPrincipalClaims) => boolean;
}

/** Recheck the original proof and current native agent token before principal disclosure. */
export function readOriginalHttpPrincipalCurrent(
  owner: object,
  proof: ServerPrincipalProof
): boolean {
  const { deps, tokens, sameOwner } = readOriginalHttpPrincipalMembershipView(owner);

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
}

/** Read the original active author membership; unknown or retired authority remains unavailable. */
export function readOriginalHttpMembership(
  owner: object,
  roomId: string,
  claims: ServerPrincipalClaims
): ReturnType<OriginalDocHttpCompositionDependencies['rooms']['requireMembership']> | undefined {
  const { deps } = readOriginalHttpPrincipalMembershipView(owner);

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
}
