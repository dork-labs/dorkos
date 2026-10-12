import { expect, it, vi } from 'vitest';
const order = vi.hoisted(() => [] as string[]);
const warn = vi.hoisted(() => vi.fn());
vi.mock('../computers.js', () => ({
  shutdownComputers: async () => {
    order.push('computer');
    throw new Error('private secret');
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { warn } }));
vi.mock('../../services/runtimes/opencode/index.js', () => ({
  openCodeServerManager: {
    shutdown: async () => {
      order.push('opencode');
    },
  },
}));
vi.mock('../../services/runtimes/codex/app-server/process-pool.js', () => ({
  codexAppServerPool: {
    shutdown: async () => {
      order.push('codex');
    },
  },
}));
vi.mock('../../services/runtimes/claude-code/sessions/session-pump-registry.js', () => ({
  shutdownSessionPumps: async () => {
    order.push('pumps');
  },
}));
import { shutdownRuntimes } from '../shutdown-runtimes.js';
it('continues host cleanup in existing order without exposing computer errors', async () => {
  await expect(
    shutdownRuntimes({
      close: async () => {
        order.push('credits');
      },
    } as never)
  ).resolves.toBeUndefined();
  expect(order).toEqual(['computer', 'opencode', 'codex', 'credits', 'pumps']);
  expect(warn).toHaveBeenCalledWith('[Computer] shutdown stop unconfirmed', {
    reason: 'shutdown',
    code: 'stop-threw',
  });
});
