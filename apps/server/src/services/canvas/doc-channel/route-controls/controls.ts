/**
 * A person's route controls for one canvas document (spec `doc-channel` task 5.2).
 *
 * Reads every declared route with its state, and lets a person allow or turn
 * one off. Nothing here is a second grant path: allowing runs the same
 * {@link DocChannelGrants.grant} as `approve_doc_route`, with an operator verdict
 * recorded through the shared approval service, and turning off revokes every
 * grant the route holds through {@link DocChannelGrants.revokeRoute}. Every write
 * needs a {@link DocRoutePersonDecision}, which only the person bars can mint.
 * What this module adds is the binding between
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
import { eq, inArray, agents, canvasDocGrants, type Db } from '@dorkos/db';
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
import type { DocChannelAuthorization } from '../authorization.js';
import { DocChannelNotFoundError } from '../authorization.js';
import type { DocChannelGrants, PreparedDocGrant } from '../grants.js';
import { DocRouteGrantError, type DocGrantActor } from '../grant-policy.js';
import type { DocChannelRow, DocChannelStore, DocGrantRow } from '../store.js';
import { requirePersonDecision, type DocRoutePersonDecision } from './person-decision.js';
import { APPROVE_DOC_ROUTE, findWaitingRequests } from './waiting.js';

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

/** A person's allow: the route as it now stands, and the approval it recorded. */
export interface DocRouteAllowed extends CanvasDocRouteChange {
  approvalId: string;
}

/** A person's turn off: the route as it now stands, and every grant it revoked. */
export interface DocRouteTurnedOff extends CanvasDocRouteChange {
  revokedGrantIds: string[];
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

