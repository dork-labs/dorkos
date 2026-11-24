/** Private, durable launch folders addressed by opaque caller-scoped references. */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, eq, count } from 'drizzle-orm';
import {
  agents,
  roomSessions,
  sessionBirthAllocations,
  sessionLocations,
  sessionMetadata,
  sessionNativeBindings,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { z } from 'zod';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { MeshCore } from '@dorkos/mesh';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, sendProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { assessSessionLocationPerson, sessionLocationOwnerId } from './session-person-birth.js';

const bodySchema = z.object({ cwd: z.string().min(1) }).strict();
const idSchema = z.uuid();
const allocateBody = z.strictObject({});
/** A saved folder this caller does not have. */
const locationMissing = (c: Context<ApiEnv>) =>
  problem(c, 'not_found', { detail: 'Chat folder not found.' });
/** A registered agent this caller cannot start a chat with. */
const agentMissing = (c: Context<ApiEnv>) =>
  problem(c, 'not_found', { detail: 'That agent isn’t registered here.' });
/** A new chat id that collided with one already in use: nothing was started. */
const chatConflict = (c: Context<ApiEnv>) =>
  problem(c, 'conflict', { detail: 'Couldn’t start a new chat. Try again.' });
const registeredAgentBody = z.strictObject({
  kind: z.literal('registered-agent'),
  agentId: AgentManifestSchema.shape.id,
});

type PersonAllocationSource =
  | { sourceKind: 'person-location'; locationId: string }
  | { sourceKind: 'person-agent'; registeredAgentId: string; recordedRegisteredPath: string };

function mintPersonAllocation(
  tx: DbTransaction,
  mintChatId: () => string,
  ownerId: string,
  source: PersonAllocationSource
) {
  const sessionId = mintChatId();
  if (
    tx.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get() ||
    tx
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, sessionId))
      .get() ||
    tx.select().from(roomSessions).where(eq(roomSessions.sessionId, sessionId)).get()
  )
    return { kind: 'conflict' } as const;
  const inserted = tx
    .insert(sessionBirthAllocations)
    .values({
      sessionId,
      version: 1,
      createdAt: new Date().toISOString(),
      ownerId,
      ...source,
    })
    .onConflictDoNothing({ target: sessionBirthAllocations.sessionId })
    .run();
  return inserted.changes === 1
    ? ({ kind: 'created', sessionId } as const)
    : ({ kind: 'conflict' } as const);
}

function ownedLocation(db: Db | DbTransaction, id: string, ownerId: string) {
  return db
    .select()
    .from(sessionLocations)
    .where(and(eq(sessionLocations.id, id), eq(sessionLocations.ownerId, ownerId)))
    .get();
}

interface SessionLocationRouteOptions {
  /** The same live Mesh used to resolve the agent on first send. */
  meshCore?: Pick<MeshCore, 'getProjectPath'>;
  /** Internal mint edge. Production uses randomUUID and never retries a collision. */
  mintChatId?: () => string;
}
/** Bounded without evicting bookmarked locations. Existing folders are always reusable. */
export const MAX_SESSION_LOCATIONS = 1000;

/**
 * Build the saved-location and chat allocation routes on the installation database.
 *
 * @param db - The installation's durable database.
 * @param options - The current Mesh and optional deterministic fixture mint edge.
 * @returns The routes protected by the existing location person bar.
 */
