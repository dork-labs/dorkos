/**
 * Route controls for one canvas document's event channel, as a person reads and
 * changes them from the canvas header.
 *
 * Every field is server-resolved. The client never names a target agent, a
 * session or a hash it computed itself: it echoes back the `reviewHash` the
 * server returned for exactly the details it showed, and the server refuses an
 * approval whose current binding no longer hashes to it.
 *
 * @module shared/canvas-doc-routes
 */
import { z } from 'zod';
import {
  CanvasChannelEventPatternSchema,
  CanvasChannelRouteSchema,
} from './canvas-channel-schemas.js';

const IdentifierSchema = z.string().min(1).max(200);
const TimestampSchema = z.string().max(64).datetime({ offset: true });

/** Where a route's events go, resolved to the agent's name where one is known. */
export const CanvasDocRouteDestinationSchema = z.discriminatedUnion('kind', [
  /** Events are kept on the document and start no work. */
  z.object({ kind: z.literal('log') }).strict(),
  /** The agent that opened the document; null when nobody opened it. */
  z
    .object({
      kind: z.literal('owner'),
      agentId: IdentifierSchema.nullable(),
      agentName: z.string().max(200).nullable(),
    })
    .strict(),
  /** One named agent. Its name is null when it is no longer registered. */
  z
    .object({
      kind: z.literal('agent'),
      agentId: IdentifierSchema,
      agentName: z.string().max(200).nullable(),
    })
    .strict(),
  /** The room the document is on, answered by this agent; null when nobody opened it. */
  z
    .object({
      kind: z.literal('room'),
      agentId: IdentifierSchema.nullable(),
      agentName: z.string().max(200).nullable(),
    })
    .strict(),
]);
/** A route destination, in words a person can read. */
export type CanvasDocRouteDestination = z.infer<typeof CanvasDocRouteDestinationSchema>;

/** The caps a route's grant carries, never above the platform's. */
export const CanvasDocRouteLimitsSchema = z
  .object({
    envelopeBytes: z.number().int().min(1),
    eventsPerMinute: z.number().int().min(1),
    turnsPerHour: z.number().int().min(1),
  })
  .strict();
/** Grant limits. */
export type CanvasDocRouteLimits = z.infer<typeof CanvasDocRouteLimitsSchema>;

/**
 * A route's state. Nothing here is inferred from silence: a declared route with
 * no grant is `no_grant`, and only a current, revalidated grant is `granted`.
 *
 * - `no_grant` — declared, never allowed.
 * - `granted` — a current grant admits its events.
 * - `waiting` — an agent asked and a person has not answered.
 * - `suspended` — the newest grant stopped matching the document, its app or its target.
 * - `revoked` — the newest grant was turned off.
 * - `expired` — the newest grant ran out of time.
 */
export const CanvasDocRouteStateSchema = z.enum([
  'no_grant',
  'granted',
  'waiting',
  'suspended',
  'revoked',
  'expired',
]);
/** One route's state. */
export type CanvasDocRouteState = z.infer<typeof CanvasDocRouteStateSchema>;

/** The newest grant a route has, current or not. */
export const CanvasDocRouteGrantSchema = z
  .object({
    grantId: IdentifierSchema,
    allowedTypes: z.array(CanvasChannelEventPatternSchema).min(1).max(128),
    limits: CanvasDocRouteLimitsSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
    /** Who allowed it: a person's approval, or the opening agent for its own route. */
    approvedBy: z.enum(['person', 'agent']),
  })
  .strict();
/** One grant, without its approval evidence. */
export type CanvasDocRouteGrant = z.infer<typeof CanvasDocRouteGrantSchema>;

/** One declared route as the header shows it. */
export const CanvasDocRouteSchema = z
  .object({
    id: IdentifierSchema,
    on: CanvasChannelRouteSchema.shape.on,
    to: CanvasChannelRouteSchema.shape.to,
    turn: z.enum(['none', 'immediate', 'coalesce']),
    destination: CanvasDocRouteDestinationSchema,
    /** True when only a person can allow it: another agent, or the room. */
    needsPerson: z.boolean(),
    state: CanvasDocRouteStateSchema,
    grant: CanvasDocRouteGrantSchema.nullable(),
    /** An agent's open request for this route, when there is one. */
    waiting: z.object({ approvalId: IdentifierSchema, expiresAt: TimestampSchema }).nullable(),
  })
  .strict();
/** One route row. */
export type CanvasDocRoute = z.infer<typeof CanvasDocRouteSchema>;

/** `GET /api/canvas/docs/:id/routes`. */
export const CanvasDocRoutesSchema = z
  .object({ documentId: IdentifierSchema, routes: z.array(CanvasDocRouteSchema).max(16) })
  .strict();
/** Every declared route on one document. */
export type CanvasDocRoutes = z.infer<typeof CanvasDocRoutesSchema>;

/** `POST /api/canvas/docs/:id/routes/:routeId/review` body. */
export const CanvasDocRouteReviewRequestSchema = z.object({ expiresAt: TimestampSchema }).strict();
/** What a person asks to review. */
export type CanvasDocRouteReviewRequest = z.infer<typeof CanvasDocRouteReviewRequestSchema>;

/** The exact details an approval would bind, resolved by the server. */
export const CanvasDocRouteReviewSchema = z
  .object({
    documentId: IdentifierSchema,
    routeId: IdentifierSchema,
    on: CanvasChannelRouteSchema.shape.on,
    destination: CanvasDocRouteDestinationSchema,
    allowedTypes: z.array(CanvasChannelEventPatternSchema).min(1).max(128),
    limits: CanvasDocRouteLimitsSchema,
    expiresAt: TimestampSchema,
    /** The server's hash of everything above plus the document, declaration and target. */
    reviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
/** One reviewed route approval. */
export type CanvasDocRouteReview = z.infer<typeof CanvasDocRouteReviewSchema>;

/** `POST /api/canvas/docs/:id/routes/:routeId/approve` body: what was reviewed, echoed. */
export const CanvasDocRouteApproveRequestSchema = z
  .object({ expiresAt: TimestampSchema, reviewHash: CanvasDocRouteReviewSchema.shape.reviewHash })
  .strict();
/** A person's approval of one reviewed route. */
export type CanvasDocRouteApproveRequest = z.infer<typeof CanvasDocRouteApproveRequestSchema>;

/** `POST /api/canvas/docs/:id/routes/:routeId/revoke` body: empty, the route is the subject. */
export const CanvasDocRouteRevokeRequestSchema = z.object({}).strict();
/** A person turning a route off, every grant it holds at once. */
export type CanvasDocRouteRevokeRequest = z.infer<typeof CanvasDocRouteRevokeRequestSchema>;

/** Approve and revoke answer with the route as it now stands. */
export const CanvasDocRouteChangeSchema = z.object({ route: CanvasDocRouteSchema }).strict();
/** One changed route. */
export type CanvasDocRouteChange = z.infer<typeof CanvasDocRouteChangeSchema>;
