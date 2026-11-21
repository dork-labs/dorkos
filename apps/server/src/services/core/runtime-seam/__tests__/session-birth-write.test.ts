import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  agents,
  authors,
  chatMessages,
  eq,
  roomSessions,
  sessionBirthAllocations,
  sessionLocations,
  sessionMessageQueue,
  sessionMetadata,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  SessionBirthWriteError,
  withinSessionBirthWrite,
  withSessionBirthWrite,
  type SessionBirthWriteContext,
} from '../session-birth-write.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import { chatClientId } from '../../../session/chat-messages/chat-client-id.js';

let db: Db;
const stamp = '2026-11-19T00:00:00.000Z';
const sessionId = 'new-chat';
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.$client.close());

function locationBirth(): SessionBirthWriteContext {
  db.insert(sessionLocations)
    .values({ id: 'location', ownerId: 'person', cwd: '/project', createdAt: stamp })
    .run();
  db.insert(sessionBirthAllocations)
    .values({
      sessionId,
      version: 1,
      createdAt: stamp,
      sourceKind: 'person-location',
      ownerId: 'person',
      locationId: 'location',
    })
    .run();
  return {
    kind: 'person-location',
    sessionId,
    allocationCreatedAt: stamp,
    ownerId: 'person',
    locationId: 'location',
    cwd: '/project',
  };
}

function receiptBirth(): SessionBirthWriteContext {
  db.insert(chatMessages)
    .values({
      id: 'receipt',
      toSessionId: sessionId,
      fromSessionId: 'sender',
      fromAgentPath: '/sender',
      fromAgentName: 'Sender',
      kind: 'message',
      text: 'hello',
      nonce: 'nonce',
      delivery: 'queue',
      status: 'queued',
      queueMessageId: 'queue',
      ceilingJson: '"runtime-default"',
      createdAt: stamp,
      updatedAt: stamp,
    })
    .run();
  db.insert(sessionBirthAllocations)
    .values({
      sessionId,
      version: 1,
      createdAt: stamp,
      sourceKind: 'internal',
      internalSource: {
        kind: 'chat-message',
        receiptId: 'receipt',
        queueMessageId: 'queue',
        fromSessionId: 'sender',
        mintedToSessionId: sessionId,
      },
    })
    .run();
  return {
    kind: 'chat-message',
    delivery: 'live-fresh',
    allocationCreatedAt: stamp,
    receiptId: 'receipt',
    queueMessageId: 'queue',
    fromSessionId: 'sender',
    fromAgentPath: '/sender',
  };
}

function seatBirth(): SessionBirthWriteContext {
  db.insert(authors)
    .values({
      id: 'author',
      kind: 'agent',
      naturalKey: '/agent',
      displayName: 'Agent',
      createdAt: stamp,
    })
    .run();
  db.insert(roomSessions)
    .values({ roomId: 'room', authorId: 'author', sessionId, createdAt: stamp })
    .run();
  db.insert(sessionBirthAllocations)
    .values({
      sessionId,
      version: 1,
      createdAt: stamp,
      sourceKind: 'internal',
      internalSource: {
        kind: 'room-seat',
        roomId: 'room',
        authorId: 'author',
        boundSessionId: sessionId,
        seatCreatedAt: stamp,
      },
    })
    .run();
  return {
    kind: 'room-seat',
    allocationCreatedAt: stamp,
    roomId: 'room',
    authorId: 'author',
    agentPath: '/agent',
    seatCreatedAt: stamp,
  };
}

function insertMetadata(tx: DbTransaction, fields: { readonly modelLaunchState?: 'pending-v1' }) {
  return tx
    .insert(sessionMetadata)
    .values({
      sessionId,
      runtime: null,
      model: 'chosen',
      permissionMode: 'plan',
      createdAt: stamp,
      ...fields,
    })
    .run().changes;
}
const metadata = () =>
  db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get();
const allocations = () => db.select().from(sessionBirthAllocations).all();

