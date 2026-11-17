/** Canonical settings/native rekey with atomic recovery identity preservation. */
import {
  eq,
  or,
  sessionMetadata,
  sessionNativeBindings,
  sessionContext,
  sessionEvents,
  sessionStartedBy,
  sessionLimits,
  sessionTouches,
  pulseRuns,
  heartbeatBeats,
  roomSessions,
  roomSessionRetirements,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { RequiredSessionIdentityError } from '../../../lib/replay/required-session-identity-error.js';
import { SessionStartedByStore } from '../origin/session-started-by-store.js';
import { SessionTouchStore } from '../origin/session-touch-store.js';
import { SessionLimitStore } from '../fleet/session-limit-store.js';
import { moveScheduledChats } from '../origin/rekey-moves.js';
import { RequiredRoomLaunchStore } from '../../rooms/reseat/required-launch-store.js';
type Metadata = typeof sessionMetadata.$inferSelect;
/** Move settings and native rows without silently merging a recovery billing conflict. */
export function rekeySessionMetadata(
  db: Db | DbTransaction,
  from: string,
  to: string,
  source: Metadata,
  destination: Metadata | undefined
): void {
  db.transaction((tx) => {
    const store = new RequiredRoomLaunchStore(tx);
    const requiredSource = store.forSession(from);
    const requiredDestination = store.forSession(to);
    if (
      (requiredDestination && requiredSource?.id !== requiredDestination.id) ||
      (requiredSource && destination?.runtime && destination.runtime !== requiredSource.runtime)
    ) {
      throw new Error('Recovery alias requirements conflict.');
    }
    const native = tx
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, from))
      .get();
    const nativeTarget = tx
      .select()
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, to))
      .get();
    if (
      requiredSource &&
      nativeTarget &&
      (nativeTarget.runtime !== requiredSource.runtime ||
        nativeTarget.account !== requiredSource.root)
    ) {
      throw new Error('Recovery alias account conflicts.');
    }
    if (native) {
      tx.insert(sessionNativeBindings)
        .values({ ...native, sessionId: to })
        .onConflictDoNothing({ target: sessionNativeBindings.sessionId })
        .run();
      tx.delete(sessionNativeBindings).where(eq(sessionNativeBindings.sessionId, from)).run();
    }
    tx.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, from)).run();
    if (!destination)
      tx.insert(sessionMetadata)
        .values({ ...source, sessionId: to })
        .run();
    else
      tx.update(sessionMetadata)
        .set({
          runtime: destination.runtime ?? source.runtime,
          permissionMode: destination.permissionMode ?? source.permissionMode,
          model: destination.model ?? source.model,
          effort: destination.effort ?? source.effort,
          fastMode: destination.fastMode ?? source.fastMode,
          agentPath: destination.agentPath ?? source.agentPath,
          launchOrigin: destination.launchOrigin ?? source.launchOrigin,
          launchedBy: destination.launchedBy ?? source.launchedBy,
          lastAutoResumeFor: destination.lastAutoResumeFor ?? source.lastAutoResumeFor,
          requiredLaunchId: destination.requiredLaunchId ?? source.requiredLaunchId,
        })
        .where(eq(sessionMetadata.sessionId, to))
        .run();
    if (requiredSource) {
      // Old-id sends retain the same restriction after canonicalization.
      tx.insert(sessionMetadata)
        .values({ ...source, sessionId: from, runtime: null, requiredLaunchId: requiredSource.id })
        .run();
      store.rekey(from, to);
    }
  });
}

