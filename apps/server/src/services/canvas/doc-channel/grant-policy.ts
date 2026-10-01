/** Exact document route binding, independent of capability permission defaults. */
import { z } from 'zod';
import {
  CanvasChannelDeclarationSchema,
  CanvasChannelEventPatternSchema,
  CanvasChannelGrantSchema,
  type CanvasChannelRoute,
  type CanvasChannelGrant,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DbTransaction } from '@dorkos/db';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import type { DocChannelRow, DocGrantRow } from './store.js';

/** Verified server actor, structurally compatible with the lifecycle authority service. */
export interface DocGrantActor {
  surface: 'http' | 'capability';
  principal: ServerPrincipalProof;
}
/** A current destination resolved from canonical server identity, never page routing fields. */
export interface DocGrantTarget {
  agentId: string | null;
  sessionId: string | null;
  runtime: string | null;
  /** Frozen server-resolved execution path, null only for a log destination. */
  agentPath: string | null;
  scope: string;
}
/** Lifecycle and identity ports supplied at composition, with synchronous final checks. */
export interface DocGrantAuthority {
  resolveScope(scope: string, tx?: DbTransaction): string;
  requireCurrent(
    documentId: string,
    actor: DocGrantActor,
    write?: boolean,
    tx?: DbTransaction
  ): { id: string; scope: string };
  resolveTarget(
    input: {
      documentId: string;
      scope: string;
      route: CanvasChannelRoute;
      openerAgentId: string | null;
    },
    tx?: DbTransaction
  ): DocGrantTarget;
  requireGrantedCurrent(grant: DocGrantRow, tx: DbTransaction): { id: string; scope: string };
  sourceRoot(documentId: string, tx?: DbTransaction): string | null;
  originCurrent(documentId: string, openerAgentId: string, tx?: DbTransaction): boolean;
  resolveWriteBinding?(documentId: string, tx?: DbTransaction): CanvasChannelGrant['write'];
}
/** Authenticated grant request. It cannot select approval evidence or resolved session/runtime. */
export const DocRouteGrantRequestSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    routeId: z.string().min(1).max(200),
    allowedTypes: z.array(CanvasChannelEventPatternSchema).min(1).max(128).optional(),
    limits: CanvasChannelGrantSchema.shape.limits.partial().optional(),
    expiresAt: CanvasChannelGrantSchema.shape.expiresAt,
    write: CanvasChannelGrantSchema.shape.write.optional(),
  })
  .strict();
/** One bounded proposed route grant. */
export type DocRouteGrantRequest = z.infer<typeof DocRouteGrantRequestSchema>;
/** A route cannot be granted or admitted under its current binding. */
export class DocRouteGrantError extends Error {
  /** Build a typed refusal that does not echo private document data. */
  constructor(
    readonly code: string,
    readonly status = 403
  ) {
    super(code);
    this.name = 'DocRouteGrantError';
  }
}
/** Select one stable declared route, rejecting missing declarations rather than inventing a default. */
export function declaredRoute(channel: DocChannelRow, routeId: string): CanvasChannelRoute {
  const declaration = CanvasChannelDeclarationSchema.safeParse(channel.declaration);
  const route = declaration.success
    ? declaration.data.routes.find((item) => item.id === routeId)
    : undefined;
  if (!route) throw new DocRouteGrantError('ROUTE_UNDECLARED');
  return route;
}
/** A grant pattern must be contained in its declared route pattern, including complete segments. */
export function containedPattern(routePattern: string, grantPattern: string): boolean {
  if (routePattern === grantPattern) return true;
  return routePattern.endsWith('.*') && grantPattern.startsWith(routePattern.slice(0, -1));
}
/** Canonical type set, narrowed to the route instead of silently broadening approval. */
export function grantTypes(route: CanvasChannelRoute, requested?: string[]): string[] {
  const types = [...new Set(requested ?? [route.on])].sort();
  if (types.some((type) => !containedPattern(route.on, type)))
    throw new DocRouteGrantError('TYPE_OUTSIDE_ROUTE');
  return types;
}
/** Verify a resolved target cannot escape the owning room or replace recorded opener identity. */
export function validateDocGrantTarget(
  scope: string,
  route: CanvasChannelRoute,
  opener: string | null,
  target: DocGrantTarget
): void {
  if (target.scope !== scope) throw new DocRouteGrantError('TARGET_SCOPE_MISMATCH');
  if (route.to === 'log') {
    if (
      target.agentId !== null ||
      target.sessionId !== null ||
      target.runtime !== null ||
      target.agentPath !== null
    )
      throw new DocRouteGrantError('TARGET_IDENTITY_MISMATCH');
    return;
  }
  if (route.to === 'room:self') {
    if (
      !scope.startsWith('room:') ||
      !target.agentId ||
      !target.sessionId ||
      !target.runtime ||
      !target.agentPath
    )
      throw new DocRouteGrantError('ROOM_ROUTE_UNAVAILABLE');
    return;
  }
  const expected = route.to === 'agent:owner' ? opener : route.to.slice('agent:'.length);
  if (
    !expected ||
    target.agentId !== expected ||
    !target.sessionId ||
    !target.runtime ||
    !target.agentPath
  )
    throw new DocRouteGrantError('TARGET_IDENTITY_MISMATCH');
}