  /**
   * Where a route's events go, named. `agentId` is the agent that will act: the
   * opener when listing, the server-resolved target when reviewing.
   */
  private destination(
    route: CanvasChannelRoute,
    agentId: string | null,
    names: Map<string, string>
  ): CanvasDocRouteDestination {
    const agentName = agentId ? (names.get(agentId) ?? null) : null;
    if (route.to === 'log') return { kind: 'log' };
    if (route.to === 'room:self') return { kind: 'room', agentId, agentName };
    if (route.to === 'agent:owner') return { kind: 'owner', agentId, agentName };
    const named = route.to.slice('agent:'.length);
    return { kind: 'agent', agentId: named, agentName: names.get(named) ?? null };
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
    const waiting = findWaitingRequests(this.deps.db, channel, routes, this.now());
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
          waiting: waiting.get(route.id)?.[0] ?? null,
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
   * @param decision - The person bars' proof, from `decideAsPerson`.
   */
  async review(
    documentId: string,
    routeId: string,
    body: unknown,
    actor: DocGrantActor,
    decision: DocRoutePersonDecision
  ): Promise<CanvasDocRouteReview> {
    requirePerson(actor);
    requirePersonDecision(decision);
    const { expiresAt } = CanvasDocRouteReviewRequestSchema.parse(body);
    const prepared = await this.prepare(documentId, routeId, expiresAt, actor);
    const names = this.agentNames([prepared.target.agentId, prepared.openerAgentId]);
    return {
      documentId,
      routeId: prepared.route.id,
      on: prepared.route.on,
      destination: this.destination(prepared.route, prepared.target.agentId, names),
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
   * one. The person's yes is recorded quietly (they are the one clicking, so no
   * card or banner is raised about it) on a ticket bound to the reviewed hash,
   * and the grant service consumes that ticket only against the same hash again.
   * A yes that grants nothing is spent, never left for anyone to reissue. Any
   * agent request still waiting on this route is then answered, so its agent
   * hears back instead of waiting on a card nobody needs to answer.
   *
   * @param documentId - The document, by id.
   * @param routeId - The declared route.
   * @param body - The reviewed expiry and the review's hash.
   * @param actor - The verified operator.
   * @param decision - The person bars' proof, from `decideAsPerson`.
   */
  async approve(
    documentId: string,
    routeId: string,
    body: unknown,
    actor: DocGrantActor,
    decision: DocRoutePersonDecision
  ): Promise<DocRouteAllowed> {
    requirePerson(actor);
    requirePersonDecision(decision);
    const { expiresAt, reviewHash } = CanvasDocRouteApproveRequestSchema.parse(body);
    const prepared = await this.prepare(documentId, routeId, expiresAt, actor);
    if (prepared.inputHash !== reviewHash) throw new DocRouteGrantError('ROUTE_CHANGED', 409);
    if (this.currentGrants(documentId, actor).has(prepared.route.id))
      throw new DocRouteGrantError('ROUTE_ALREADY_ON', 409);
    const binding = { capabilityId: APPROVE_DOC_ROUTE, inputHash: reviewHash };
    const ticket = this.deps.approvals.request({
      ...binding,
      summary: `Allow document events on route ${prepared.route.id}.`,
      detail: JSON.stringify(prepared.bindingInput),
      area: null,
      quiet: true,
    });
    if (this.deps.approvals.grant(ticket.approvalId, decision.decidedByUserId)) {
      this.deps.approvals.deny(ticket.approvalId, 'The approval could not be recorded.');
      throw new DocRouteGrantError('APPROVAL_NOT_RECORDED', 409);
    }
    try {
      const result = this.deps.grants.grant(
        { documentId, routeId: prepared.route.id, expiresAt },
        actor,
        ticket.token
      );
      if (result.kind !== 'granted' || result.grant.approvalId !== ticket.approvalId)
        throw new DocRouteGrantError('APPROVAL_NOT_RECORDED', 409);
    } catch (error) {
      this.deps.approvals.consume(ticket.token, binding);
      throw error;
    }
    this.answerWaiting(documentId, prepared.route.id);
    return {
      ...(await this.changed(documentId, prepared.route.id, actor)),
      approvalId: ticket.approvalId,
    };
  }

  /** Answer every agent request still waiting on a route a person just allowed. */
  private answerWaiting(documentId: string, routeId: string): void {
    const channel = this.deps.channels.getChannel(documentId);
    const declaration = CanvasChannelDeclarationSchema.safeParse(channel?.declaration);
    if (!channel || !declaration.success) return;
    const waiting = findWaitingRequests(this.deps.db, channel, declaration.data.routes, this.now());
    for (const request of waiting.get(routeId) ?? [])
      this.deps.approvals.deny(request.approvalId, 'Allowed from the document.');
  }

  /**
   * Turn a route off: every grant it holds is revoked together, so no older grant
   * keeps admitting events. Work already started keeps its recorded source.
   *
   * @param documentId - The document, by id.
   * @param routeId - The declared route.
   * @param body - Empty; the route is the whole subject.
   * @param actor - The verified operator.
   * @param decision - The person bars' proof, from `decideAsPerson`.
   */
  async revoke(
    documentId: string,
    routeId: string,
    body: unknown,
    actor: DocGrantActor,
    decision: DocRoutePersonDecision
  ): Promise<DocRouteTurnedOff> {
    requirePerson(actor);
    requirePersonDecision(decision);
    CanvasDocRouteRevokeRequestSchema.parse(body);
    await this.deps.authorization.require(documentId, actor, true);
    const revokedGrantIds = this.deps.grants.revokeRoute(documentId, routeId, actor);
    return { ...(await this.changed(documentId, routeId, actor)), revokedGrantIds };
  }

  private async changed(
    documentId: string,
    routeId: string,
    actor: DocGrantActor
  ): Promise<CanvasDocRouteChange> {
    const route = (await this.list(documentId, actor)).routes.find((item) => item.id === routeId);
    if (!route) throw new DocRouteGrantError('ROUTE_UNDECLARED', 404);
    return { route };
  }
}
