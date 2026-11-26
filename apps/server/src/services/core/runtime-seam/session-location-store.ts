/**
 * The saved chat folders and a person's chat allocations, behind the routes that hand them out
 * (`routes/session-locations.ts`) and the routes that check one before a first send or a settings
 * change (`routes/session-person-birth.ts`). The routes never query the database (DOR-4923): every
 * read and write they need is a method here, bound to the installation database once.
 *
 * @module services/core/runtime-seam/session-location-store
 */
import {
  and,
  count,
  eq,
  sessionBirthAllocations,
  sessionLocations,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { chatIdInUse, readDraftSource, readRegisteredAgent } from './person-draft-settings.js';

/** One saved chat folder. */
export type SessionLocation = typeof sessionLocations.$inferSelect;

/** Where a person's new chat comes from: a saved folder, or a registered agent. */
type PersonAllocationSource =
  | { sourceKind: 'person-location'; locationId: string }
  | { sourceKind: 'person-agent'; registeredAgentId: string; recordedRegisteredPath: string };

/** What allocating a person's chat did: made one, collided with an id in use, or lost its source. */
export type PersonAllocation =
  { kind: 'created'; sessionId: string } | { kind: 'conflict' } | { kind: 'missing' };

/** The saved folders and person allocations, bound to one database. */
export interface SessionLocationStore {
  /** The caller's saved folder at exactly `cwd`, if they saved it before. */
  findByCwd(ownerId: string, cwd: string): SessionLocation | undefined;
  /** How many folders the caller has saved. */
  countFor(ownerId: string): number;
  /** Save a new folder. */
  save(location: SessionLocation): void;
  /** The caller's own saved folder `id`, or nothing for a missing or someone else's. */
  owned(id: string, ownerId: string): SessionLocation | undefined;
  /** Allocate a chat with a registered agent, if it is still registered at `projectPath`. */
  allocateAgentChat(
    mintChatId: () => string,
    ownerId: string,
    agentId: string,
    projectPath: string
  ): PersonAllocation;
  /** Allocate a chat in a saved folder, if the folder is still exactly `location`. */
  allocateLocationChat(
    mintChatId: () => string,
    ownerId: string,
    location: SessionLocation
  ): PersonAllocation;
  /** The allocation recorded for chat `id`, if any. */
  birthAllocation(id: string): typeof sessionBirthAllocations.$inferSelect | undefined;
  /** The protected draft recorded for chat `id`, if any. */
  draftSource(id: string): ReturnType<typeof readDraftSource>;
  /** The registered agent `agentId`, if any. */
  registeredAgent(agentId: string): ReturnType<typeof readRegisteredAgent>;
}

function mintPersonAllocation(
  tx: DbTransaction,
  mintChatId: () => string,
  ownerId: string,
  source: PersonAllocationSource
): PersonAllocation {
  const sessionId = mintChatId();
  if (chatIdInUse(tx, sessionId)) return { kind: 'conflict' };
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
  return inserted.changes === 1 ? { kind: 'created', sessionId } : { kind: 'conflict' };
}

function ownedLocation(db: Db | DbTransaction, id: string, ownerId: string) {
  return db
    .select()
    .from(sessionLocations)
    .where(and(eq(sessionLocations.id, id), eq(sessionLocations.ownerId, ownerId)))
    .get();
}

/**
 * Bind the saved folders and person allocations to the installation database.
 *
 * @param db - The installation's durable database.
 * @returns The store the session-location and session routes call.
 */
export function sessionLocationStore(db: Db): SessionLocationStore {
  return {
    findByCwd: (ownerId, cwd) =>
      db
        .select()
        .from(sessionLocations)
        .where(and(eq(sessionLocations.ownerId, ownerId), eq(sessionLocations.cwd, cwd)))
        .get(),
    countFor: (ownerId) =>
      db
        .select({ value: count() })
        .from(sessionLocations)
        .where(eq(sessionLocations.ownerId, ownerId))
        .get()?.value ?? 0,
    save: (location) => {
      db.insert(sessionLocations).values(location).run();
    },
    owned: (id, ownerId) => ownedLocation(db, id, ownerId),
    allocateAgentChat: (mintChatId, ownerId, agentId, projectPath) =>
      db.transaction(
        (tx) => {
          const agent = readRegisteredAgent(tx, agentId);
          if (agent?.projectPath !== projectPath) return { kind: 'missing' };
          return mintPersonAllocation(tx, mintChatId, ownerId, {
            sourceKind: 'person-agent',
            registeredAgentId: agentId,
            recordedRegisteredPath: projectPath,
          });
        },
        { behavior: 'immediate' }
      ),
    allocateLocationChat: (mintChatId, ownerId, location) =>
      db.transaction(
        (tx) => {
          const current = ownedLocation(tx, location.id, ownerId);
          if (!current || current.cwd !== location.cwd || current.createdAt !== location.createdAt)
            return { kind: 'missing' };
          return mintPersonAllocation(tx, mintChatId, ownerId, {
            sourceKind: 'person-location',
            locationId: location.id,
          });
        },
        { behavior: 'immediate' }
      ),
    birthAllocation: (id) =>
      db
        .select()
        .from(sessionBirthAllocations)
        .where(eq(sessionBirthAllocations.sessionId, id))
        .get(),
    draftSource: (id) => readDraftSource(db, id),
    registeredAgent: (agentId) => readRegisteredAgent(db, agentId),
  };
}
