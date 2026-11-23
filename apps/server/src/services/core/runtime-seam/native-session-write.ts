/** Native discovery writes ownership evidence without certifying a new conversation. */
import { eq, isNull, sessionMetadata, sessionNativeBindings, type Db } from '@dorkos/db';
import type { Session } from '@dorkos/shared/types';
import { AmbiguousSessionError } from '../../session/resolution/session-lookup-error.js';
import { readDraftSource } from './person-draft-settings.js';
import { SessionBirthWriteError, withinSessionBirthWrite } from './session-birth-write.js';

/** Called only after the owning registry's caller and actual-directory checks. */
export function writeNativeSession(db: Db, session: Session): void {
  db.transaction((tx) =>
    withinSessionBirthWrite(tx, session.id, undefined, (tx) => {
      // A saved-folder draft can only be claimed by its first ordinary send.
      if (readDraftSource(tx, session.id)) throw new SessionBirthWriteError('context');
      const existing = tx
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, session.id))
        .get();
      if (existing?.runtime && existing.runtime !== session.runtime)
        throw new AmbiguousSessionError();
      const source = tx
        .select()
        .from(sessionNativeBindings)
        .where(eq(sessionNativeBindings.sessionId, session.id))
        .get();
      if (source?.account && session.account && source.account !== session.account)
        throw new AmbiguousSessionError();
      const createdAt = new Date().toISOString();
      tx.insert(sessionMetadata)
        .values({ sessionId: session.id, runtime: session.runtime, createdAt })
        .onConflictDoUpdate({
          target: sessionMetadata.sessionId,
          set: { runtime: session.runtime },
          setWhere: isNull(sessionMetadata.runtime),
        })
        .run();
      tx.insert(sessionNativeBindings)
        .values({
          sessionId: session.id,
          runtime: session.runtime,
          cwd: session.cwd!,
          account: session.account ?? source?.account ?? null,
          createdAt,
        })
        .onConflictDoUpdate({
          target: sessionNativeBindings.sessionId,
          set: { cwd: session.cwd!, account: session.account ?? source?.account ?? null },
        })
        .run();
    })
  );
}
