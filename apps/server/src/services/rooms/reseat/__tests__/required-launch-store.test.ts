/** Requires the integration-generated migration; no old-base migration is fabricated here. */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  eq,
  authors,
  roomSessions,
  sessionMetadata,
  sessionBirthAllocations,
  roomSeatLaunchRequirements,
  sql,
} from '@dorkos/db';
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
  it.each([{}, { model: 'chosen', permissionMode: 'plan' }])(
    'atomically publishes the legacy destination with settings %j',
    (settings) => {
      const { db, store, publish, scoped } = fixture();
      if ('model' in settings)
        db.insert(sessionMetadata)
          .values({ sessionId: 'fresh', createdAt: 'now', ...settings })
          .run();
      const token = publish();
      expect(
        db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'fresh')).get()
      ).toMatchObject({
        runtime: null,
        requiredLaunchId: 'requirement',
        modelLaunchState: null,
        ...settings,
      });
      expect(store.forSession('fresh')?.root).toBe('/accounts/exact');
      expect(scoped(() => store.owns('fresh', token))).toBe(true);
      expect(store.hasOwnedAttempt('fresh')).toBe(false);
    }
  );
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

describe('required-room lifecycle rekey', () => {
  it.each([null, 'pending-v1', 'attempted-v1', 'established-v1'] as const)(
    'carries the actual %s source evidence only into an absent canonical destination',
    (modelLaunchState) => {
      const { db, store, publish } = fixture();
      publish();
      db.update(sessionMetadata)
        .set({ modelLaunchState, model: 'explicit-model', permissionMode: 'plan' })
        .where(eq(sessionMetadata.sessionId, 'fresh'))
        .run();
      store.rekey('fresh', 'canonical');
      expect(
        db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'canonical')).get()
      ).toMatchObject({ modelLaunchState, requiredLaunchId: 'requirement' });
      expect(
        db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'fresh')).get()
      ).toMatchObject({ modelLaunchState: null, model: 'explicit-model', permissionMode: 'plan' });
      expect(store.forSession('fresh')?.destinationSessionId).toBe('canonical');
    }
  );

  it.each([null, 'attempted-v1', 'established-v1'] as const)(
    'preserves an existing same-required-owner destination at %s',
    (modelLaunchState) => {
      const { db, store, publish } = fixture();
      publish();
      db.update(sessionMetadata)
        .set({ modelLaunchState: 'pending-v1' })
        .where(eq(sessionMetadata.sessionId, 'fresh'))
        .run();
      db.insert(sessionMetadata)
        .values({
          sessionId: 'canonical',
          requiredLaunchId: 'requirement',
          modelLaunchState,
          model: 'winner',
          permissionMode: 'default',
          createdAt: 'existing',
        })
        .run();
      store.rekey('fresh', 'canonical');
      expect(
        db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'canonical')).get()
      ).toMatchObject({ modelLaunchState, model: 'winner', permissionMode: 'default' });
    }
  );

  it.each(['fresh', 'canonical'])(
    'refuses an inconsistent unconsumed allocation at %s without publishing an alias',
    (sessionId) => {
      const { db, store, publish } = fixture();
      publish();
      db.insert(sessionBirthAllocations)
        .values({
          sessionId,
          version: 1,
          createdAt: 'allocation',
          sourceKind: 'internal',
          internalSource: {
            kind: 'required-recovery',
            requirementId: 'requirement',
            mintedSessionId: sessionId,
          },
        })
        .run();
      expect(() => store.rekey('fresh', 'canonical')).toThrow('unconsumed birth allocation');
      expect(store.forSession('fresh')?.destinationSessionId).toBe('fresh');
      expect(
        db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'canonical')).get()
      ).toBeUndefined();
      expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);
    }
  );

  it('rolls back the copied lifecycle when the actual requirement move fails', () => {
    const { db, store, publish } = fixture();
    publish();
    db.update(sessionMetadata)
      .set({ modelLaunchState: 'attempted-v1' })
      .where(eq(sessionMetadata.sessionId, 'fresh'))
      .run();
    db.$client.exec(
      "CREATE TEMP TRIGGER reject_birth_alias BEFORE UPDATE ON room_seat_launch_requirements BEGIN SELECT RAISE(ABORT, 'owned-alias-write-rejected'); END;"
    );
    expect(() => store.rekey('fresh', 'canonical')).toThrow('owned-alias-write-rejected');
    expect(
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'canonical')).get()
    ).toBeUndefined();
    expect(store.forSession('fresh')?.destinationSessionId).toBe('fresh');
  });
});

