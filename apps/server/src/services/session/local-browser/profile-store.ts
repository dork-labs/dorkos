/** Named Agent browser profiles, and the agents a person let use each one. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, agentBrowserProfileAgents, agentBrowserProfiles, type Db } from '@dorkos/db';
import type { LocalBrowserProfile } from '@dorkos/shared/local-browser';
import { logger } from '../../../lib/logger.js';

/** The profile records. It decides nothing; routes and the access check do. */
export interface LocalBrowserProfileStore {
  list(): LocalBrowserProfile[];
  get(id: string): LocalBrowserProfile | undefined;
  create(label: string): LocalBrowserProfile;
  /** Whether a binding exists for this agent at this real folder, with a valid signature. */
  isBound(profileId: string, agentId: string, agentFolder: string): boolean;
  /** Sign and store a binding. Call only after the person confirmed it's them. */
  bind(profileId: string, agentId: string, agentFolder: string): void;
  unbind(profileId: string, agentId: string): void;
}

/** What a signature covers. The prefix keeps it from meaning anything elsewhere. */
function signBinding(
  key: Buffer,
  binding: { profileId: string; agentId: string; agentFolder: string; createdAt: string }
): string {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        'dorkos.browser-profile-binding.v1',
        binding.profileId,
        binding.agentId,
        binding.agentFolder,
        binding.createdAt,
      ])
    )
    .digest('hex');
}

function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Build the profile records on the server's database.
 *
 * @param db - The server's database.
 * @param bindingKey - Reads the key bindings are signed with.
 */
export function createLocalBrowserProfileStore(
  db: Db,
  bindingKey: () => Buffer
): LocalBrowserProfileStore {
  const agentIds = (profileId: string) =>
    db
      .select({ agentId: agentBrowserProfileAgents.agentId })
      .from(agentBrowserProfileAgents)
      .where(eq(agentBrowserProfileAgents.profileId, profileId))
      .all()
      .map((row) => row.agentId);
  const matching = (profileId: string, agentId: string) =>
    and(
      eq(agentBrowserProfileAgents.profileId, profileId),
      eq(agentBrowserProfileAgents.agentId, agentId)
    );
  return {
    list: () =>
      db
        .select()
        .from(agentBrowserProfiles)
        .all()
        .map((row) => ({ ...row, agentIds: agentIds(row.id) })),
    get(id) {
      const row = db
        .select()
        .from(agentBrowserProfiles)
        .where(eq(agentBrowserProfiles.id, id))
        .get();
      return row && { ...row, agentIds: agentIds(id) };
    },
    create(label) {
      // The id names a folder on disk, so the server always chooses it.
      const row = { id: randomUUID(), label, createdAt: new Date().toISOString() };
      db.insert(agentBrowserProfiles).values(row).run();
      return { ...row, agentIds: [] };
    },
    isBound(profileId, agentId, agentFolder) {
      const row = db
        .select()
        .from(agentBrowserProfileAgents)
        .where(matching(profileId, agentId))
        .get();
      if (!row) return false;
      const expected = signBinding(bindingKey(), {
        profileId,
        agentId,
        agentFolder,
        createdAt: row.createdAt,
      });
      if (sameSignature(row.signature, expected)) return true;
      // A row that fails here was forged, or its agent moved folders. Either way a person
      // adds it again. Ids only: never the signature.
      logger.warn('[Browser] A browser profile binding failed its signature check', {
        profileId,
        agentId,
      });
      return false;
    },
    bind(profileId, agentId, agentFolder) {
      const createdAt = new Date().toISOString();
      const signature = signBinding(bindingKey(), { profileId, agentId, agentFolder, createdAt });
      db.insert(agentBrowserProfileAgents)
        .values({ profileId, agentId, createdAt, signature })
        .onConflictDoUpdate({
          target: [agentBrowserProfileAgents.profileId, agentBrowserProfileAgents.agentId],
          set: { createdAt, signature },
        })
        .run();
    },
    unbind(profileId, agentId) {
      db.delete(agentBrowserProfileAgents).where(matching(profileId, agentId)).run();
    },
  };
}
