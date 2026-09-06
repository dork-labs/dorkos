import { describe, expect, it, vi } from 'vitest';
import { ConnectorTurnLeaseManager } from '../mcp/connector-turn-lease.js';

describe('ConnectorTurnLeaseManager', () => {
  it('grants same-directory turns in FIFO order', async () => {
    const manager = new ConnectorTurnLeaseManager();
    const first = await manager.acquire('/repo', new AbortController().signal);
    const order: string[] = [];
    const secondPromise = manager.acquire('/repo', new AbortController().signal).then((lease) => {
      order.push('second');
      return lease;
    });
    const thirdPromise = manager.acquire('/repo', new AbortController().signal).then((lease) => {
      order.push('third');
      return lease;
    });

    await vi.waitFor(() => expect(order).toEqual([]));
    first.release();
    const second = await secondPromise;
    expect(order).toEqual(['second']);
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(['second', 'third']);
    third.release();
  });

  it('removes a cancelled waiter without losing the next turn', async () => {
    const manager = new ConnectorTurnLeaseManager();
    const first = await manager.acquire('/repo', new AbortController().signal);
    const cancelled = new AbortController();
    const second = manager.acquire('/repo', cancelled.signal);
    const third = manager.acquire('/repo', new AbortController().signal);

    cancelled.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    first.release();
    const thirdLease = await third;
    thirdLease.release();
  });

  it('grants different directories independently', async () => {
    const manager = new ConnectorTurnLeaseManager();
    const first = await manager.acquire('/repo-a', new AbortController().signal);

    const second = await manager.acquire('/repo-b', new AbortController().signal);

    first.release();
    second.release();
  });

  it('rejects a signal already cancelled before enqueue', async () => {
    const manager = new ConnectorTurnLeaseManager();
    const controller = new AbortController();
    controller.abort();

    await expect(manager.acquire('/repo', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
