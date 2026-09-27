import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@dorkos/shared/workspace';
import { logger } from '../../../lib/logger.js';
import { WorkspaceReconciler } from '../workspace-reconciler.js';
import { WorkspaceService } from '../workspace-service.js';
import type { WorkspaceStore } from '../workspace-store.js';

vi.mock('../../../lib/logger.js', () => ({ logger: { error: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const row: Workspace = {
  id: 'workspace-1',
  projectKey: 'project',
  key: 'DOR-2428',
  path: '/workspaces/pilot',
  source: '/source',
  branch: 'pilot',
  provider: 'worktree',
  status: 'ready',
  portBase: 4250,
  portBlockSize: 10,
  hostname: null,
  url: null,
  pinned: false,
  owner: null,
  createdAt: '2026-09-27',
  lastUsedAt: '2026-09-27',
};
const changed = { ...row, pinned: true };

function setup(intervalMs = 100, disposeTimeoutMs?: number) {
  const store = {
    list: vi.fn(() => [row]),
    readManifest: vi.fn<WorkspaceStore['readManifest']>().mockResolvedValue(changed),
    removeRow: vi.fn<WorkspaceStore['removeRow']>(),
    upsertRow: vi.fn<WorkspaceStore['upsertRow']>(),
  };
  const reconciler = new WorkspaceReconciler(store as unknown as WorkspaceStore, intervalMs, {
    disposeTimeoutMs,
  });
  return { store, reconciler };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(WorkspaceService, 'checkoutExists').mockResolvedValue(true);
  vi.mocked(logger.error).mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('WorkspaceReconciler lifecycle', () => {
  it('constructs passively and owns one restartable five-minute interval', async () => {
    const { store } = setup();
    const reconciler = new WorkspaceReconciler(store as unknown as WorkspaceStore);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.list).not.toHaveBeenCalled();
    expect(WorkspaceService.checkoutExists).not.toHaveBeenCalled();
    expect(store.upsertRow).not.toHaveBeenCalled();
    reconciler.start();
    reconciler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(store.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
    reconciler.stop();
    reconciler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.list).toHaveBeenCalledTimes(1);
    await expect(reconciler.reconcile()).resolves.toEqual({ synced: 1, removed: 0 });
    reconciler.start();
    reconciler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.list).toHaveBeenCalledTimes(3);
  });

  it('skips pending ticks and joins manual calls across stop and restart', async () => {
    const pending = deferred<boolean>();
    vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(pending.promise);
    const { store, reconciler } = setup();
    reconciler.start();
    await vi.advanceTimersByTimeAsync(100);
    const joined = reconciler.reconcile();
    const again = reconciler.reconcile();
    reconciler.stop();
    reconciler.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(WorkspaceService.checkoutExists).toHaveBeenCalledExactlyOnceWith(row.path);
    expect(again).toBe(joined);
    pending.resolve(true);
    await expect(joined).resolves.toEqual({ synced: 1, removed: 0 });
    expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.list).toHaveBeenCalledTimes(2);
    expect(store.upsertRow).toHaveBeenCalledTimes(2);
  });

  it('preserves missing-checkout removal and manifest authority counts', async () => {
    const { store, reconciler } = setup();
    const rows = [
      row,
      { ...row, id: 'changed' },
      { ...row, id: 'same' },
      { ...row, id: 'missing' },
    ];
    store.list.mockReturnValue(rows);
    vi.mocked(WorkspaceService.checkoutExists).mockResolvedValueOnce(false);
    store.readManifest
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(rows[2])
      .mockResolvedValueOnce(null);
    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, synced: 1 });
    expect(store.removeRow).toHaveBeenCalledExactlyOnceWith(row.id);
    expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
    expect(store.readManifest).toHaveBeenCalledTimes(3);
  });

  it.each(['checkout', 'manifest'] as const)(
    'writes after a deferred %s read when disposal has not intervened',
    async (read) => {
      const checkout = deferred<boolean>();
      const manifest = deferred<Workspace | null>();
      const { store, reconciler } = setup();
      if (read === 'checkout')
        vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(checkout.promise);
      else store.readManifest.mockReturnValueOnce(manifest.promise);
      const pass = reconciler.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(WorkspaceService.checkoutExists).toHaveBeenCalledTimes(1);
      expect(store.readManifest).toHaveBeenCalledTimes(read === 'manifest' ? 1 : 0);
      expect(store.removeRow).not.toHaveBeenCalled();
      expect(store.upsertRow).not.toHaveBeenCalled();
      checkout.resolve(false);
      manifest.resolve(changed);
      await expect(pass).resolves.toEqual({
        synced: read === 'manifest' ? 1 : 0,
        removed: read === 'checkout' ? 1 : 0,
      });
      if (read === 'checkout') {
        expect(store.removeRow).toHaveBeenCalledExactlyOnceWith(row.id);
        expect(store.upsertRow).not.toHaveBeenCalled();
      } else {
        expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
        expect(store.removeRow).not.toHaveBeenCalled();
      }
    }
  );

  it.each(['checkout', 'manifest'] as const)(
    'fences late writes during the %s read and clears the drain deadline',
    async (read) => {
      const checkout = deferred<boolean>();
      const manifest = deferred<Workspace | null>();
      const { store, reconciler } = setup();
      if (read === 'checkout')
        vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(checkout.promise);
      else store.readManifest.mockReturnValueOnce(manifest.promise);
      const pass = reconciler.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(WorkspaceService.checkoutExists).toHaveBeenCalledTimes(1);
      expect(store.readManifest).toHaveBeenCalledTimes(read === 'manifest' ? 1 : 0);
      const disposed = reconciler.dispose();
      expect(reconciler.dispose()).toBe(disposed);
      expect(vi.getTimerCount()).toBe(1);
      checkout.resolve(false);
      manifest.resolve(changed);
      await expect(disposed).resolves.toEqual({ status: 'drained' });
      const result = await pass;
      expect(store.removeRow).not.toHaveBeenCalled();
      expect(store.upsertRow).not.toHaveBeenCalled();
      expect(result).toEqual({ synced: 0, removed: 0 });
      expect(vi.getTimerCount()).toBe(0);
      expect(reconciler.dispose()).toBe(disposed);
    }
  );

  it('disposes idle without a deadline and refuses terminal admission', async () => {
    const { store, reconciler } = setup();
    reconciler.start();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const disposed = reconciler.dispose();
    expect(reconciler.dispose()).toBe(disposed);
    await expect(disposed).resolves.toEqual({ status: 'drained' });
    expect(timeout).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => reconciler.start()).toThrow(/disposed/i);
    await expect(reconciler.reconcile()).rejects.toThrow(/disposed/i);
    expect(store.list).not.toHaveBeenCalled();
  });

  it.each([
    { deadline: undefined, read: 'checkout' },
    { deadline: 27, read: 'checkout' },
    { deadline: undefined, read: 'manifest' },
    { deadline: 27, read: 'manifest' },
  ])(
    'times out at the exact deadline $deadline during $read and retains its outcome after late completion',
    async ({ deadline, read }) => {
      const checkout = deferred<boolean>();
      const manifest = deferred<Workspace | null>();
      const { store, reconciler } = setup(100, deadline);
      if (read === 'checkout')
        vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(checkout.promise);
      else store.readManifest.mockReturnValueOnce(manifest.promise);
      const pass = reconciler.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(WorkspaceService.checkoutExists).toHaveBeenCalledTimes(1);
      expect(store.readManifest).toHaveBeenCalledTimes(read === 'manifest' ? 1 : 0);
      const disposed = reconciler.dispose();
      const settled = vi.fn();
      void disposed.then(settled);
      expect(reconciler.dispose()).toBe(disposed);
      await vi.advanceTimersByTimeAsync((deadline ?? 5000) - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await disposed;
      expect(outcome).toEqual({ status: 'timed-out' });
      expect(vi.getTimerCount()).toBe(0);
      checkout.resolve(false);
      manifest.resolve(changed);
      await pass;
      expect(store.removeRow).not.toHaveBeenCalled();
      expect(store.upsertRow).not.toHaveBeenCalled();
      expect(reconciler.dispose()).toBe(disposed);
      expect(await reconciler.dispose()).toBe(outcome);
    }
  );

  it('keeps already completed writes when disposal interrupts a later row', async () => {
    const pending = deferred<boolean>();
    const { store, reconciler } = setup();
    store.list.mockReturnValue([row, { ...row, id: 'second' }]);
    vi.mocked(WorkspaceService.checkoutExists)
      .mockResolvedValueOnce(false)
      .mockReturnValueOnce(pending.promise);
    const pass = reconciler.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.removeRow).toHaveBeenCalledExactlyOnceWith(row.id);
    const disposed = reconciler.dispose();
    pending.resolve(false);
    await expect(pass).resolves.toEqual({ synced: 0, removed: 1 });
    await expect(disposed).resolves.toEqual({ status: 'drained' });
    expect(store.removeRow).toHaveBeenCalledExactlyOnceWith(row.id);
  });

  it('observes a scheduled error once and permits a later successful pass', async () => {
    const error = new Error('checkout read failed');
    vi.mocked(WorkspaceService.checkoutExists).mockRejectedValueOnce(error);
    const { store, reconciler } = setup();
    reconciler.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      '[workspace] reconciliation failed:',
      error
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(store.list).toHaveBeenCalledTimes(2);
    expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'observes rejection while disposing (after timeout: %s)',
    async (afterTimeout) => {
      const pending = deferred<boolean>();
      const error = new Error('late read failed');
      vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(pending.promise);
      const { reconciler } = setup(100, 20);
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        reconciler.start();
        await vi.advanceTimersByTimeAsync(100);
        const disposed = reconciler.dispose();
        if (afterTimeout) await vi.advanceTimersByTimeAsync(20);
        pending.reject(error);
        await vi.advanceTimersByTimeAsync(0);
        await expect(disposed).resolves.toEqual({ status: afterTimeout ? 'timed-out' : 'drained' });
        expect(logger.error).toHaveBeenCalledExactlyOnceWith(
          '[workspace] reconciliation failed:',
          error
        );
        expect(unhandled).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    }
  );

  it('recovers from interval acquisition failure', async () => {
    const { store, reconciler } = setup();
    vi.spyOn(globalThis, 'setInterval').mockImplementationOnce(() => {
      throw new Error('acquisition');
    });
    expect(() => reconciler.start()).toThrow('acquisition');
    expect(vi.getTimerCount()).toBe(0);
    reconciler.start();
    reconciler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
  });

  it('clears an acquired interval when unref fails and allows a valid retry', async () => {
    const { store, reconciler } = setup();
    const acquire = globalThis.setInterval;
    let handle: ReturnType<typeof setInterval> | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementationOnce((callback, ms) => {
      handle = acquire(callback, ms);
      vi.spyOn(handle, 'unref').mockImplementationOnce(() => {
        throw new Error('unref');
      });
      return handle;
    });
    const clear = vi.spyOn(globalThis, 'clearInterval');
    expect(() => reconciler.start()).toThrow('unref');
    expect(clear).toHaveBeenCalledExactlyOnceWith(handle);
    expect(vi.getTimerCount()).toBe(0);
    reconciler.start();
    reconciler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
  });
});
