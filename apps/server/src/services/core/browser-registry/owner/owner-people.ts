/**
 * Which author ids are people's, for the browser registry (spec
 * `computer-side-starts-alone` §6): the registry is computer-side and never
 * reads the space side's `authors` table itself, so the space side answers
 * this one question for it.
 *
 * @module services/core/browser-registry/owner/owner-people
 */
import { authors, eq, type Db } from '@dorkos/db';
import type { BrowserOwnerPeople } from '../registry-store.js';

/**
 * The person check over the space side's author list.
 *
 * @param db - The DorkOS database.
 */
export function createBrowserOwnerPeople(db: Db): BrowserOwnerPeople {
  return {
    isPerson: (authorId) =>
      db.select({ kind: authors.kind }).from(authors).where(eq(authors.id, authorId)).get()
        ?.kind === 'human',
  };
}
