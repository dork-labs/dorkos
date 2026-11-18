/** Requires the integration-generated migration; no old-base migration is fabricated here. */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, roomSessions, sessionMetadata, roomSeatLaunchRequirements, sql } from '@dorkos/db';
import { SessionEventStore } from '../../../session/session-event-store.js';
import { runInDispatch } from '../../../../lib/dispatch-context.js';
import { RequiredRoomLaunchStore } from '../required-launch-store.js';

function fixture() {
  const db = createTestDb();
  db.insert(roomSessions)
    .values({ roomId: 'r', authorId: 'a', sessionId: 'old', createdAt: 'now' })
    .run();
  new SessionEventStore(db).appendTurn('old', [
    { type: 'turn_start', seq: 1, roomMessage: { roomId: 'r', entryId: 'old-task' } },
    {
      type: 'error',
      seq: 3,
      code: 'server_error',
      category: 'execution_error',
      message: 'upstream',
    },
    {
      type: 'error',
      seq: 5,
      code: 'error_during_execution',
      category: 'execution_error',
      message: 'upstream',
      reason: 'claude-server-error-terminal',
      sourceDispatchId: 'prior-dispatch',
    },
    { type: 'turn_end', seq: 8, terminalReason: 'error' },
  ]);
  const store = new RequiredRoomLaunchStore(db);
  const input = {
    id: 'requirement',
    destinationSessionId: 'fresh',
    sourceSessionId: 'old',
    sourceDispatchId: 'prior-dispatch',
    startSeq: 1,
    endSeq: 8,
    roomId: 'r',
    authorId: 'a',
    runtime: 'claude-code' as const,
    root: '/accounts/exact',
    accountId: 'registered',
    inference: 'own-account' as const,
    billing: 'subscription' as const,
  };
  const scoped = <T>(fn: () => T) =>
    runInDispatch({ dispatchId: 'owned-handoff', origin: 'room' }, fn);
  const publish = () => scoped(() => store.publish(input, () => true));
  return { db, store, input, publish, scoped };
}
describe('durable required room launch', () => {
  it('atomically publishes destination-owned constraint and expected seat move', () => {
    const { db, store, publish, scoped } = fixture();
    const token = publish();
    expect(
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'fresh')).get()
    ).toMatchObject({ runtime: null, requiredLaunchId: 'requirement' });
    expect(store.forSession('fresh')?.root).toBe('/accounts/exact');
    expect(scoped(() => store.owns('fresh', token))).toBe(true);
    expect(store.hasOwnedAttempt('fresh')).toBe(false);
  });
  it('rolls back the requirement and reference when the expected binding changed', () => {
    const { db, publish } = fixture();
    db.update(roomSessions).set({ sessionId: 'newer' }).run();
    expect(publish).toThrow();
    expect(db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(0);
    expect(
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'fresh')).all()
    ).toHaveLength(0);
  });
  it('rolls back a true-write error without changing the binding', () => {
    const { db, publish } = fixture();
    db.run(
      sql`CREATE TRIGGER block_requirement BEFORE INSERT ON room_seat_launch_requirements BEGIN SELECT RAISE(ABORT, 'disk write refused'); END`
    );
    expect(publish).toThrow();
    expect(db.select().from(roomSessions).get()?.sessionId).toBe('old');
  });
  it('refuses later source work and cannot consume an old watermark twice', () => {
    const { db, store, input, publish, scoped } = fixture();
    publish();
    // Even if an operator later points the seat back, the historical failure is spent.
    db.update(roomSessions).set({ sessionId: 'old' }).run();
    expect(() =>
      scoped(() =>
        store.publish({ ...input, id: 'second', destinationSessionId: 'another' }, () => true)
      )
    ).toThrow();
  });
  it('retains restrictions after unseat, native settlement and lost attempt ownership', () => {
    const { db, store, publish, scoped } = fixture();
    publish();
    scoped(() =>
      store.settleObserved('fresh', {
        runtime: 'claude-code',
        root: '/accounts/exact',
        accountId: 'registered',
        inference: 'own-account',
        billing: 'subscription',
      })
    );
    db.delete(roomSessions).run();
    expect(new RequiredRoomLaunchStore(db).forSession('fresh')).toMatchObject({
      billing: 'subscription',
      state: 'settled',
    });
  });
  it('restart loses pending permission but retains the blocking requirement', () => {
    const { db, publish } = fixture();
    const token = publish();
    const restarted = new RequiredRoomLaunchStore(db);
    expect(restarted.forSession('fresh')?.state).toBe('pending');
    expect(restarted.owns('fresh', token)).toBe(false);
  });
  it('refuses a missing record behind an immutable destination marker', () => {
    const { db, store, publish } = fixture();
    publish();
    db.delete(roomSeatLaunchRequirements).run();
    expect(() => store.forSession('fresh')).toThrow();
  });
  it('atomic aliases refuse conflicting requirements without deleting either source', () => {
    const { db, store, publish } = fixture();
    publish();
    db.insert(sessionMetadata)
      .values({ sessionId: 'other', requiredLaunchId: 'different', createdAt: 'now' })
      .run();
    expect(() => store.rekey('fresh', 'other')).toThrow();
    expect(store.forSession('fresh')?.id).toBe('requirement');
  });
  it('does not let another dispatch consume the current handoff ownership', () => {
    const { store, publish } = fixture();
    publish();
    expect(
      runInDispatch({ dispatchId: 'another-send', origin: 'session' }, () =>
        store.hasOwnedAttempt('fresh')
      )
    ).toBe(false);
  });
  it('reauthorization after restart needs an explicit new guarded dispatch and preserves consumption', () => {
    const { db, publish, scoped } = fixture();
    publish();
    const restarted = new RequiredRoomLaunchStore(db);
    expect(() => scoped(() => restarted.reauthorize('fresh', () => false))).toThrow();
    const token = scoped(() => restarted.reauthorize('fresh', () => true));
    expect(scoped(() => restarted.owns('fresh', token))).toBe(true);
    expect(db.select().from(roomSeatLaunchRequirements).all()).toHaveLength(1);
  });
  it('old ids remain constrained after a canonical alias', () => {
    const { store, publish } = fixture();
    publish();
    store.rekey('fresh', 'canonical');
    expect(store.forSession('fresh')?.id).toBe(store.forSession('canonical')?.id);
  });
});
