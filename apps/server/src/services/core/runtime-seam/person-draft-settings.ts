/** Existing-row settings write for an admitted, still-unbound person-owned draft. */
import { isDeepStrictEqual } from 'node:util';
import {
  agents,
  and,
  eq,
  isNull,
  roomSessions,
  sessionBirthAllocations,
  sessionDraftSources,
  sessionLocations,
  sessionMetadata,
  sessionNativeBindings,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { RequiredRoomLaunchStore } from '../../rooms/reseat/required-launch-store.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { PreparedSettingsWriteError } from './prepared-settings-write.js';
import type { SessionBirthWriteContext } from './session-birth-write.js';
import type { pickSettings } from './session-metadata-columns.js';

type DraftSource = typeof sessionDraftSources.$inferSelect;

/** Exact stored source approved by the person before the write. */
export type PersonDraftWitness = DraftSource &
  (
    | { sourceKind: 'person-location'; locationId: string }
    | { sourceKind: 'person-agent'; registeredAgentId: string }
  );

export type PersonChatBinding =
  | { birth: Extract<SessionBirthWriteContext, { kind: 'person-location' | 'person-agent' }> }
  | { draft: PersonDraftWitness };

/** Read a protected draft by the exact id before accepting a write. */
export function readDraftSource(db: Db | DbTransaction, id: string) {
  return db.select().from(sessionDraftSources).where(eq(sessionDraftSources.sessionId, id)).get();
}

/** The registered agent `agentId`, as the agent registry recorded it. */
export function readRegisteredAgent(db: Db | DbTransaction, agentId: string) {
  return db.select().from(agents).where(eq(agents.id, agentId)).get();
}

/** Whether a freshly minted chat id already names a session, a runtime binding or a room's chat. */
export function chatIdInUse(tx: DbTransaction, sessionId: string): boolean {
  return Boolean(
    tx.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get() ||
    tx
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, sessionId))
      .get() ||
    tx.select().from(roomSessions).where(eq(roomSessions.sessionId, sessionId)).get()
  );
}

function matchesCurrentSource(tx: DbTransaction, witness: PersonDraftWitness): boolean {
  if (witness.sourceKind === 'person-agent') {
    const agent = tx.select().from(agents).where(eq(agents.id, witness.registeredAgentId)).get();
    return (
      agent?.projectPath === witness.sourcePath &&
      agent.registeredAt === witness.sourceCreatedAt &&
      !tx.select().from(roomSessions).where(eq(roomSessions.sessionId, witness.sessionId)).get()
    );
  }
  const location = tx
    .select()
    .from(sessionLocations)
    .where(
      and(
        eq(sessionLocations.id, witness.locationId),
        eq(sessionLocations.ownerId, witness.ownerId)
      )
    )
    .get();
  return location?.cwd === witness.sourcePath && location.createdAt === witness.sourceCreatedAt;
}

/** Re-read the draft and the current source generation in the authority transaction. */
export function assertPersonDraftSource(
  tx: DbTransaction,
  id: string,
  witness: PersonDraftWitness
): void {
  const draft = readDraftSource(tx, id);
  if (
    id !== witness.sessionId ||
    !isDeepStrictEqual(draft, witness) ||
    !matchesCurrentSource(tx, witness) ||
    primaryOf(id) !== id ||
    new RequiredRoomLaunchStore(tx).forSession(id) ||
    tx
      .select()
      .from(sessionBirthAllocations)
      .where(eq(sessionBirthAllocations.sessionId, id))
      .get() ||
    tx.select().from(sessionNativeBindings).where(eq(sessionNativeBindings.sessionId, id)).get()
  ) {
    throw new PreparedSettingsWriteError();
  }
}

/**
 * Patch the existing draft only if it still has the exact admitted source and no runtime owner.
 *
 * @param db - The installation database.
 * @param id - The canonical draft id used by the adapter.
 * @param witness - The admitted durable saved-location source tuple.
 * @param patch - Only the explicitly supplied settings fields.
 * @param assertAdapterCurrent - The same synchronous owner check used for a prepared first write.
 */
export function updatePersonDraftSettings(
  db: Db,
  id: string,
  witness: PersonDraftWitness,
  patch: ReturnType<typeof pickSettings>,
  assertAdapterCurrent: () => void
): void {
  db.transaction(
    (tx) => {
      assertAdapterCurrent();
      assertPersonDraftSource(tx, id, witness);
      const pending = and(
        eq(sessionMetadata.sessionId, id),
        isNull(sessionMetadata.runtime),
        eq(sessionMetadata.modelLaunchState, 'pending-v1')
      );
      if (tx.update(sessionMetadata).set(patch).where(pending).run().changes !== 1)
        throw new PreparedSettingsWriteError();
      assertAdapterCurrent();
      assertPersonDraftSource(tx, id, witness);
      if (!tx.select({ id: sessionMetadata.sessionId }).from(sessionMetadata).where(pending).get())
        throw new PreparedSettingsWriteError();
    },
    { behavior: 'immediate' }
  );
}