export function createSessionLocationsRoutes(
  db: Db,
  options: SessionLocationRouteOptions = {}
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const mintChatId = options.mintChatId ?? randomUUID;
  // Every path under the mount, routed or not, as the Express `router.use` ran.
  router.use('*', async (c, next) => {
    const refusal = assessSessionLocationPerson(honoRequestFacts(c));
    if (refusal) return sendProblem(c, refusal.body);
    await next();
  });
  router.post('/', async (c) => {
    const parsed = bodySchema.safeParse(readJsonBody(c));
    if (!parsed.success)
      return problem(c, 'invalid_request', { detail: 'Choose a valid chat folder.' });
    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    try {
      const cwd = await validateBoundaryOrDorkHome(parsed.data.cwd);
      const match = db
        .select()
        .from(sessionLocations)
        .where(and(eq(sessionLocations.ownerId, ownerId), eq(sessionLocations.cwd, cwd)))
        .get();
      if (match) return c.json({ id: match.id });
      const size =
        db
          .select({ value: count() })
          .from(sessionLocations)
          .where(eq(sessionLocations.ownerId, ownerId))
          .get()?.value ?? 0;
      if (size >= MAX_SESSION_LOCATIONS)
        return problem(c, 'conflict', { detail: 'Too many saved chat folders.' });
      const id = randomUUID();
      db.insert(sessionLocations)
        .values({ id, ownerId, cwd, createdAt: new Date().toISOString() })
        .run();
      return c.json({ id }, 201);
    } catch (error) {
      if (error instanceof BoundaryError) return boundaryProblem(c, error);
      throw error;
    }
  });
  router.post('/chats', (c) => {
    const parsed = registeredAgentBody.safeParse(readJsonBody(c));
    if (!parsed.success)
      return problem(c, 'invalid_request', { detail: 'Choose a registered agent.' });
    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    const { agentId } = parsed.data;
    const projectPath = options.meshCore?.getProjectPath(agentId);
    if (!projectPath) return agentMissing(c);
    const result = db.transaction(
      (tx) => {
        const agent = tx.select().from(agents).where(eq(agents.id, agentId)).get();
        if (agent?.projectPath !== projectPath) return { kind: 'missing' } as const;
        return mintPersonAllocation(tx, mintChatId, ownerId, {
          sourceKind: 'person-agent',
          registeredAgentId: agentId,
          recordedRegisteredPath: projectPath,
        });
      },
      { behavior: 'immediate' }
    );
    if (result.kind === 'missing') return agentMissing(c);
    if (result.kind === 'conflict') return chatConflict(c);
    return c.json({ sessionId: result.sessionId }, 201);
  });
  router.post('/:id/chats', async (c) => {
    const id = c.req.param('id');
    if (!idSchema.safeParse(id).success) return locationMissing(c);
    const raw = readJsonBody(c);
    if (!allocateBody.safeParse(raw === undefined ? {} : raw).success)
      return problem(c, 'invalid_request', { detail: 'Send an empty chat request.' });

    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    const location = ownedLocation(db, id, ownerId);
    if (!location) return locationMissing(c);
    try {
      const cwd = await validateBoundaryOrDorkHome(location.cwd);
      if (cwd !== location.cwd) return locationMissing(c);
      const result = db.transaction(
        (tx) => {
          const current = ownedLocation(tx, id, ownerId);
          if (!current || current.cwd !== location.cwd || current.createdAt !== location.createdAt)
            return { kind: 'missing' } as const;
          return mintPersonAllocation(tx, mintChatId, ownerId, {
            sourceKind: 'person-location',
            locationId: id,
          });
        },
        { behavior: 'immediate' }
      );
      if (result.kind === 'missing') return locationMissing(c);
      if (result.kind === 'conflict') return chatConflict(c);
      return c.json({ sessionId: result.sessionId, launchRef: id }, 201);
    } catch (error) {
      if (error instanceof BoundaryError) return boundaryProblem(c, error);
      throw error;
    }
  });
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!idSchema.safeParse(id).success) return locationMissing(c);
    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    const location = ownedLocation(db, id, ownerId);
    if (!location) return locationMissing(c);
    try {
      // Revalidate on every read: boundary changes and symlink retargets cannot widen access.
      const cwd = await validateBoundaryOrDorkHome(location.cwd);
      return c.json({ cwd });
    } catch (error) {
      if (error instanceof BoundaryError) return boundaryProblem(c, error);
      throw error;
    }
  });
  return router;
}
