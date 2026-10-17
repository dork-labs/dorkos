/**
 * A person's route controls for one canvas document (spec `doc-channel` task 5.2).
 *
 * Reads every declared route with its state, and lets a person allow or turn
 * one off. Nothing here is a second grant path: allowing runs the same
 * {@link DocChannelGrants.grant} as `approve_doc_route`, with an operator verdict
 * recorded through the shared approval service, and turning off runs the same
 * {@link DocChannelGrants.revoke}. What this module adds is the binding between
 * what a person was shown and what is granted: the review returns the grant
 * service's own `inputHash` over the exact document, route, declaration, target,
 * types, limits and expiry, and an approval is refused unless the current binding
 * still hashes to the one the person reviewed.
 *
 * Only an operator principal reaches any of it. An agent caller, however it
 * authenticated, is refused before anything is read.
 *
 * @module services/canvas/doc-channel/route-controls/controls
 */
import { and, eq, isNull, inArray, agents, approvals, canvasDocGrants, type Db } from '@dorkos/db';
import { CanvasAppManifestError } from '@dorkos/shared/canvas-app-manifest';
import {
  CanvasChannelDeclarationSchema,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  CanvasDocRouteApproveRequestSchema,
  CanvasDocRouteReviewRequestSchema,
  CanvasDocRouteRevokeRequestSchema,
  type CanvasDocRoute,
  type CanvasDocRouteChange,
  type CanvasDocRouteDestination,
  type CanvasDocRouteLimits,
  type CanvasDocRouteReview,
  type CanvasDocRoutes,
  type CanvasDocRouteState,
} from '@dorkos/shared/canvas-doc-routes';
import type { ApprovalService } from '../../../core/approvals/approval-service.js';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import { REDACTED_SUMMARY_VALUE } from '../../../core/approvals/approval-summary.js';
import type { DocChannelAuthorization } from '../authorization.js';
import { DocChannelNotFoundError } from '../authorization.js';
import type { DocChannelGrants, PreparedDocGrant } from '../grants.js';
import { DocRouteGrantError, type DocGrantActor } from '../grant-policy.js';
import type { DocChannelRow, DocChannelStore, DocGrantRow } from '../store.js';

/** The capability whose approvals a route's grant consumes. */
const APPROVE_CAPABILITY = 'ui.approve_doc_route';

/** What the controls are composed from: the channel's own services, never copies. */
export interface DocRouteControlsDeps {
  db: Db;
  channels: DocChannelStore;
  grants: DocChannelGrants;
  approvals: ApprovalService;
  authorization: Pick<DocChannelAuthorization, 'require'>;
  /** The authorized live channel row; refuses a closed or unreachable document. */
  readChannel(documentId: string, actor: DocGrantActor): Promise<DocChannelRow>;
  now?: () => Date;
}

/** Who may decide, as the HTTP layer established it. */
export interface DocRouteDecider {
  /** The signed-in account saying yes, when login is on. */
  decidedByUserId?: string;
}

function requirePerson(actor: DocGrantActor): void {
  if (actor.principal.claims.kind !== 'operator')
    throw new DocRouteGrantError('PERSON_REQUIRED', 403);
}

/** An expected refusal while classifying a grant, never a storage fault. */
function isAuthorityRefusal(error: unknown): error is Error {
  return (
    error instanceof DocRouteGrantError ||
    error instanceof DocChannelNotFoundError ||
    error instanceof CanvasAppManifestError
  );
}

/** Why the newest grant no longer admits events, in the controls' words. */
function classifyRefusal(error: Error): CanvasDocRouteState {
  const code = error instanceof DocRouteGrantError ? error.code : '';
  if (code === 'GRANT_REVOKED') return 'revoked';
  if (code === 'GRANT_EXPIRED') return 'expired';
  return 'suspended';
}

function needsPerson(route: CanvasChannelRoute): boolean {
  return route.to === 'room:self' || (route.to.startsWith('agent:') && route.to !== 'agent:owner');
}

/** Read, review, allow and turn off one document's declared routes. */
export class DocRouteControls {
  /** Compose over the channel's existing grant, approval and authorization services. */
  constructor(private readonly deps: DocRouteControlsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private agentNames(ids: (string | null)[]): Map<string, string> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const rows = this.deps.db.select().from(agents).where(inArray(agents.id, wanted)).all();
    return new Map(rows.map((row) => [row.id, row.displayName || row.name]));
  }

  private destination(
    route: CanvasChannelRoute,
    ownerId: string | null,
    names: Map<string, string>
  ): CanvasDocRouteDestination {
    if (route.to === 'log') return { kind: 'log' };
    if (route.to === 'room:self') return { kind: 'room' };
    if (route.to === 'agent:owner')
      return {
        kind: 'owner',
        agentId: ownerId,
        agentName: ownerId ? (names.get(ownerId) ?? null) : null,
      };
    const agentId = route.to.slice('agent:'.length);
    return { kind: 'agent', agentId, agentName: names.get(agentId) ?? null };
  }

