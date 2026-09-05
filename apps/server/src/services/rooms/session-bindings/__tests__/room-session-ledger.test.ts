/**
 * Which room a session answers for, asked by session id (DOR-1330).
 *
 * The lookup the Ask's fan-out makes on every prompt raised anywhere: a prompt
 * carries a session, and the room half of the card needs the room. It has to
 * survive the one thing this file's neighbours exist for — Claude Code renaming
 * a session mid-turn — because the turn whose id just moved is exactly the turn
 * whose prompt is live right now.
 *
 * Seeded defect, run and red before the fix: drop the `successorFor` chase from
 * `bindingForSession` and "follows a rename onto the id the room now holds"
 * answers `undefined`, which reads to a client as a prompt that belongs to no
 * room at all.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { roomSessions } from '@dorkos/db';
import { RoomSessionLedger } from '../room-session-ledger.js';

/** A ledger over an empty database, with one binding already written. */
function ledgerWith(binding: { roomId: string; authorId: string; sessionId: string }): {
  ledger: RoomSessionLedger;
  db: ReturnType<typeof createTestDb>;
} {
  const db = createTestDb();
  db.insert(roomSessions)
    .values({ ...binding, createdAt: new Date().toISOString() })
    .run();
  return { ledger: new RoomSessionLedger(db), db };
}

describe('RoomSessionLedger.bindingForSession', () => {
  it('answers the room and the author a session works for', () => {
    const { ledger } = ledgerWith({
      roomId: 'room-1',
      authorId: 'author-ana',
      sessionId: 'session-ana',
    });

    expect(ledger.bindingForSession('session-ana')).toEqual({
      roomId: 'room-1',
      authorId: 'author-ana',
      sessionId: 'session-ana',
    });
  });

  it('answers nothing for a session that answers for no room', () => {
    // The overwhelming majority of sessions. A prompt from one of them is still
    // a prompt — it just has no room to name on the wire.
    const { ledger } = ledgerWith({
      roomId: 'room-1',
      authorId: 'author-ana',
      sessionId: 'session-ana',
    });

    expect(ledger.bindingForSession('a-session-nobody-bound')).toBeUndefined();
  });

  it('follows a rename onto the id the room now holds', () => {
    // The rekey path: the runtime renames the session mid-turn, `rebindBySessionId`
    // moves the binding onto the new id and records the old one as retired. A
    // caller holding the id the turn STARTED under — the fan-out, on the prompt
    // that turn just raised — must still land on the room.
    const { ledger } = ledgerWith({
      roomId: 'room-1',
      authorId: 'author-ana',
      sessionId: 'placeholder-id',
    });

    ledger.rebindBySessionId('placeholder-id', 'canonical-id');

    expect(ledger.bindingForSession('canonical-id')).toMatchObject({ roomId: 'room-1' });
    expect(ledger.bindingForSession('placeholder-id')).toEqual({
      roomId: 'room-1',
      authorId: 'author-ana',
      sessionId: 'canonical-id',
    });
  });

  it('follows a rename that happened twice, to the end of the chain', () => {
    // `A → B → C` is reachable (the SDK assigns a new id on some resumes), and
    // stopping at `B` would answer with an id no transcript exists under.
    const { ledger } = ledgerWith({ roomId: 'room-1', authorId: 'author-ana', sessionId: 'id-a' });

    ledger.rebindBySessionId('id-a', 'id-b');
    ledger.rebindBySessionId('id-b', 'id-c');

    expect(ledger.bindingForSession('id-a')).toMatchObject({ sessionId: 'id-c' });
  });
});
