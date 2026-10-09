/** Private, durable launch folders addressed by opaque caller-scoped references. */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { and, eq, count } from 'drizzle-orm';
import { sessionLocations, type Db } from '@dorkos/db';
import { z } from 'zod';
import { BoundaryError, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { readOwnerAccount, type RequestUser } from '../services/core/auth/index.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

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
export function createSessionLocationsRouter(db: Db) {
  const router = Router();
  router.use((req, res, next) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.status(403).json({ error: PERSON_BAR.error, code: PERSON_BAR.code });
      return;
    }
    if (refuseIfNotAPerson(req, res, PERSON_BAR)) return;
    next();
  });
  router.post('/', async (req, res, next) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose a valid chat folder.' });
    const user = res.locals.user as RequestUser | undefined;
    const ownerId = user?.userId ?? readOwnerAccount()?.id ?? 'local';
    try {
      const cwd = await validateBoundaryOrDorkHome(parsed.data.cwd);
      const match = db
        .select()
        .from(sessionLocations)
        .where(and(eq(sessionLocations.ownerId, ownerId), eq(sessionLocations.cwd, cwd)))
        .get();
      if (match) return res.json({ id: match.id });
      const size =
        db
          .select({ value: count() })
          .from(sessionLocations)
          .where(eq(sessionLocations.ownerId, ownerId))
          .get()?.value ?? 0;
      if (size >= MAX_SESSION_LOCATIONS)
        return res
          .status(409)
          .json({ error: 'Too many saved chat folders.', code: 'SESSION_LOCATION_LIMIT' });
      const id = randomUUID();
      db.insert(sessionLocations)
        .values({ id, ownerId, cwd, createdAt: new Date().toISOString() })
        .run();
      return res.status(201).json({ id });
    } catch (error) {
      if (error instanceof BoundaryError)
        return res.status(403).json({ error: error.message, code: error.code });
      return next(error);
    }
  });
  router.get('/:id', async (req, res, next) => {
    if (!idSchema.safeParse(req.params.id).success)
      return res.status(404).json({ error: 'Chat folder not found.' });
    const user = res.locals.user as RequestUser | undefined;
    const ownerId = user?.userId ?? readOwnerAccount()?.id ?? 'local';
    const location = db
      .select()
      .from(sessionLocations)
      .where(
        and(eq(sessionLocations.id, req.params.id as string), eq(sessionLocations.ownerId, ownerId))
      )
      .get();
    if (!location) return res.status(404).json({ error: 'Chat folder not found.' });
    try {
      // Revalidate on every read: boundary changes and symlink retargets cannot widen access.
      const cwd = await validateBoundaryOrDorkHome(location.cwd);
      return res.json({ cwd });
    } catch (error) {
      if (error instanceof BoundaryError)
        return res.status(403).json({ error: error.message, code: error.code });
      return next(error);
    }
  });
  return router;
}