describe('synchronous session birth transfer', () => {
  it('preserves a no-allocation insert and its original return value', () => {
    expect(withSessionBirthWrite(db, sessionId, undefined, insertMetadata)).toBe(1);
    expect(metadata()).toMatchObject({
      model: 'chosen',
      permissionMode: 'plan',
      runtime: null,
      modelLaunchState: null,
    });
  });

  it('preserves the no-allocation conflict UPDATE and existing lifecycle', () => {
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'codex',
        model: 'before',
        permissionMode: 'default',
        modelLaunchState: 'established-v1',
        createdAt: stamp,
      })
      .run();
    const before = metadata();
    withSessionBirthWrite(db, sessionId, undefined, (tx, fields) =>
      tx
        .insert(sessionMetadata)
        .values({ sessionId, createdAt: stamp, ...fields })
        .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: { model: 'after' } })
        .run()
    );
    expect(metadata()).toEqual({ ...before, model: 'after' });
  });

  it.each([
    ['location', locationBirth],
    ['receipt', receiptBirth],
    ['seat', seatBirth],
  ] as const)('transfers the actual %s source with the original settings', (_kind, arrange) => {
    const context = arrange();
    expect(withSessionBirthWrite(db, sessionId, context, insertMetadata)).toBe(1);
    expect(metadata()).toMatchObject({
      modelLaunchState: 'pending-v1',
      model: 'chosen',
      permissionMode: 'plan',
      runtime: null,
    });
    expect(allocations()).toEqual([]);
  });

  it('requires context before calling the writer for an allocated id', () => {
    locationBirth();
    let called = false;
    expect(() =>
      withSessionBirthWrite(db, sessionId, undefined, () => {
        called = true;
      })
    ).toThrow(SessionBirthWriteError);
    expect(called).toBe(false);
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('refuses a vanished expected allocation without inserting metadata', () => {
    const context = locationBirth();
    db.delete(sessionBirthAllocations).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
  });

  it('preserves an existing row and inconsistent unconsumed allocation', () => {
    const context = locationBirth();
    db.insert(sessionMetadata)
      .values({ sessionId, runtime: 'opencode', model: 'winner', createdAt: stamp })
      .run();
    const before = metadata();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toEqual(before);
    expect(allocations()).toHaveLength(1);
  });

  it('rechecks the persisted location owner after preparation', () => {
    const context = locationBirth();
    db.update(sessionLocations)
      .set({ ownerId: 'other' })
      .where(eq(sessionLocations.id, 'location'))
      .run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('refuses a replaced allocation generation with the same id', () => {
    const context = locationBirth();
    db.update(sessionBirthAllocations).set({ createdAt: 'later' }).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(allocations()[0]?.createdAt).toBe('later');
    expect(metadata()).toBeUndefined();
  });

  it.each([
    ['destination', { toSessionId: 'other' }],
    ['sender', { fromSessionId: 'other' }],
    ['sender path', { fromAgentPath: '/other' }],
    ['queue identity', { queueMessageId: 'other' }],
    [
      'private delivery route',
      {
        deliveryRoute: 'seat' as const,
        seatRoomId: 'private-room',
        seatAuthorId: 'private-author',
        seatJoinedAt: stamp,
        seatSessionId: sessionId,
      },
    ],
  ])('rechecks the receipt %s after preparation', (_name, patch) => {
    const context = receiptBirth();
    db.update(chatMessages).set(patch).where(eq(chatMessages.id, 'receipt')).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('checks an actual target agent when the receipt source names one', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    db.insert(agents)
      .values({
        id: 'target',
        name: 'Target',
        runtime: 'codex',
        projectPath: '/target',
        registeredAt: stamp,
        updatedAt: stamp,
      })
      .run();
    db.update(sessionBirthAllocations)
      .set({
        internalSource: {
          kind: 'chat-message',
          receiptId: 'receipt',
          queueMessageId: 'queue',
          fromSessionId: 'sender',
          mintedToSessionId: sessionId,
          targetAgentId: 'target',
        },
      })
      .run();
    withSessionBirthWrite(
      db,
      sessionId,
      { ...context, targetAgent: { id: 'target', path: '/target' } },
      insertMetadata
    );
    expect(metadata()?.modelLaunchState).toBe('pending-v1');
  });

  it('refuses a target agent whose persisted path changed', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    db.insert(agents)
      .values({
        id: 'target',
        name: 'Target',
        runtime: 'codex',
        projectPath: '/moved',
        registeredAt: stamp,
        updatedAt: stamp,
      })
      .run();
    db.update(sessionBirthAllocations)
      .set({
        internalSource: {
          kind: 'chat-message',
          receiptId: 'receipt',
          queueMessageId: 'queue',
          fromSessionId: 'sender',
          mintedToSessionId: sessionId,
          targetAgentId: 'target',
        },
      })
      .run();
    expect(() =>
      withSessionBirthWrite(
        db,
        sessionId,
        { ...context, targetAgent: { id: 'target', path: '/target' } },
        insertMetadata
      )
    ).toThrow(SessionBirthWriteError);
    expect(metadata()).toBeUndefined();
  });

  it.each([sessionId, 'other-chat'])(
    'checks a persisted dispatcher queue destination %s',
    (destination) => {
      const context = receiptBirth();
      db.insert(sessionMessageQueue)
        .values({
          id: 'queue',
          sessionId: destination,
          position: 1,
          content: 'hello',
          disposition: 'queue',
          clientId: chatClientId('sender'),
          enqueuedAt: 1,
        })
        .run();
      const write = () => withSessionBirthWrite(db, sessionId, context, insertMetadata);
      if (destination === sessionId) {
        expect(write()).toBe(1);
        expect(allocations()).toEqual([]);
      } else {
        expect(write).toThrow(SessionBirthWriteError);
        expect(metadata()).toBeUndefined();
        expect(allocations()).toHaveLength(1);
      }
    }
  );

  it.each(['queued', 'delivered', 'working', 'replied', 'steered', 'failed'] as const)(
    'keeps birth provenance independent of physical receipt status %s',
    (status) => {
      const context = receiptBirth();
      db.update(chatMessages).set({ status }).where(eq(chatMessages.id, 'receipt')).run();
      withSessionBirthWrite(db, sessionId, context, insertMetadata);
      expect(metadata()?.modelLaunchState).toBe('pending-v1');
      expect(db.select().from(chatMessages).get()?.status).toBe(status);
      expect(allocations()).toEqual([]);
      // Normal delivery admission remains the actual caller's separate responsibility.
    }
  );

  it('refuses dispatcher restart when its actual queue row is absent', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    expect(() =>
      withSessionBirthWrite(
        db,
        sessionId,
        { ...context, delivery: 'dispatcher-restart' },
        insertMetadata
      )
    ).toThrow(SessionBirthWriteError);
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('accepts restart from the real store row and its mapped sender', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    new MessageQueueStore(db).enqueue({
      id: 'queue',
      sessionId,
      content: 'hello',
      clientId: chatClientId('sender'),
    });
    // A new store instance reads the durable row through the restart-facing mapping.
    const records = new MessageQueueStore(db).list(sessionId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'queue', enqueuedBy: chatClientId('sender') });
    expect(db.select().from(sessionMessageQueue).get()?.clientId).toBe(chatClientId('sender'));
    withSessionBirthWrite(
      db,
      sessionId,
      { ...context, delivery: 'dispatcher-restart' },
      insertMetadata
    );
    expect(metadata()?.modelLaunchState).toBe('pending-v1');
    expect(allocations()).toEqual([]);
  });

  it.each(['live-fresh', 'dispatcher-restart'] as const)(
    'refuses the wrong persisted queue sender during %s',
    (delivery) => {
      const context = receiptBirth();
      if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
      new MessageQueueStore(db).enqueue({
        id: 'queue',
        sessionId,
        content: 'hello',
        clientId: chatClientId('different-sender'),
      });
      expect(() =>
        withSessionBirthWrite(db, sessionId, { ...context, delivery }, insertMetadata)
      ).toThrow(SessionBirthWriteError);
      expect(metadata()).toBeUndefined();
      expect(allocations()).toHaveLength(1);
    }
  );

  it('refuses a restart queue destination that no longer matches the receiving chat', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    new MessageQueueStore(db).enqueue({
      id: 'queue',
      sessionId: 'different-chat',
      content: 'hello',
      clientId: chatClientId('sender'),
    });
    expect(() =>
      withSessionBirthWrite(
        db,
        sessionId,
        { ...context, delivery: 'dispatcher-restart' },
        insertMetadata
      )
    ).toThrow(SessionBirthWriteError);
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('refuses a deleted receipt instead of accepting its structural allocation', () => {
    const context = receiptBirth();
    db.delete(chatMessages).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it.each([
    ['destination', { sessionId: 'successor' }],
    ['generation', { createdAt: 'new-generation' }],
  ])('rechecks the actual room seat %s', (_name, patch) => {
    const context = seatBirth();
    db.update(roomSessions).set(patch).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('refuses a retired room author', () => {
    const context = seatBirth();
    db.update(authors).set({ retiredAt: 'retired' }).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
  });

  it('refuses a deleted seat and preserves its unconsumed allocation', () => {
    const context = seatBirth();
    db.delete(roomSessions).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('refuses an asynchronous writer before its body starts', () => {
    let called = false;
    expect(() =>
      withSessionBirthWrite<Promise<void>>(
        db,
        sessionId,
        undefined,
        // @ts-expect-error Async callbacks violate the synchronous transaction contract.
        async () => {
          called = true;
        }
      )
    ).toThrow(SessionBirthWriteError);
    expect(called).toBe(false);
    expect(metadata()).toBeUndefined();
  });

  it('rolls back a synchronous callback that returns a promise', () => {
    const context = locationBirth();
    expect(() =>
      withSessionBirthWrite<Promise<string>>(
        db,
        sessionId,
        context,
        // @ts-expect-error Promise results violate the synchronous transaction contract.
        (tx, fields) => {
          insertMetadata(tx, fields);
          return Promise.resolve('invalid');
        }
      )
    ).toThrow(SessionBirthWriteError);
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('rolls back the original write if its callback fails', () => {
    const context = locationBirth();
    expect(() =>
      withSessionBirthWrite(db, sessionId, context, (tx, fields) => {
        insertMetadata(tx, fields);
        throw new Error('write failed');
      })
    ).toThrow('write failed');
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('refuses a callback that did not insert the pending row', () => {
    const context = locationBirth();
    expect(() => withSessionBirthWrite(db, sessionId, context, () => 0)).toThrow(
      SessionBirthWriteError
    );
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('rolls back both metadata and a source change made during the callback', () => {
    const context = locationBirth();
    expect(() =>
      withSessionBirthWrite(db, sessionId, context, (tx, fields) => {
        insertMetadata(tx, fields);
        tx.delete(sessionLocations).run();
      })
    ).toThrow(SessionBirthWriteError);
    expect(metadata()).toBeUndefined();
    expect(db.select().from(sessionLocations).all()).toHaveLength(1);
    expect(allocations()).toHaveLength(1);
  });

  it('rolls back an allocation mutation during the callback', () => {
    const context = locationBirth();
    expect(() =>
      withSessionBirthWrite(db, sessionId, context, (tx, fields) => {
        insertMetadata(tx, fields);
        tx.update(sessionBirthAllocations).set({ createdAt: 'different' }).run();
      })
    ).toThrow(SessionBirthWriteError);
    expect(metadata()).toBeUndefined();
    expect(allocations()[0]?.createdAt).toBe(stamp);
  });

  it('participates in outer rollback through explicit Within(tx)', () => {
    const context = locationBirth();
    expect(() =>
      db.transaction((tx) => {
        withinSessionBirthWrite(tx, sessionId, context, insertMetadata);
        expect(tx.select().from(sessionBirthAllocations).all()).toEqual([]);
        throw new Error('outer failed');
      })
    ).toThrow('outer failed');
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
  });

  it('rolls back its savepoint even if the outer owner catches refusal', () => {
    const context = locationBirth();
    db.transaction((tx) => {
      expect(() =>
        withinSessionBirthWrite(tx, sessionId, context, (nested, fields) => {
          insertMetadata(nested, fields);
          throw new Error('inner failed');
        })
      ).toThrow('inner failed');
      tx.update(sessionLocations).set({ cwd: '/retained-outer-write' }).run();
    });
    expect(metadata()).toBeUndefined();
    expect(allocations()).toHaveLength(1);
    expect(db.select().from(sessionLocations).get()?.cwd).toBe('/retained-outer-write');
  });
});