  /** Grant ids that currently admit events, by route; empty when authority cannot be read. */
  private currentGrants(documentId: string, actor: DocGrantActor): Map<string, string> {
    const current = new Map<string, string>();
    try {
      for (const route of this.deps.grants.getCurrentRoutes(documentId, undefined, actor))
        if (route.grantId && !route.reason) current.set(route.route.id, route.grantId);
    } catch (error) {
      // A changed or unreadable app manifest suspends every grant; the rows say so below.
      if (!isAuthorityRefusal(error)) throw error;
    }
    return current;
  }

  /**
   * The newest open agent request per route.
   *
   * Read from the approval's own server-written subject (the grant binding). The
   * stored copy is swept for token-shaped text, which hides a 32-hex document id,
   * so a subject whose id was hidden is matched on what survives instead: the
   * same scope, the same opener and the identical route. This only labels a
   * route as waiting; allowing it here never answers or spends that request.
   */
  private waitingRequests(
    channel: DocChannelRow,
    routes: CanvasChannelRoute[]
  ): Map<string, { approvalId: string; expiresAt: string }> {
    const now = this.now().toISOString();
    const rows = this.deps.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.capabilityId, APPROVE_CAPABILITY),
          eq(approvals.state, 'pending'),
          isNull(approvals.consumedAt)
        )
      )
      .all()
      .filter((row) => row.expiresAt > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const waiting = new Map<string, { approvalId: string; expiresAt: string }>();
    for (const row of rows) {
      let subject: Record<string, unknown> | undefined;
      try {
        subject = row.detail ? JSON.parse(row.detail) : undefined;
      } catch {
        continue; // A clamped subject names nothing reliably; it is not shown.
      }
      const routeId = (subject?.route as { id?: unknown } | undefined)?.id;
      const route = routes.find((item) => item.id === routeId);
      if (!subject || !route || waiting.has(route.id)) continue;
      const sameDocument =
        subject.documentId === channel.documentId ||
        (subject.documentId === REDACTED_SUMMARY_VALUE &&
          subject.scope === channel.scope &&
          subject.openerAgentId === channel.openerAgentId &&
          hashApprovalInput(subject.route) === hashApprovalInput(route));
      if (sameDocument) waiting.set(route.id, { approvalId: row.id, expiresAt: row.expiresAt });
    }
    return waiting;
  }

  private grantView(row: DocGrantRow): NonNullable<CanvasDocRoute['grant']> {
    return {
      grantId: row.grantId,
      allowedTypes: row.allowedTypes,
      limits: row.limits as CanvasDocRouteLimits,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      approvedBy: row.approvalId ? 'person' : 'agent',
    };
  }

  /**
   * Every declared route with its state. A route is `granted` only when the
   * grant service's own revalidation admits it right now.
   *
   * @param documentId - The document, by id.
   * @param actor - The verified operator.
   */
  async list(documentId: string, actor: DocGrantActor): Promise<CanvasDocRoutes> {
    requirePerson(actor);
    const channel = await this.deps.readChannel(documentId, actor);
    const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
    const routes = declaration.success ? declaration.data.routes : [];
    if (!routes.length) return { documentId: channel.documentId, routes: [] };
    const current = this.currentGrants(channel.documentId, actor);
    const waiting = this.waitingRequests(channel, routes);
    const grants = this.deps.db
      .select()
      .from(canvasDocGrants)
      .where(eq(canvasDocGrants.documentId, channel.documentId))
      .all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const names = this.agentNames([
      channel.openerAgentId,
      ...routes.map((route) => (route.to.startsWith('agent:') ? route.to.slice(6) : null)),
    ]);
    return {
      documentId: channel.documentId,
      routes: routes.map((route) => {
        const currentId = current.get(route.id);
        const newest = grants.find((row) => row.routeId === route.id);
        const shown = currentId ? grants.find((row) => row.grantId === currentId) : newest;
        let state: CanvasDocRouteState = currentId ? 'granted' : 'no_grant';
        if (!currentId && waiting.has(route.id)) state = 'waiting';
        else if (!currentId && newest) state = this.newestState(channel.documentId, newest, actor);
        return {
          id: route.id,
          on: route.on,
          to: route.to,
          turn: route.turn.mode,
          destination: this.destination(route, channel.openerAgentId, names),
          needsPerson: needsPerson(route),
          state,
          grant: shown ? this.grantView(shown) : null,
          waiting: waiting.get(route.id) ?? null,
        };
      }),
    };
  }

  /** Why the newest grant does not admit events, from the grant service's own refusal. */
  private newestState(documentId: string, grant: DocGrantRow, actor: DocGrantActor) {
    try {
      this.deps.channels.transaction((tx) =>
        this.deps.grants.revalidateGrant(documentId, grant.grantId, actor, tx)
      );
      return 'granted' as const; // Became current between the two reads.
    } catch (error) {
      if (!isAuthorityRefusal(error)) throw error;
      return classifyRefusal(error);
    }
  }

  private async prepare(
    documentId: string,
    routeId: string,
    expiresAt: string,
    actor: DocGrantActor
  ): Promise<PreparedDocGrant> {
    await this.deps.authorization.require(documentId, actor, true);
    this.deps.grants.refreshAuthority(documentId, actor);
    return this.deps.channels.transaction((tx) =>
      this.deps.grants.prepare({ documentId, routeId, expiresAt }, actor, tx)
    );
  }

  /**
   * The exact details allowing a route would bind. Records nothing.
   *
   * @param documentId - The document, by id.
   * @param routeId - The declared route.
   * @param body - The expiry the person picked.
   * @param actor - The verified operator.
   */
  async review(
    documentId: string,
    routeId: string,
    body: unknown,
    actor: DocGrantActor
  ): Promise<CanvasDocRouteReview> {
    requirePerson(actor);
    const { expiresAt } = CanvasDocRouteReviewRequestSchema.parse(body);
    const prepared = await this.prepare(documentId, routeId, expiresAt, actor);
    const names = this.agentNames([prepared.target.agentId, prepared.openerAgentId]);
    return {
      documentId,
      routeId: prepared.route.id,
      on: prepared.route.on,
      destination: this.destination(prepared.route, prepared.openerAgentId, names),
      allowedTypes: prepared.allowedTypes,
      limits: prepared.limits,
      expiresAt,
      reviewHash: prepared.inputHash,
    };
  }

  /**
   * Allow a reviewed route as a person.
   *
   * Refused with `ROUTE_CHANGED` unless the current binding hashes to the reviewed
   * one, both before the approval is raised and on the approval row itself, and
   * the grant service consumes that verdict only against the same hash again.
   *
   * @param documentId - The document, by id.
   * @param routeId - The declared route.
   * @param body - The reviewed expiry and the review's hash.
   * @param actor - The verified operator.
   * @param decider - Who said yes, for the approval row.
   */
  async approve(
    documentId: string,
    routeId: string,
    body: unknown,
    actor: DocGrantActor,
    decider: DocRouteDecider = {}
  ): Promise<CanvasDocRouteChange> {
    requirePerson(actor);
    const { expiresAt, reviewHash } = CanvasDocRouteApproveRequestSchema.parse(body);
    const prepared = await this.prepare(documentId, routeId, expiresAt, actor);
    if (prepared.inputHash !== reviewHash) throw new DocRouteGrantError('ROUTE_CHANGED', 409);
    if (this.currentGrants(documentId, actor).has(prepared.route.id))
      throw new DocRouteGrantError('ROUTE_ALREADY_ON', 409);
    const request = { documentId, routeId: prepared.route.id, expiresAt };
    const first = this.deps.grants.grant(request, actor);
    if (first.kind === 'approval_required') {
      const { approvalId, token } = first.ticket;
      const row = this.deps.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
      if (!row || row.inputHash !== reviewHash) {
        this.deps.approvals.deny(approvalId, 'The route changed before it was allowed.');
        throw new DocRouteGrantError('ROUTE_CHANGED', 409);
      }
      if (this.deps.approvals.grant(approvalId, decider.decidedByUserId))
        throw new DocRouteGrantError('APPROVAL_NOT_RECORDED', 409);
      const second = this.deps.grants.grant(request, actor, token);
      if (second.kind !== 'granted') throw new DocRouteGrantError('APPROVAL_NOT_RECORDED', 409);
    }
    return this.changed(documentId, prepared.route.id, actor);
  }

  /**
   * Turn one grant off. New events stop starting work; work already started
   * keeps its recorded source.
   *
   * @param documentId - The document, by id.
   * @param routeId - The declared route the grant belongs to.
   * @param body - The grant to turn off.
   * @param actor - The verified operator.
   */
  async revoke(
    documentId: string,
    routeId: string,
    body: unknown,
    actor: DocGrantActor
  ): Promise<CanvasDocRouteChange> {
    requirePerson(actor);
    const { grantId } = CanvasDocRouteRevokeRequestSchema.parse(body);
    await this.deps.authorization.require(documentId, actor, true);
    const row = this.deps.channels.getGrant(grantId);
    if (!row || row.documentId !== documentId || row.routeId !== routeId)
      throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    this.deps.grants.revoke(documentId, grantId, actor);
    return this.changed(documentId, routeId, actor);
  }

  private async changed(
    documentId: string,
    routeId: string,
    actor: DocGrantActor
  ): Promise<CanvasDocRouteChange> {
    const route = (await this.list(documentId, actor)).routes.find((item) => item.id === routeId);
    if (!route) throw new DocRouteGrantError('ROUTE_UNDECLARED', 409);
    return { route };
  }
}