describe('atomic publication of a fresh recovery destination', () => {
  function owned() {
    const f = fixture();
    f.db
      .insert(authors)
      .values({
        id: 'a',
        kind: 'agent',
        naturalKey: '/agent',
        displayName: 'Agent',
        createdAt: 'now',
      })
      .run();
    f.db
      .insert(sessionMetadata)
      .values({
        sessionId: 'old',
        runtime: 'claude-code',
        agentPath: '/agent',
        model: 'chosen',
        permissionMode: 'plan',
        createdAt: 'now',
      })
      .run();
    const prepare = (agentPath = '/agent') =>
      f.store.prepareReplacement(f.input, agentPath, () => true);
    const destination = () =>
      f.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'fresh')).get();
    const expectUnpublished = () => {
      expect(destination()).toBeUndefined();
      expect(f.db.select().from(sessionBirthAllocations).all()).toEqual([]);
      expect(f.db.select().from(roomSeatLaunchRequirements).all()).toEqual([]);
      expect(f.db.select().from(roomSessions).get()?.sessionId).toBe('old');
    };
    return { ...f, prepare, destination, expectUnpublished };
  }

  it('captures the source without writes and publishes carried settings together with the seat', () => {
    const f = owned();
    f.scoped(() => {
      const birth = f.prepare();
      f.expectUnpublished();

      const token = f.store.publish(f.input, () => true, {
        birth,
        settings: { model: 'chosen', permissionMode: 'plan', fastMode: true },
      });

      expect(f.destination()).toMatchObject({
        runtime: null,
        model: 'chosen',
        permissionMode: 'plan',
        fastMode: true,
        modelLaunchState: 'pending-v1',
        requiredLaunchId: 'requirement',
      });
      expect(f.db.select().from(sessionBirthAllocations).all()).toEqual([]);
      expect(f.db.select().from(roomSessions).get()?.sessionId).toBe('fresh');
      expect(f.store.owns('fresh', token)).toBe(true);
    });
  });

  it('publishes a durable fresh identity with empty settings', () => {
    const f = owned();
    f.scoped(() => {
      f.store.publish(f.input, () => true, { birth: f.prepare(), settings: {} });
      expect(f.destination()).toMatchObject({
        runtime: null,
        model: null,
        modelLaunchState: 'pending-v1',
        requiredLaunchId: 'requirement',
      });
      expect(f.db.select().from(sessionBirthAllocations).all()).toEqual([]);
    });
  });

  it('refuses a changed earlier seat generation even when it still names the same session', () => {
    const f = owned();
    f.scoped(() => {
      const birth = f.prepare();
      f.db.update(roomSessions).set({ createdAt: 'replacement-generation' }).run();

      expect(() =>
        f.store.publish(f.input, () => true, { birth, settings: { permissionMode: 'plan' } })
      ).toThrow('Recovery birth source changed.');

      f.expectUnpublished();
      expect(f.db.select().from(roomSessions).get()?.createdAt).toBe('replacement-generation');
    });
  });

  it('refuses a different agent or handoff without publishing any destination records', () => {
    const f = owned();
    expect(() => f.scoped(() => f.prepare('/wrong-agent'))).toThrow(
      'Recovery birth source changed.'
    );
    const birth = f.scoped(() => f.prepare());

    expect(() =>
      runInDispatch({ dispatchId: 'different-handoff', origin: 'room' }, () =>
        f.store.publish(f.input, () => true, { birth, settings: { permissionMode: 'plan' } })
      )
    ).toThrow('Recovery birth source changed.');

    f.expectUnpublished();
  });

  it('rolls back if a synchronous admission guard changes the exact destination', () => {
    const f = owned();
    f.scoped(() => {
      const birth = f.prepare();
      const changed = { ...f.input };

      expect(() =>
        f.store.publish(
          changed,
          () => {
            changed.destinationSessionId = 'unrelated';
            return true;
          },
          { birth, settings: { permissionMode: 'plan' } }
        )
      ).toThrow('publication proof');

      f.expectUnpublished();
      expect(
        f.db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, 'unrelated')).get()
      ).toBeUndefined();
    });
  });

  it('preserves a destination already acquired by another writer', () => {
    const f = owned();
    f.scoped(() => {
      const birth = f.prepare();
      const winner = { sessionId: 'fresh', model: 'winner', createdAt: 'winner' };
      f.db.insert(sessionMetadata).values(winner).run();

      expect(() =>
        f.store.publish(f.input, () => true, { birth, settings: { model: 'chosen' } })
      ).toThrow('Recovery birth source changed.');

      expect(f.destination()).toMatchObject(winner);
      expect(f.db.select().from(sessionBirthAllocations).all()).toEqual([]);
      expect(f.db.select().from(roomSeatLaunchRequirements).all()).toEqual([]);
      expect(f.db.select().from(roomSessions).get()?.sessionId).toBe('old');
    });
  });
});
