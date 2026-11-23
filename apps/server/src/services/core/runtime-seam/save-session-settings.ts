/** Explicit settings writes and their optional scoped synchronous publication edge. */
import { sessionMetadata, type Db } from '@dorkos/db';
import type { SessionSettings } from '@dorkos/shared/types';
import { readDraftSource, updatePersonDraftSettings } from './person-draft-settings.js';
import { pickSettings } from './session-metadata-columns.js';
import { PreparedSettingsWriteError, preparedSettingsWrite } from './prepared-settings-write.js';
import { withSessionBirthWrite, type SessionBirthWriteContext } from './session-birth-write.js';

/** Persist the explicit patch, then publish a scoped owner only after its standalone commit. */
export function writeSessionSettings(
  db: Db,
  sessionId: string,
  settings: SessionSettings,
  birth?: SessionBirthWriteContext
): void {
  const patch = pickSettings(settings);
  if (Object.keys(patch).length === 0) return;
  const prepared = preparedSettingsWrite(sessionId, birth);
  try {
    // A nested savepoint is not a durable commit edge for local publication.
    if (prepared && db.$client.inTransaction) throw new PreparedSettingsWriteError();
    if (prepared && 'draft' in prepared.target) {
      updatePersonDraftSettings(
        db,
        sessionId,
        prepared.target.draft,
        patch,
        prepared.assertCurrent
      );
    } else {
      withSessionBirthWrite(
        db,
        sessionId,
        prepared && 'birth' in prepared.target ? prepared.target.birth : birth,
        (tx, insertBirth) => {
          prepared?.assertCurrent();
          if (readDraftSource(tx, sessionId)) throw new PreparedSettingsWriteError();
          return (
            tx
              .insert(sessionMetadata)
              .values({
                sessionId,
                // No owner: a preference chosen in a picker is not a binding.
                runtime: null,
                createdAt: new Date().toISOString(),
                ...patch,
                ...insertBirth,
              })
              // The UPDATE branch carries the patch alone — it must not disturb a
              // binding, and there is nothing else here to write.
              .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: patch })
              .run()
          );
        }
      );
    }
    prepared?.committed();
  } catch (error) {
    prepared?.failed(error);
    throw error;
  }
}