/** One required owner; unknown storage responsibility never means optional loss. */
export function rekeyRequiredSessionIdentity(
  db: Db,
  from: string,
  to: string,
  liveOwner?: () => boolean
): boolean {
  try {
    return db.transaction(
      (tx) => {
        const requirements = new RequiredRoomLaunchStore(tx);
        const required = requirements.forSession(from);
        const requiredTarget = requirements.forSession(to);
        if (!required && !requiredTarget) return false;
        if (!required || (requiredTarget && requiredTarget.id !== required.id))
          throw new Error('Recovery alias requirements conflict.');
        // Pure synchronous observation of existing live owners, never a memory commit.
        if (liveOwner && !liveOwner())
          throw new Error('Recovery live identity is independently occupied.');
        const source = tx
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, from))
          .get();
        const destination = tx
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, to))
          .get();
        if (!source) throw new Error('Recovery source metadata is missing.');
        const nativeSource = tx
          .select()
          .from(sessionNativeBindings)
          .where(eq(sessionNativeBindings.sessionId, from))
          .get();
        if (
          nativeSource &&
          (nativeSource.runtime !== required.runtime || nativeSource.account !== required.root)
        )
          throw new Error('Recovery source native identity conflicts.');
        const ownedAlias =
          requiredTarget?.id === required.id && required.destinationSessionId === to;
        if (
          tx
            .select()
            .from(roomSessionRetirements)
            .where(eq(roomSessionRetirements.retiredSessionId, to))
            .get()
        ) {
          throw new Error('Recovery destination is a retired room identity.');
        }
        const bindings = tx.select().from(roomSessions).where(eq(roomSessions.sessionId, to)).all();
        if (
          bindings.some(
            (binding) =>
              !ownedAlias ||
              binding.roomId !== required.roomId ||
              binding.authorId !== required.authorId
          )
        ) {
          throw new Error('Recovery destination belongs to an independent room binding.');
        }
        if (
          !ownedAlias &&
          (destination ||
            tx
              .select()
              .from(sessionNativeBindings)
              .where(eq(sessionNativeBindings.sessionId, to))
              .get() ||
            tx.select().from(sessionEvents).where(eq(sessionEvents.sessionId, to)).get() ||
            tx
              .select()
              .from(sessionStartedBy)
              .where(
                or(eq(sessionStartedBy.sessionId, to), eq(sessionStartedBy.startedBySessionId, to))
              )
              .get() ||
            tx.select().from(sessionContext).where(eq(sessionContext.sessionId, to)).get() ||
            tx.select().from(sessionLimits).where(eq(sessionLimits.sessionId, to)).get() ||
            tx.select().from(sessionTouches).where(eq(sessionTouches.sessionId, to)).get() ||
            tx.select().from(pulseRuns).where(eq(pulseRuns.sessionId, to)).get() ||
            tx.select().from(heartbeatBeats).where(eq(heartbeatBeats.turnSessionId, to)).get())
        )
          throw new Error('Recovery destination is independently occupied.');
        rekeySessionMetadata(tx, from, to, source, destination);
        new SessionStartedByStore(db).moveWithin(tx, from, to);
        new SessionTouchStore(db).moveWithin(tx, from, to);
        new SessionLimitStore(db).rekeyWithin(tx, from, to);
        moveSessionContextWithin(tx, from, to);
        moveScheduledChats(tx, from, to);
        return true;
      },
      { behavior: 'immediate' }
    );
  } catch (error) {
    if (error instanceof RequiredSessionIdentityError) throw error;
    throw new RequiredSessionIdentityError(error);
  }
}

/** Optional context move uses the same implementation on its own transaction. */
export function moveSessionContext(db: Db, from: string, to: string): void {
  db.transaction((tx) => moveSessionContextWithin(tx, from, to));
}
function moveSessionContextWithin(tx: DbTransaction, from: string, to: string): void {
  const source = tx.select().from(sessionContext).where(eq(sessionContext.sessionId, from)).get();
  if (!source) return;
  const destination = tx
    .select()
    .from(sessionContext)
    .where(eq(sessionContext.sessionId, to))
    .get();
  tx.delete(sessionContext).where(eq(sessionContext.sessionId, from)).run();
  if (destination && destination.observedAt >= source.observedAt) return;
  tx.insert(sessionContext)
    .values({ ...source, sessionId: to })
    .onConflictDoUpdate({
      target: sessionContext.sessionId,
      set: {
        contextTokens: source.contextTokens,
        contextMaxTokens: source.contextMaxTokens,
        observedAt: source.observedAt,
      },
    })
    .run();
}
