/**
 * A recovery chat's canonical rename merges into an existing row through `rekeySessionMetadata`.
 * It must join the holds as every canonical rename does (DOR-4593), so a rename never loosens a
 * chat, and keep the chat's launch requirement (DOR-4328).
 */
import {
  eq,
  roomSeatLaunchRequirements,
  sessionBirthAllocations,
  sessionMetadata,
  type Db,
} from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequiredRoomLaunchStore } from '../../../rooms/reseat/required-launch-store.js';
import { rekeySessionMetadata } from '../rekey-metadata.js';

type Row = typeof sessionMetadata.$inferSelect;

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

/** A recovery requirement owned by `sessionId`, as the seat mover publishes it. */
function requirement(id: string, sessionId: string): void {
  db.insert(roomSeatLaunchRequirements)
    .values({
      id,
      destinationSessionId: sessionId,
      sourceSessionId: `failed-${id}`,
      sourceDispatchId: `dispatch-${id}`,
      startSeq: 1,
      endSeq: 8,
      payload: JSON.stringify({
        version: 1,
        roomId: 'room',
        authorId: 'author',
        runtime: 'claude-code',
        root: '/accounts/exact',
        accountId: 'registered',
        inference: 'own-account',
        billing: 'subscription',
      }),
      state: 'pending',
      createdAt: '2026-11-18T00:00:00.000Z',
    })
    .run();
}

function put(sessionId: string, fields: Partial<Row>): Row {
  db.insert(sessionMetadata)
    .values({ sessionId, createdAt: '2026-11-18T00:00:00.000Z', ...fields })
    .run();
  return row(sessionId)!;
}

function row(sessionId: string): Row | undefined {
  return db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get();
}

/** A recovery chat under its request id, renamed into a row its SDK id already holds. */
function renameRecovery(id: string, source: Partial<Row>, destination: Partial<Row>): void {
  requirement(id, `request-${id}`);
  const from = put(`request-${id}`, { runtime: 'claude-code', requiredLaunchId: id, ...source });
  const to = put(`sdk-${id}`, destination);
  rekeySessionMetadata(db, `request-${id}`, `sdk-${id}`, from, to);
}

describe('rekeySessionMetadata on a recovery chat merging into an existing row', () => {
  it("keeps a stranger's record and the launch requirement when it merges into a vouched row", () => {
    renameRecovery('a', { bridgedSender: 'stranger' }, { bridgedSender: 'vouched' });

    expect(row('sdk-a')).toMatchObject({
      bridgedSender: 'stranger',
      requiredLaunchId: 'a',
      runtime: 'claude-code',
    });
    expect(new RequiredRoomLaunchStore(db).forSession('sdk-a')?.id).toBe('a');
  });

  it("reads as a stranger's when one row was not known", () => {
    renameRecovery('b', { bridgedSender: null }, { bridgedSender: 'vouched' });

    expect(row('sdk-b')).toMatchObject({ bridgedSender: null, requiredLaunchId: 'b' });
  });

  it('keeps a held last turn from either row', () => {
    renameRecovery('c', { lastTurnHeld: true }, { lastTurnHeld: false });

    expect(row('sdk-c')).toMatchObject({ lastTurnHeld: true, requiredLaunchId: 'c' });
  });
});

describe('required lifecycle follows its actual canonical owner', () => {
  it.each(['repeat', 'retarget', 'current'] as const)(
    'keeps established canonical evidence through %s without promoting the old pending alias',
    (operation) => {
      requirement('lifecycle', 'old');
      const original = put('old', {
        requiredLaunchId: 'lifecycle',
        runtime: 'claude-code',
        modelLaunchState: 'pending-v1',
      });
      rekeySessionMetadata(db, 'old', 'canonical', original, undefined);
      expect(row('old')?.modelLaunchState).toBeNull();
      db.update(sessionMetadata)
        .set({ modelLaunchState: 'established-v1' })
        .where(eq(sessionMetadata.sessionId, 'canonical'))
        .run();
      // Recreate the historical shape from before this repair. Its state must never win.
      db.update(sessionMetadata)
        .set({ modelLaunchState: 'pending-v1' })
        .where(eq(sessionMetadata.sessionId, 'old'))
        .run();
      const from = operation === 'current' ? 'canonical' : 'old';
      const to = operation === 'repeat' ? 'canonical' : 'next';
      rekeySessionMetadata(db, from, to, row(from)!, row(to));
      expect(row(to)?.modelLaunchState).toBe('established-v1');
      expect(row(from)?.modelLaunchState).toBeNull();
      expect(row('old')?.modelLaunchState).toBeNull();
      expect(new RequiredRoomLaunchStore(db).forSession('old')?.destinationSessionId).toBe(to);
      expect(new RequiredRoomLaunchStore(db).forSession(to)?.id).toBe('lifecycle');
    }
  );
});

it('rechecks an ordinary rekey destination allocation inside the metadata transaction', () => {
  const source = put('old', { runtime: 'claude-code', modelLaunchState: 'established-v1' });
  db.insert(sessionBirthAllocations)
    .values({
      sessionId: 'new',
      version: 1,
      createdAt: '2026-11-19T00:00:00.000Z',
      sourceKind: 'internal',
      internalSource: { kind: 'server-mint', owner: 'chat-start', mintedSessionId: 'new' },
    })
    .run();
  const before = db.select().from(sessionBirthAllocations).all();

  expect(() => rekeySessionMetadata(db, 'old', 'new', source, undefined)).toThrow(
    'Required session identity could not be preserved.'
  );

  expect(row('old')).toEqual(source);
  expect(row('new')).toBeUndefined();
  expect(db.select().from(sessionBirthAllocations).all()).toEqual(before);
});
