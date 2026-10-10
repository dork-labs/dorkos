import { expect, it } from 'vitest';
import { DoeEventQueue } from '../event-queue.js';
it('drains buffered events before its terminal completion', async () => {
  const queue = new DoeEventQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.end();
  expect(await queue.next()).toEqual({ done: false, value: 1 });
  expect(await queue.next()).toEqual({ done: false, value: 2 });
  expect(await queue.next()).toEqual({ done: true, value: undefined });
});
it('return tears down a parked consumer and rejects later delivery', async () => {
  const queue = new DoeEventQueue<number>();
  const pending = queue.next();
  await queue.return();
  expect(await pending).toEqual({ done: true, value: undefined });
  queue.push(3);
  expect((await queue.next()).done).toBe(true);
});
