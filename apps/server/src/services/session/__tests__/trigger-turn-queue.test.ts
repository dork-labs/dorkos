/**
 * SessionTurnQueue — the ordering guarantees `triggerTurn` leans on (DOR-1088).
 *
 * The route-level proof lives in `routes/__tests__/sessions-turn-serialization.test.ts`.
 * These pin the mechanics that proof cannot show: three triggers landing in one
 * tick keep their arrival order, a different client is never made to wait, and
 * every released slot is handed back so the map cannot grow for the life of the
 * process.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionTurnQueue } from '../trigger-turn.js';

const SESSION = 'sess-1';
const CLIENT = 'tab-a';
/** Long enough that nothing in these tests is released by the wait bound. */
const WAIT_MS = 60_000;

/** Let every already-resolved promise callback run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionTurnQueue', () => {
  it('runs same-client triggers in arrival order, one at a time', async () => {
    const queue = new SessionTurnQueue();
    const order: string[] = [];

    /** One trigger: wait for the slot, do some async work, release. */
    const trigger = async (name: string): Promise<void> => {
      const slot = queue.reserve(SESSION, CLIENT, WAIT_MS);
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
    const held = queue.reserve(SESSION, CLIENT, WAIT_MS);
    await held.ready;

    // Two more triggers on the SAME session while the first still holds it: one
    // from the holding client, one from another. Only the stranger gets through.
    let sameClientRan = false;
    let otherClientRan = false;
    const sameClient = queue.reserve(SESSION, CLIENT, WAIT_MS);
    const otherClient = queue.reserve(SESSION, 'tab-b', WAIT_MS);
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
    const first = queue.reserve(SESSION, CLIENT, WAIT_MS);
    const second = queue.reserve(SESSION, CLIENT, WAIT_MS);
    await first.ready;

    first.release();
    first.release();
    await second.ready;
    second.release();

    expect(queue.size).toBe(0);
  });
});

describe('SessionTurnQueue — a chain reached under more than one id (review G4)', () => {
  const ALIAS = 'request-uuid';
  const CANON = 'canonical-id';

  it('joins the existing chain when the trigger arrives under the later id', async () => {
    // The live session answers to both ids. A trigger under the canonical id the
    // client just learned must stand behind the turn that reserved under the
    // request UUID, not start beside it.
    const queue = new SessionTurnQueue();
    const first = queue.reserve(ALIAS, CLIENT, WAIT_MS);
    await first.ready;
    queue.link(CANON, ALIAS);

    const second = queue.reserve(CANON, CLIENT, WAIT_MS);
    let secondRan = false;
    void second.ready.then(() => {
      secondRan = true;
    });
    await tick();
    expect(secondRan).toBe(false);

    first.release();
    await second.ready;
    second.release();

    // Both the chain and its alias are handed back — neither may outlive the
    // session that needed them.
    expect(queue.size).toBe(0);
    expect(queue.aliasCount).toBe(0);
  });

  it('ignores a self-link and keeps a linked id pointing at one chain', async () => {
    const queue = new SessionTurnQueue();
    queue.link(ALIAS, ALIAS);
    expect(queue.aliasCount).toBe(0);

    const first = queue.reserve(ALIAS, CLIENT, WAIT_MS);
    queue.link(CANON, ALIAS);
    // Linking again through the alias resolves to the same primary, not a chain
    // of aliases.
    queue.link(CANON, CANON);
    expect(queue.aliasCount).toBe(1);
    first.release();
    expect(queue.aliasCount).toBe(0);
  });
});

describe('SessionTurnQueue — the wait is bounded (review G1c)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a waiter through when the bound elapses, and heals the chain behind it', async () => {
    // The lock has a TTL and the chain does not. A turn that goes dark loses its
    // lock to a stranger one TTL later, so its own client's queued turn must not
    // be the one thing still waiting on it.
    vi.useFakeTimers();
    const queue = new SessionTurnQueue();
    const dark = queue.reserve(SESSION, CLIENT, 1_000);
    await dark.ready;

    const waiter = queue.reserve(SESSION, CLIENT, 1_000);
    let waiterRan = false;
    void waiter.ready.then(() => {
      waiterRan = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(waiterRan).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(waiterRan).toBe(true);

    // The turn AFTER the released waiter must depend on the waiter alone. If it
    // still inherited the dark turn's wait, one stuck turn would go on charging
    // every later turn the full bound, forever.
    const third = queue.reserve(SESSION, CLIENT, 1_000);
    let thirdRan = false;
    void third.ready.then(() => {
      thirdRan = true;
    });
    waiter.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdRan).toBe(true);
  });
});
