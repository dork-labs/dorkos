/** Document authorization resolves private identity before disclosing channel data. */
import {
  agents,
  eq,
  sessionMetadata,
  canvasDocuments,
  canvasDocChannels,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../connectors/principal/server-principal.js';
import { parseScope } from '../scopes.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';

/** The same refusal for an absent document and one the caller cannot reach. */
export class DocChannelNotFoundError extends Error {
  readonly code = 'CANVAS_DOCUMENT_NOT_FOUND';
  readonly status = 404;
  /** Build a disclosure-safe document refusal. */
  constructor() {
    super('The document is not available.');
  }
}
/** An authorized room remains readable while its writes are stopped. */
export class DocChannelArchivedError extends Error {
  readonly code = 'ROOM_ARCHIVED';
  readonly status = 409;
  /** Build the existing archived-room refusal. */
  constructor() {
    super('This room is archived');
  }
}
/** Server-resolved entry surface; nothing here is read from a page envelope. */
export interface DocChannelActor {
  surface: 'http' | 'capability';
  principal: ServerPrincipalProof;
}
/** Scope checks supplied by the existing owner and room authority services. */
export interface DocChannelAuthorityPorts {
  ownsInstallation(claims: ServerPrincipalClaims): boolean;
  /** Resolve the verified owner or agent to an author and require current membership. */
  roomMembership(roomId: string, claims: ServerPrincipalClaims): { archived: boolean } | undefined;
  /** Synchronous current principal check, including runtime binding revocation; required before every disclosure or mutation. */
  principalCurrent: (proof: ServerPrincipalProof) => boolean;
  /** Optional live runtime principal recheck, beyond synchronous stored binding checks. */
  revalidateRuntime?: (proof: ServerPrincipalProof) => Promise<boolean>;
}
/** No content, state, receipts or private tombstones are disclosed by this service. */
export class DocChannelAuthorization {
  /** Use the same DB and document store the lifecycle writes through. */
  constructor(
    private readonly db: Db,
    private readonly documents: CanvasDocumentStore,
    private readonly ports: DocChannelAuthorityPorts
  ) {}

  /** Revalidate asynchronous authority, then repeat all synchronous checks before disclosure. */
  async require(
    documentId: string,
    actor: DocChannelActor,
    write = false
  ): Promise<{ id: string; scope: string }> {
    this.requireCurrent(documentId, actor, write);
    if (
      actor.principal.claims.kind === 'runtime' &&
      this.ports.revalidateRuntime &&
      !(await this.ports.revalidateRuntime(actor.principal))
    )
      throw new DocChannelNotFoundError();
    return this.requireCurrent(documentId, actor, write);
  }

  /** Final synchronous gate for ingestion/dispatch inside the caller's SQLite transaction. */
  requireCurrent(
    documentId: string,
    actor: DocChannelActor,
    write = false,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    return this.checkCurrent(documentId, actor, write, tx, true);
  }

  /** Operator-only recovery health access; no retained state or receipts are returned. */
  requireHealth(documentId: string, actor: DocChannelActor): { id: string; scope: string } {
    if (!isServerPrincipal(actor.principal) || actor.principal.claims.kind !== 'operator')
      throw new DocChannelNotFoundError();
    return this.checkCurrent(documentId, actor, false, undefined, false);
  }

  private checkCurrent(
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    tx: DbTransaction | undefined,
    ready: boolean
  ): { id: string; scope: string } {
    if (
      !isServerPrincipal(actor.principal) ||
      typeof this.ports.principalCurrent !== 'function' ||
      !this.ports.principalCurrent(actor.principal)
    )
      throw new DocChannelNotFoundError();
    const claims = actor.principal.claims;
    if (!this.ports.ownsInstallation(claims)) throw new DocChannelNotFoundError();
    const executor = tx ?? this.db;
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
      if (ready) this.documents.lifecycle.assertReady(documentId);
      scope = ready ? this.documents.lifecycle.resolveScope(identity.scope) : identity.scope;
    } catch {
      throw new DocChannelNotFoundError();
    }
    if (channel.scope !== scope) throw new DocChannelNotFoundError();
    const parsed = parseScope(scope);
    if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
    const runtimeScope =
      claims.kind === 'runtime' ? this.currentRuntime(actor.principal, tx) : undefined;
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
      const membership = this.ports.roomMembership(parsed.id, claims);
      if (!membership) throw new DocChannelNotFoundError();
      if (write && membership.archived) throw new DocChannelArchivedError();
    }
    return { id: identity.id, scope };
  }

  private currentRuntime(proof: ServerPrincipalProof, tx?: DbTransaction): string | undefined {
    const claims = proof.claims;
    if (claims.kind !== 'runtime') return undefined;
    let canonical: string;
    try {
      canonical = this.documents.lifecycle.resolveScope(`session:${claims.canonicalSessionId}`);
    } catch {
      return undefined;
    }
    const executor = tx ?? this.db;
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
}
