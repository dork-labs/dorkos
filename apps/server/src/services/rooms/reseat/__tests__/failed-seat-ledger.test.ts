/** DOR-4626: the durable failed-chat record restores once, only in a later process, and refuses the rest. */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, roomSeatFailures } from '@dorkos/db';
import {
  FAILED_SEAT_RESTORE_MAX_MS,
  FailedSeatLedger,
  type FailedSeatRecord,
} from '../failed-seat-ledger.js';
import { HANDOFF_WAIT_MAX_MS } from '../../handoff/room-handoff.js';

const NOW = 1_800_000_000_000;
const RECORD: FailedSeatRecord = {
  dispatchId: 'dsp_failed',
  entryId: 'entry-1',
  root: '/fixture/account',
  inference: 'own-account',
  billing: 'subscription',
  carry: {
    externalAuthor: true,
    permissionCeiling: [
      { asks: 'always', reach: 'read', outsider: true },
      { asks: 'when-risky', reach: 'edit', teammate: [{ roomId: 'r', authorId: 'a' }] },
    ],
    outsider: true,
    outsideWords: true,
  },
};

/** Two ledgers over one database: the process that wrote, and a later one. */
function processes() {
  const db = createTestDb();
  return {
    db,
    writer: new FailedSeatLedger(db, 'boot-a'),
    later: new FailedSeatLedger(db, 'boot-b'),
    another: new FailedSeatLedger(db, 'boot-c'),
  };
}

describe('FailedSeatLedger', () => {
  it('restores the exact record only in a later process', () => {
    const { writer, later } = processes();
    writer.record('chat-1', RECORD, NOW);
    expect(writer.restore('chat-1', NOW)).toBeNull();
    expect(later.restore('chat-1', NOW + 1)).toEqual(RECORD);
    expect(later.restore('chat-2', NOW + 1)).toBeNull();
  });

  it('is spent by one claim, for this attempt only, and never again after another restart', () => {
    const { db, writer, later, another } = processes();
    writer.record('chat-1', RECORD, NOW);
    expect(later.claim('chat-1', NOW + 1)).toBe(true);
    // The claiming attempt still reads its own row; nobody else does.
    expect(later.restore('chat-1', NOW + 2)).toEqual(RECORD);
    expect(another.restore('chat-1', NOW + 2)).toBeNull();
    expect(another.claim('chat-1', NOW + 2)).toBe(false);
    expect(later.claim('chat-1', NOW + 2)).toBe(false);
    later.endClaim('chat-1');
    expect(later.restore('chat-1', NOW + 3)).toBeNull();
    expect(new FailedSeatLedger(db, 'boot-d').restore('chat-1', NOW + 3)).toBeNull();
  });

  it('never lets the writing process claim its own row', () => {
    const { writer, later } = processes();
    writer.record('chat-1', RECORD, NOW);
    expect(writer.claim('chat-1', NOW + 1)).toBe(false);
    expect(later.restore('chat-1', NOW + 1)).toEqual(RECORD);
  });

  it('is spent when a recovery moved the seat, whoever recorded it', () => {
    const { writer, later } = processes();
    writer.record('chat-1', RECORD, NOW);
    writer.consume('chat-1', NOW + 1);
    expect(later.restore('chat-1', NOW + 2)).toBeNull();
    expect(later.claim('chat-1', NOW + 2)).toBe(false);
  });

  it('a new failure replaces the spent record and is restorable again', () => {
    const { writer, later, another } = processes();
    writer.record('chat-1', RECORD, NOW);
    expect(later.claim('chat-1', NOW + 1)).toBe(true);
    later.endClaim('chat-1');
    later.record('chat-1', { ...RECORD, dispatchId: 'dsp_next' }, NOW + 2);
    expect(another.restore('chat-1', NOW + 3)).toMatchObject({ dispatchId: 'dsp_next' });
  });

  it.each([
    ['too old', NOW + FAILED_SEAT_RESTORE_MAX_MS + 1],
    ['from the future', NOW - 1],
  ])('refuses a record %s', (_label, at) => {
    const { writer, later } = processes();
    writer.record('chat-1', RECORD, NOW);
    expect(later.restore('chat-1', at)).toBeNull();
    expect(later.claim('chat-1', at)).toBe(false);
  });

  it.each([
    ['unparseable', 'not json'],
    ['an unknown field', JSON.stringify({ version: 1, ...RECORD, credential: 'x' })],
    ['another version', JSON.stringify({ ...RECORD, version: 2 })],
    ['no ceiling', JSON.stringify({ version: 1, ...RECORD, carry: { externalAuthor: false } })],
    ['an unnormalized root', JSON.stringify({ version: 1, ...RECORD, root: '/fixture/../x' })],
    [
      'a looser unknown level',
      JSON.stringify({
        version: 1,
        ...RECORD,
        carry: { ...RECORD.carry, permissionCeiling: { asks: 'never', reach: 'all' } },
      }),
    ],
  ])('refuses a corrupt record: %s', (_label, payload) => {
    const { db, writer, later } = processes();
    writer.record('chat-1', RECORD, NOW);
    db.update(roomSeatFailures)
      .set({ payload })
      .where(eq(roomSeatFailures.sessionId, 'chat-1'))
      .run();
    expect(later.restore('chat-1', NOW + 1)).toBeNull();
    expect(later.claim('chat-1', NOW + 1)).toBe(false);
  });

  it('never writes a record without its level', () => {
    const { writer, later } = processes();
    const { permissionCeiling: _dropped, ...carry } = RECORD.carry;
    expect(() =>
      writer.record('chat-1', { ...RECORD, carry } as unknown as FailedSeatRecord, NOW)
    ).toThrow();
    expect(later.restore('chat-1', NOW + 1)).toBeNull();
  });

  it('drops records too old to restore when the next failure is written', () => {
    const { db, writer } = processes();
    writer.record('old-chat', RECORD, NOW);
    writer.record('new-chat', RECORD, NOW + FAILED_SEAT_RESTORE_MAX_MS + 1);
    expect(
      db
        .select()
        .from(roomSeatFailures)
        .all()
        .map((row) => row.sessionId)
    ).toEqual(['new-chat']);
  });

  it('restores for as long as a hand-off waits, and no longer', () => {
    expect(FAILED_SEAT_RESTORE_MAX_MS).toBe(HANDOFF_WAIT_MAX_MS);
  });
});
