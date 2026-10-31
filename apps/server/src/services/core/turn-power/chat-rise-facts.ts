/**
 * Whether one chat may follow its agent's level UP at the start of a turn
 * (DOR-3175), read from what the database keeps.
 *
 * The bound at the runtime seam (`agent-level-bound.ts`) lowers any turn to its
 * agent's level. Raising is narrower, and these are the facts it rests on, the
 * same ones the one-time raise of existing chats (DOR-3106) used, read per turn:
 *
 * **A person did not set the chat's mode** (`permission_mode_by_person`). A mode a
 * person picked on the chat is a cap the agent's level never lifts. Where the chat's
 * messages came from says nothing about it (Dorian 2026-10-30, DOR-3440).
 *
 * With nothing wired (a unit test, a process with no database) no chat rises.
 *
 * @module services/core/turn-power/chat-rise-facts
 */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { logger } from '../../../lib/logger.js';

/** What the seam asks about one chat. */
export interface ChatRiseFacts {
  /** Whether the chat may follow its agent's level up. Unknown answers `false`. */
  mayRise: (sessionId: string) => boolean;
  /** Whether a person set the chat's mode by hand. */
  personSet: (sessionId: string) => boolean;
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
  /** The chat's row, read under its first id. */
  const rowOf = (sessionId: string) =>
    db
      .select({ byPerson: sessionMetadata.permissionModeByPerson })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, primaryOf(sessionId)))
      .get();
  /** Run a read, answering `fallback` (and saying so) when it throws. */
  const guarded = (sessionId: string, fallback: boolean, read: () => boolean): boolean => {
    try {
      return read();
    } catch (err) {
      logger.warn('[agent-level] could not read a chat’s facts; it keeps its mode', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  };
  return {
    mayRise: (sessionId) =>
      guarded(sessionId, false, () => {
        const row = rowOf(sessionId);
        return !!row && row.byPerson !== true;
      }),
    personSet: (sessionId) => guarded(sessionId, false, () => rowOf(sessionId)?.byPerson === true),
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
