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

type BirthFields = { readonly modelLaunchState?: 'pending-v1' };
function insertMetadata(tx: DbTransaction, fields: BirthFields) {
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

/** The write is refused: no metadata row, and the allocation stays unconsumed. */
function expectRefused(
  context: SessionBirthWriteContext | undefined,
  write: (tx: DbTransaction, fields: BirthFields) => unknown = insertMetadata
) {
  const attempt = () => withSessionBirthWrite(db, sessionId, context, write);
  expect(attempt).toThrow(SessionBirthWriteError);
  expect(metadata()).toBeUndefined();
  expect(allocations()).toHaveLength(1);
}

/** Queues the receipt's message for `chat`, as sent by `sender`. */
function enqueue(chat: string, sender = 'sender') {
  new MessageQueueStore(db).enqueue({
    id: 'queue',
    sessionId: chat,
    content: 'hello',
    clientId: chatClientId(sender),
  });
}

/** Registers the receipt's target agent at `projectPath` and names it in the allocation. */
function targetAgentAt(projectPath: string) {
  db.insert(agents)
    .values({
      id: 'target',
      name: 'Target',
      runtime: 'codex',
      projectPath,
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
}

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
    expectRefused(undefined, () => {
      called = true;
    });
    expect(called).toBe(false);
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

  it('refuses a replaced allocation generation with the same id', () => {
    const context = locationBirth();
    db.update(sessionBirthAllocations).set({ createdAt: 'later' }).run();
    expect(() => withSessionBirthWrite(db, sessionId, context, insertMetadata)).toThrow(
      SessionBirthWriteError
    );
    expect(allocations()[0]?.createdAt).toBe('later');
    expect(metadata()).toBeUndefined();
  });

  const receiptPatch = (patch: Partial<typeof chatMessages.$inferInsert>) => () =>
    db.update(chatMessages).set(patch).where(eq(chatMessages.id, 'receipt')).run();
  it.each([
    [
      'the location owner',
      locationBirth,
      () =>
        db
          .update(sessionLocations)
          .set({ ownerId: 'other' })
          .where(eq(sessionLocations.id, 'location'))
          .run(),
    ],
    ['the receipt destination', receiptBirth, receiptPatch({ toSessionId: 'other' })],
    ['the receipt sender', receiptBirth, receiptPatch({ fromSessionId: 'other' })],
    ['the receipt sender path', receiptBirth, receiptPatch({ fromAgentPath: '/other' })],
    ['the receipt queue identity', receiptBirth, receiptPatch({ queueMessageId: 'other' })],
    [
      'the receipt private delivery route',
      receiptBirth,
      receiptPatch({
        deliveryRoute: 'seat',
        seatRoomId: 'private-room',
        seatAuthorId: 'private-author',
        seatJoinedAt: stamp,
        seatSessionId: sessionId,
      }),
    ],
    ['a deleted receipt', receiptBirth, () => db.delete(chatMessages).run()],
    [
      'the room seat destination',
      seatBirth,
      () => db.update(roomSessions).set({ sessionId: 'successor' }).run(),
    ],
    [
      'the room seat generation',
      seatBirth,
      () => db.update(roomSessions).set({ createdAt: 'new-generation' }).run(),
    ],
    [
      'a retired room author',
      seatBirth,
      () => db.update(authors).set({ retiredAt: 'retired' }).run(),
    ],
    ['a deleted seat', seatBirth, () => db.delete(roomSessions).run()],
  ] as const)('rechecks %s after preparation and refuses a change', (_name, arrange, change) => {
    const context = arrange();
    change();
    expectRefused(context);
  });

  it.each([
    ['/target', true],
    ['/moved', false],
  ] as const)('checks the actual target agent the receipt names (at %s)', (path, accepted) => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    targetAgentAt(path);
    const withTarget = { ...context, targetAgent: { id: 'target', path: '/target' } };
    if (accepted) {
      withSessionBirthWrite(db, sessionId, withTarget, insertMetadata);
      expect(metadata()?.modelLaunchState).toBe('pending-v1');
    } else {
      expectRefused(withTarget);
    }
  });

  it.each([sessionId, 'other-chat'])(
    'checks a persisted dispatcher queue destination %s',
    (destination) => {
      const context = receiptBirth();
      enqueue(destination);
      if (destination === sessionId) {
        expect(withSessionBirthWrite(db, sessionId, context, insertMetadata)).toBe(1);
        expect(allocations()).toEqual([]);
      } else {
        expectRefused(context);
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
    expectRefused({ ...context, delivery: 'dispatcher-restart' });
  });

  it('accepts restart from the real store row and its mapped sender', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    enqueue(sessionId);
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
      enqueue(sessionId, 'different-sender');
      expectRefused({ ...context, delivery });
    }
  );

  it('refuses a restart queue destination that no longer matches the receiving chat', () => {
    const context = receiptBirth();
    if (context.kind !== 'chat-message') throw new Error('Expected receipt fixture');
    enqueue('different-chat');
    expectRefused({ ...context, delivery: 'dispatcher-restart' });
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
    expectRefused(context, () => 0);
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
