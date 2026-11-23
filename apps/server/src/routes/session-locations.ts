/** Private, durable launch folders addressed by opaque caller-scoped references. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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
import { honoRequestFacts } from '../http/request-facts.js';
import { assessSessionLocationPerson, sessionLocationOwnerId } from './session-person-birth.js';

const bodySchema = z.object({ cwd: z.string().min(1) }).strict();
const idSchema = z.uuid();
const allocateBody = z.strictObject({});
const locationMissing = { error: 'Chat folder not found.' };
const agentMissing = { error: 'Agent not found' };
const chatConflict = {
  error: 'Could not start a new chat.',
  code: 'SESSION_ID_CONFLICT',
};
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
    if (refusal) return c.json(refusal.body, refusal.status as ContentfulStatusCode);
    await next();
  });
  router.post('/', async (c) => {
    const parsed = bodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Choose a valid chat folder.' }, 400);
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
        return c.json(
          { error: 'Too many saved chat folders.', code: 'SESSION_LOCATION_LIMIT' },
          409
        );
      const id = randomUUID();
      db.insert(sessionLocations)
        .values({ id, ownerId, cwd, createdAt: new Date().toISOString() })
        .run();
      return c.json({ id }, 201);
    } catch (error) {
      if (error instanceof BoundaryError)
        return c.json({ error: error.message, code: error.code }, 403);
      throw error;
    }
  });
  router.post('/chats', (c) => {
    const parsed = registeredAgentBody.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Choose a registered agent.' }, 400);
    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    const { agentId } = parsed.data;
    const projectPath = options.meshCore?.getProjectPath(agentId);
    if (!projectPath) return c.json(agentMissing, 404);
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
    if (result.kind === 'missing') return c.json(agentMissing, 404);
    if (result.kind === 'conflict') return c.json(chatConflict, 409);
    return c.json({ sessionId: result.sessionId }, 201);
  });
  router.post('/:id/chats', async (c) => {
    const id = c.req.param('id');
    if (!idSchema.safeParse(id).success) return c.json(locationMissing, 404);
    const raw = readJsonBody(c);
    if (!allocateBody.safeParse(raw === undefined ? {} : raw).success)
      return c.json({ error: 'Send an empty chat request.' }, 400);

    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    const location = ownedLocation(db, id, ownerId);
    if (!location) return c.json(locationMissing, 404);
    try {
      const cwd = await validateBoundaryOrDorkHome(location.cwd);
      if (cwd !== location.cwd) return c.json(locationMissing, 404);
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
      if (result.kind === 'missing') return c.json(locationMissing, 404);
      if (result.kind === 'conflict') return c.json(chatConflict, 409);
      return c.json({ sessionId: result.sessionId, launchRef: id }, 201);
    } catch (error) {
      if (error instanceof BoundaryError)
        return c.json({ error: error.message, code: error.code }, 403);
      throw error;
    }
  });
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!idSchema.safeParse(id).success) return c.json(locationMissing, 404);
    const ownerId = sessionLocationOwnerId(honoRequestFacts(c));
    const location = ownedLocation(db, id, ownerId);
    if (!location) return c.json(locationMissing, 404);
    try {
      // Revalidate on every read: boundary changes and symlink retargets cannot widen access.
      const cwd = await validateBoundaryOrDorkHome(location.cwd);
      return c.json({ cwd });
    } catch (error) {
      if (error instanceof BoundaryError)
        return c.json({ error: error.message, code: error.code }, 403);
      throw error;
    }
  });
  return router;
}
