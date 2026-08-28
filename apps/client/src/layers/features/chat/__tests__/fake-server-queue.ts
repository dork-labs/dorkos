/**
 * A stand-in for the server's message queue, for the cockpit's queue tests.
 *
 * The queue is the server's now, so a test that drives the composer has to have
 * a server to drive: one that mints ids, honours an anchor-relative move,
 * answers a mutation on a message it no longer holds with the same
 * `QUEUED_MESSAGE_NOT_FOUND` the real routes answer with, and pushes every
 * change back at the hook the way `queue_update` does. Faking the transport
 * without faking those rules would test a queue that behaves like nothing that
 * ships.
 *
 * Not a `.test.ts` file, so vitest does not try to collect it.
 *
 * @module features/chat/__tests__/fake-server-queue
 */
import { useCallback, useMemo } from 'react';
import { vi } from 'vitest';
import type {
  MessageDeliveryOutcome,
  QueuedMessage,
  QueueMoveTarget,
} from '@dorkos/shared/schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionQueue, useSessionStreamStore } from '@/layers/entities/session';
import { useRenderSlot } from '@/layers/shared/lib';

/** The error shape the HTTP transport surfaces for a `404` on a queue route. */
export function notFound(): Error & { code: string } {
  const err = new Error('No such queued message') as Error & { code: string };
  err.code = 'QUEUED_MESSAGE_NOT_FOUND';
  return err;
}

/** Build one queued message, with the fields a test rarely cares about filled in. */
export function queued(id: string, content: string, enqueuedBy = 'window-a'): QueuedMessage {
  return { id, content, disposition: 'queue', enqueuedAt: 1_000, enqueuedBy };
}

/** What {@link useFakeServerQueue} hands a test. */
export interface FakeServerQueue {
  /** The queue as it stands, head first — what a caller passes as `waiting`. */
  waiting: QueuedMessage[];
  /** A transport whose queue routes hit this fake. */
  transport: Transport;
  /** The enqueue seam (`onEnqueue`), which appends and reports success. */
  enqueue: (content: string) => Promise<boolean>;
  /** Make the next enqueue fail, the way a dead network does. */
  failNextEnqueue: () => void;
  /** Put messages on the queue without going through the composer. */
  seed: (...messages: QueuedMessage[]) => void;
  /** Take a message off the queue behind the cockpit's back (a dispatch, or another window). */
  dispatchHead: () => void;
  /** Re-announce the queue carrying a delivery receipt, the way an acceptance does. */
  announceOutcome: (outcome: MessageDeliveryOutcome) => void;
  /** Every enqueue this fake was asked to make, in order. */
  enqueued: string[];
}

/**
 * A fake server queue plus the transport that talks to it.
 *
 * Every change is announced the way the real one is — a `queue_update` into the
 * session stream store — so the hook under test reads its queue from exactly
 * where it reads it in production.
 *
 * @param clientId - The id this window enqueues under. A message seeded with a
 *   different `enqueuedBy` is what "another window queued this" looks like.
 * @param sessionId - The session whose queue this fake stands for.
 */
export function useFakeServerQueue(
  clientId = 'window-a',
  sessionId = 'test-session'
): FakeServerQueue {
  // Render slots rather than refs: the fake's own state is read while the test
  // renders (the transport is built in a memo, and `enqueued` is returned), and
  // render may not read refs.
  const held = useRenderSlot<QueuedMessage[]>([]);
  const seq = useRenderSlot(0);
  const nextId = useRenderSlot(0);
  const enqueued = useRenderSlot<string[]>([]);
  const failNext = useRenderSlot(false);
  const waiting = useSessionQueue(sessionId);

  const set = useCallback(
    (next: QueuedMessage[], outcome?: MessageDeliveryOutcome) => {
      held.write(next);
      seq.write(seq.read() + 1);
      useSessionStreamStore.getState().applyEvent(sessionId, {
        type: 'queue_update',
        seq: seq.read(),
        queue: next,
        ...(outcome ? { outcome } : {}),
      });
    },
    [sessionId, held, seq]
  );

  const enqueue = useCallback(
    async (content: string): Promise<boolean> => {
      enqueued.write([...enqueued.read(), content]);
      if (failNext.read()) {
        failNext.write(false);
        return false;
      }
      nextId.write(nextId.read() + 1);
      set([...held.read(), queued(`q${nextId.read()}`, content, clientId)]);
      return true;
    },
    [clientId, set, enqueued, failNext, held, nextId]
  );

  const transport = useMemo(
    () =>
      createMockTransport({
        clientId,
        updateQueuedMessage: vi.fn(
          async (
            _sessionId: string,
            messageId: string,
            edit: { content?: string; move?: QueueMoveTarget }
          ) => {
            const current = held.read();
            const index = current.findIndex((m) => m.id === messageId);
            if (index === -1) throw notFound();
            let next = [...current];
            let message = { ...next[index]! };
            if (edit.content !== undefined) {
              message = { ...message, content: edit.content };
              next[index] = message;
            }
            if (edit.move) {
              const anchorId = 'before' in edit.move ? edit.move.before : edit.move.after;
              const anchor = next.findIndex((m) => m.id === anchorId);
              if (anchor === -1) throw notFound();
              next = next.filter((m) => m.id !== messageId);
              const at = next.findIndex((m) => m.id === anchorId);
              next.splice('before' in edit.move ? at : at + 1, 0, message);
            }
            set(next);
            return { message, queue: next };
          }
        ),
        removeQueuedMessage: vi.fn(async (_sessionId: string, messageId: string) => {
          const current = held.read();
          if (!current.some((m) => m.id === messageId)) throw notFound();
          const next = current.filter((m) => m.id !== messageId);
          set(next);
          return { queue: next };
        }),
      }),
    [clientId, set, held]
  );

  return {
    waiting,
    transport,
    enqueue,
    failNextEnqueue: () => {
      failNext.write(true);
    },
    seed: (...messages: QueuedMessage[]) => set([...held.read(), ...messages]),
    dispatchHead: () => set(held.read().slice(1)),
    announceOutcome: (outcome: MessageDeliveryOutcome) => set([...held.read()], outcome),
    enqueued: enqueued.read(),
  };
}
