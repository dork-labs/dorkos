/**
 * Whether one chat may follow its agent's level UP at the start of a turn
 * (DOR-3175), read from what the database keeps.
 *
 * The bound at the runtime seam (`agent-level-bound.ts`) lowers any turn to its
 * agent's level. Raising is narrower, and these are the facts it rests on, the
 * same ones the one-time raise of existing chats (DOR-3106) used, read per turn:
 *
 * - **A person did not set the chat's mode** (`permission_mode_by_person`). A
 *   mode a person picked on the chat is a cap the agent's level never lifts.
 * - **Our own launch, not marked** (`chatLaunchMarks`): no relay, bridged or
 *   outside origin, no marked opening message, and for a room seat a room of
 *   this computer with no bridge, no space copy and no marked, outside or
 *   Wi-Fi-held post. Read fresh every turn, rooms included.
 * - **Not held**: its latest turn did not read words DorkOS cannot vouch for
 *   (`lastTurnHeld`, which reads a chat with no record as held), and no
 *   stranger reached it (`chatHeardOutsider`).
 *
 * With nothing wired (a unit test, a process with no database) no chat rises.
 *
 * @module services/core/turn-power/chat-rise-facts
 */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import { chatLaunchMarks } from '../permissions/chat-launch-marks.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { chatHeardOutsider } from '../../session/origin/outsider-turns.js';
import { lastTurnHeld } from './continuation-hold.js';
import { logger } from '../../../lib/logger.js';

/** What the seam asks about one chat. */
export interface ChatRiseFacts {
  /** Whether the chat may follow its agent's level up. Unknown answers `false`. */
  mayRise: (sessionId: string) => boolean;
  /** Note that a person set the chat's mode themselves. Never throws. */
  notePersonSetMode: (sessionId: string) => void;
}

let facts: ChatRiseFacts | null = null;

/**
 * Hand over (or clear) where the facts are read.
 *
 * @param next - The facts over the database, or `null` to clear them.
 */
export function setChatRiseFacts(next: ChatRiseFacts | null): void {
  facts = next;
}

/** The facts in use, or `null` when none are wired (no chat rises). */
export function chatRiseFacts(): ChatRiseFacts | null {
  return facts;
}

/**
 * The facts over the consolidated database.
 *
 * @param db - The database `session_metadata` and the room tables live in.
 */
export function createChatRiseFacts(db: Db): ChatRiseFacts {
  // Rooms are read fresh: a post marked a minute ago must stop the next rise.
  const launchMarked = chatLaunchMarks(db, false);
  return {
    mayRise: (sessionId) => {
      try {
        const key = primaryOf(sessionId);
        const row = db
          .select({
            byPerson: sessionMetadata.permissionModeByPerson,
            launchOrigin: sessionMetadata.launchOrigin,
          })
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, key))
          .get();
        if (!row || row.byPerson === true) return false;
        if (launchMarked(key, row.launchOrigin)) return false;
        return !lastTurnHeld(key) && !chatHeardOutsider(key);
      } catch (err) {
        logger.warn('[agent-level] could not read whether a chat may rise; it keeps its mode', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    notePersonSetMode: (sessionId) => {
      try {
        db.insert(sessionMetadata)
          .values({
            sessionId: primaryOf(sessionId),
            runtime: null,
            createdAt: new Date().toISOString(),
            permissionModeByPerson: true,
          })
          .onConflictDoUpdate({
            target: sessionMetadata.sessionId,
            set: { permissionModeByPerson: true },
          })
          .run();
      } catch (err) {
        logger.warn('[agent-level] could not note a person’s chat mode', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
