/**
 * SessionTurnQueue — the ordering guarantees `triggerTurn` leans on (DOR-1088).
 *
 * The route-level proof lives in `routes/__tests__/sessions-turn-serialization.test.ts`.
 * These pin the mechanics that proof cannot show: three triggers landing in one
 * tick keep their arrival order, a different client is never made to wait, and
 * every released slot is handed back so the map cannot grow for the life of the
 * process.
 */
import { describe, it, expect } from 'vitest';
import { SessionTurnQueue } from '../trigger-turn.js';

const SESSION = 'sess-1';
const CLIENT = 'tab-a';

describe('SessionTurnQueue', () => {
  it('runs same-client triggers in arrival order, one at a time', async () => {
    const queue = new SessionTurnQueue();
    const order: string[] = [];

    /** One trigger: wait for the slot, do some async work, release. */
    const trigger = async (name: string): Promise<void> => {
      const slot = queue.reserve(SESSION, CLIENT);
      await slot.ready;
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}:end`);
      slot.release();
    };

    // All three reserve in the same tick, exactly as three POSTs racing in do.
    await Promise.all([trigger('one'), trigger('two'), trigger('three')]);

    expect(order).toEqual([
      'one:start',
      'one:end',
      'two:start',
      'two:end',
      'three:start',
      'three:end',
    ]);
    expect(queue.size).toBe(0);
  });

  it('never makes a different client wait', async () => {
    // Refusing a second client is the lock's job. If this queue held them too, a
    // 409 the person can see would become a hang they cannot.
    const queue = new SessionTurnQueue();
    const held = queue.reserve(SESSION, CLIENT);
    await held.ready;

    // Two more triggers on the SAME session while the first still holds it: one
    // from the holding client, one from another. Only the stranger gets through.
    let sameClientRan = false;
    let otherClientRan = false;
    const sameClient = queue.reserve(SESSION, CLIENT);
    const otherClient = queue.reserve(SESSION, 'tab-b');
    void sameClient.ready.then(() => {
      sameClientRan = true;
    });
    void otherClient.ready.then(() => {
      otherClientRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(otherClientRan).toBe(true);
    expect(sameClientRan).toBe(false);

    held.release();
    otherClient.release();
    await sameClient.ready;
    sameClient.release();
    expect(queue.size).toBe(0);
  });

  it('releases once, however many times it is called', async () => {
    const queue = new SessionTurnQueue();
    const first = queue.reserve(SESSION, CLIENT);
    const second = queue.reserve(SESSION, CLIENT);
    await first.ready;

    first.release();
    first.release();
    await second.ready;
    second.release();

    expect(queue.size).toBe(0);
  });
});
