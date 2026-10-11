/** Private, durable launch folders addressed by opaque caller-scoped references. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { and, eq, count } from 'drizzle-orm';
import { sessionLocations, type Db } from '@dorkos/db';
import { z } from 'zod';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { assessPerson, type PersonBarCopy } from './extensions-person-bar.js';

const PERSON_BAR: PersonBarCopy = {
  error: 'Only a person can choose a chat folder.',
  code: 'SESSION_LOCATION_PERSON_REQUIRED',
  subject: 'chat folders',
  crossSite: () => 'Open DorkOS to choose a chat folder.',
  agent: 'Only a person can choose a chat folder.',
};
const bodySchema = z.object({ cwd: z.string().min(1) }).strict();
const idSchema = z.uuid();
/** Bounded without evicting bookmarked locations. Existing folders are always reusable. */
export const MAX_SESSION_LOCATIONS = 1000;

/** Build the launch-location API against the install's durable database. */
export function createSessionLocationsRoutes(db: Db): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  // Every path under the mount, routed or not, as the Express `router.use` ran.
  router.use('*', async (c, next) => {
    const facts = honoRequestFacts(c);
    if (facts.headers['sec-fetch-site'] === 'cross-site') {
      return c.json({ error: PERSON_BAR.error, code: PERSON_BAR.code }, 403);
    }
    const refusal = assessPerson(facts, PERSON_BAR);
    if (refusal) return c.json(refusal.body, refusal.status as ContentfulStatusCode);
    await next();
  });
  router.post('/', async (c) => {
    const parsed = bodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Choose a valid chat folder.' }, 400);
    const ownerId = c.get('user')?.userId ?? readOwnerAccount()?.id ?? 'local';
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
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!idSchema.safeParse(id).success) return c.json({ error: 'Chat folder not found.' }, 404);
    const ownerId = c.get('user')?.userId ?? readOwnerAccount()?.id ?? 'local';
    const location = db
      .select()
      .from(sessionLocations)
      .where(and(eq(sessionLocations.id, id), eq(sessionLocations.ownerId, ownerId)))
      .get();
    if (!location) return c.json({ error: 'Chat folder not found.' }, 404);
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
