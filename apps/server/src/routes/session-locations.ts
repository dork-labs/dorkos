/** Private, durable launch folders addressed by opaque caller-scoped references. */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { MeshCore } from '@dorkos/mesh';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, sendProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';
import { honoRequestFacts } from '../http/request-facts.js';
import type { SessionLocationStore } from '../services/core/runtime-seam/session-location-store.js';
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
 * @param store - The saved folders and person allocations, bound to the installation database.
 * @param options - The current Mesh and optional deterministic fixture mint edge.
 * @returns The routes protected by the existing location person bar.
 */
export function createSessionLocationsRoutes(
  store: SessionLocationStore,
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
      const match = store.findByCwd(ownerId, cwd);
      if (match) return c.json({ id: match.id });
      if (store.countFor(ownerId) >= MAX_SESSION_LOCATIONS)
        return problem(c, 'conflict', { detail: 'Too many saved chat folders.' });
      const id = randomUUID();
      store.save({ id, ownerId, cwd, createdAt: new Date().toISOString() });
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
    const result = store.allocateAgentChat(mintChatId, ownerId, agentId, projectPath);
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
    const location = store.owned(id, ownerId);
    if (!location) return locationMissing(c);
    try {
      const cwd = await validateBoundaryOrDorkHome(location.cwd);
      if (cwd !== location.cwd) return locationMissing(c);
      const result = store.allocateLocationChat(mintChatId, ownerId, location);
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
    const location = store.owned(id, ownerId);
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
