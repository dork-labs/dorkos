import {
  agents,
  eq,
  sessionMetadata,
  canvasDocuments,
  canvasDocChannels,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { CanvasDocumentStore } from '../../canvas-document-store.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../../connectors/principal/server-principal.js';
import { parseScope } from '../../scopes.js';
import {
  DocChannelNotFoundError,
  DocChannelArchivedError,
  type DocChannelActor,
  type DocChannelAuthorityPorts,
} from './authorization-data.js';
import { readOriginalAuthorizationCurrentPolicy } from '../authorization.js';

/** Live original constructor ports; only the private key can select this view. */
export interface OriginalAuthorizationCurrentPolicy {
  readonly db: Db;
  readonly documents: CanvasDocumentStore;
  readonly ports: DocChannelAuthorityPorts;
  readonly currentRuntime: (proof: ServerPrincipalProof, tx?: DbTransaction) => string | undefined;
}

/** Original synchronous document policy, selected only by the constructor-private key. */
export function checkOriginalAuthorizationCurrent(
  owner: object,
  documentId: string,
  actor: DocChannelActor,
  write: boolean,
  tx: DbTransaction | undefined,
  ready: boolean
): { id: string; scope: string } {
  const facet = readOriginalAuthorizationCurrentPolicy(owner);
  if (
    !isServerPrincipal(actor.principal) ||
    typeof facet.ports.principalCurrent !== 'function' ||
    !facet.ports.principalCurrent(actor.principal)
  )
    throw new DocChannelNotFoundError();
  const claims = actor.principal.claims;
  if (!facet.ports.ownsInstallation(claims)) throw new DocChannelNotFoundError();
  const executor = tx ?? facet.db;
  const identity = executor
    .select({ id: canvasDocuments.id, scope: canvasDocuments.scope })
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
  const channel = executor
    .select({ scope: canvasDocChannels.scope, closedAt: canvasDocChannels.closedAt })
    .from(canvasDocChannels)
    .where(eq(canvasDocChannels.documentId, documentId))
    .get();
  if (!identity || !channel || channel.closedAt !== null) throw new DocChannelNotFoundError();
  let scope: string;
  try {
    if (ready) facet.documents.lifecycle.assertReady(documentId);
    scope = ready ? facet.documents.lifecycle.resolveScope(identity.scope) : identity.scope;
  } catch (cause) {
    // Keep the reduction-only cause private so transient recovery cannot cancel accepted work.
    throw new DocChannelNotFoundError({ cause });
  }
  if (channel.scope !== scope) throw new DocChannelNotFoundError();
  const parsed = parseScope(scope);
  if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
  const runtimeScope =
    claims.kind === 'runtime' ? facet.currentRuntime(actor.principal, tx) : undefined;
  if (claims.kind === 'runtime' && !runtimeScope) throw new DocChannelNotFoundError();
  if (claims.kind === 'agent') {
    const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
    if (!agent || agent.status !== 'active' || agent.projectPath !== claims.agentPath)
      throw new DocChannelNotFoundError();
  }
  if (parsed.kind === 'session') {
    if (claims.kind !== 'operator' && (actor.surface !== 'capability' || runtimeScope !== scope))
      throw new DocChannelNotFoundError();
  } else {
    const membership = facet.ports.roomMembership(parsed.id, claims);
    if (!membership) throw new DocChannelNotFoundError();
    if (write && membership.archived) throw new DocChannelArchivedError();
  }
  return { id: identity.id, scope };
}

/** Original runtime/session scope policy, selected only by the constructor-private key. */
export function readOriginalAuthorizationRuntime(
  owner: object,
  proof: ServerPrincipalProof,
  tx?: DbTransaction
): string | undefined {
  const facet = readOriginalAuthorizationCurrentPolicy(owner);
  const claims = proof.claims;
  if (claims.kind !== 'runtime') return undefined;
  let canonical: string;
  try {
    canonical = facet.documents.lifecycle.resolveScope(`session:${claims.canonicalSessionId}`);
  } catch {
    return undefined;
  }
  const executor = tx ?? facet.db;
  const session = executor
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, canonical.slice(8)))
    .get();
  const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
  if (
    session?.runtime !== claims.runtime ||
    session.agentPath !== claims.agentPath ||
    agent?.projectPath !== claims.agentPath ||
    agent.runtime !== claims.runtime ||
    agent.status !== 'active'
  )
    return undefined;
  return canonical;
}

/** Original synchronous stream-scope policy, selected only by the constructor-private key. */
export function requireOriginalAuthorizationScope(
  owner: object,
  scope: string,
  actor: DocChannelActor,
  write = false,
  tx?: DbTransaction
): string {
  const facet = readOriginalAuthorizationCurrentPolicy(owner);
  if (
    !isServerPrincipal(actor.principal) ||
    typeof facet.ports.principalCurrent !== 'function' ||
    !facet.ports.principalCurrent(actor.principal) ||
    !facet.ports.ownsInstallation(actor.principal.claims)
  )
    throw new DocChannelNotFoundError();
  let canonical: string;
  try {
    canonical = facet.documents.lifecycle.resolveScope(scope);
  } catch {
    throw new DocChannelNotFoundError();
  }
  const parsed = parseScope(canonical);
  const claims = actor.principal.claims;
  if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
  const runtimeScope =
    claims.kind === 'runtime' ? facet.currentRuntime(actor.principal, tx) : undefined;
  if (claims.kind === 'runtime' && !runtimeScope) throw new DocChannelNotFoundError();
  if (claims.kind === 'agent') {
    const executor = tx ?? facet.db;
    const agent = executor.select().from(agents).where(eq(agents.id, claims.agentId)).get();
    if (!agent || agent.status !== 'active' || agent.projectPath !== claims.agentPath)
      throw new DocChannelNotFoundError();
  }
  if (parsed.kind === 'session') {
    if (
      claims.kind !== 'operator' &&
      (actor.surface !== 'capability' || runtimeScope !== canonical)
    )
      throw new DocChannelNotFoundError();
  } else {
    const membership = facet.ports.roomMembership(parsed.id, claims);
    if (!membership) throw new DocChannelNotFoundError();
    if (write && membership.archived) throw new DocChannelArchivedError();
  }
  return canonical;
}
