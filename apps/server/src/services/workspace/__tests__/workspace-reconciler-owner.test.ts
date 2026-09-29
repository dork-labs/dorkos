import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@dorkos/shared/workspace';
import { logger } from '../../../lib/logger.js';
import { WorkspaceReconciler } from '../workspace-reconciler.js';
import { WorkspaceService } from '../workspace-service.js';
import type { WorkspaceStore } from '../workspace-store.js';
import { WorkspaceReconcilerLifecycle } from '../workspace-reconciler-lifecycle.js';

vi.mock('../../../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

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
  key: 'DOR-2429',
  path: '/workspaces/adoption',
  source: '/source',
  branch: 'adoption',
  provider: 'worktree',
  status: 'ready',
  portBase: 4250,
  portBlockSize: 10,
  hostname: null,
  url: null,
  pinned: false,
  owner: null,
  createdAt: '2026-09-28',
  lastUsedAt: '2026-09-28',
};
const changed = { ...row, pinned: true };

function setup() {
  const store = {
    list: vi.fn(() => [row]),
    readManifest: vi.fn<WorkspaceStore['readManifest']>().mockResolvedValue(changed),
    removeRow: vi.fn<WorkspaceStore['removeRow']>(),
    upsertRow: vi.fn<WorkspaceStore['upsertRow']>(),
  };
  const reconciler = new WorkspaceReconciler(store as unknown as WorkspaceStore);
  const owner = new WorkspaceReconcilerLifecycle();
  return { store, reconciler, owner };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(WorkspaceService, 'checkoutExists').mockResolvedValue(true);
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('root-owned workspace reconciler lifetime', () => {
  it('is passive and memoizes disposal of an empty owner without a timer', async () => {
    const { owner, store } = setup();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.list).not.toHaveBeenCalled();
    const disposed = owner.dispose();
    expect(owner.dispose()).toBe(disposed);
    const outcome = await disposed;
    expect(outcome).toEqual({ status: 'drained' });
    expect(await owner.dispose()).toBe(outcome);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects startup after empty-owner disposal before acquiring any timer', async () => {
    const { owner, reconciler } = setup();
    const disposed = owner.dispose();
    const acquire = vi.spyOn(globalThis, 'setInterval');
    expect(() => owner.start(reconciler)).toThrow(/disposed/i);
    expect(acquire).not.toHaveBeenCalled();
    await disposed;
    expect(() => owner.start(reconciler)).toThrow(/disposed/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects duplicate registration and replacement without losing its first owner', async () => {
    const { owner, reconciler } = setup();
    const replacement = setup().reconciler;
    owner.start(reconciler);
    expect(() => owner.start(reconciler)).toThrow(/already/i);
    expect(() => owner.start(replacement)).toThrow(/already/i);
    expect(vi.getTimerCount()).toBe(1);
    await owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await expect(reconciler.reconcile()).rejects.toThrow(/disposed/i);
    await expect(replacement.reconcile()).resolves.toEqual({ synced: 1, removed: 0 });
  });

  it('retains the reconciler before failed timer acquisition for later terminal cleanup', async () => {
    const { owner, reconciler } = setup();
    const error = new Error('timer acquisition failed');
    vi.spyOn(globalThis, 'setInterval').mockImplementationOnce(() => {
      throw error;
    });
    expect(() => owner.start(reconciler)).toThrow(error);
    await expect(owner.dispose()).resolves.toEqual({ status: 'drained' });
    expect(() => reconciler.start()).toThrow(/disposed/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['checkout', 'manifest'] as const)(
    'allows the controlled %s read to write before disposal',
    async (read) => {
      const { owner, store, reconciler } = setup();
      const checkout = deferred<boolean>();
      const manifest = deferred<Workspace | null>();
      if (read === 'checkout')
        vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(checkout.promise);
      else store.readManifest.mockReturnValueOnce(manifest.promise);
      owner.start(reconciler);
      const pass = reconciler.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(WorkspaceService.checkoutExists).toHaveBeenCalledTimes(1);
      expect(store.readManifest).toHaveBeenCalledTimes(read === 'manifest' ? 1 : 0);
      checkout.resolve(false);
      manifest.resolve(changed);
      await expect(pass).resolves.toEqual({
        removed: read === 'checkout' ? 1 : 0,
        synced: read === 'manifest' ? 1 : 0,
      });
      if (read === 'checkout') expect(store.removeRow).toHaveBeenCalledExactlyOnceWith(row.id);
      else expect(store.upsertRow).toHaveBeenCalledExactlyOnceWith(changed);
      await owner.dispose();
    }
  );

  it.each(['checkout', 'manifest'] as const)(
    'fences the pending %s read synchronously before a later closer hangs',
    async (read) => {
      const { owner, store, reconciler } = setup();
      const checkout = deferred<boolean>();
      const manifest = deferred<Workspace | null>();
      const later = deferred<void>();
      if (read === 'checkout')
        vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(checkout.promise);
      else store.readManifest.mockReturnValueOnce(manifest.promise);
      owner.start(reconciler);
      const pass = reconciler.reconcile();
      await vi.advanceTimersByTimeAsync(0);
      expect(WorkspaceService.checkoutExists).toHaveBeenCalledTimes(1);
      expect(store.readManifest).toHaveBeenCalledTimes(read === 'manifest' ? 1 : 0);
      const enteredLater = vi.fn();
      const cleanup = async () => {
        await owner.dispose();
        enteredLater();
        await later.promise;
      };
      const ordinary = cleanup();
      // The same owner is used by startup failure, even during ordinary cleanup.
      const startup = owner.dispose();
      expect(owner.dispose()).toBe(startup);
      expect(() => reconciler.start()).toThrow(/disposed/i);
      expect(vi.getTimerCount()).toBe(1); // Only the class's deadline remains.
      expect(enteredLater).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(enteredLater).toHaveBeenCalledTimes(1);
      checkout.resolve(false);
      manifest.resolve(changed);
      await pass;
      expect(store.removeRow).not.toHaveBeenCalled();
      expect(store.upsertRow).not.toHaveBeenCalled();
      later.resolve();
      await ordinary;
      await expect(startup).resolves.toEqual({ status: 'timed-out' });
    }
  );

  it('drains pending work, clears the one class deadline and joins cleanup callers', async () => {
    const { owner, reconciler } = setup();
    const pending = deferred<boolean>();
    vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(pending.promise);
    owner.start(reconciler);
    const pass = reconciler.reconcile();
    const ordinary = owner.dispose();
    const startup = owner.dispose();
    expect(startup).toBe(ordinary);
    expect(vi.getTimerCount()).toBe(1);
    pending.resolve(false);
    await pass;
    await expect(ordinary).resolves.toEqual({ status: 'drained' });
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports the exact five-second timeout once and observes eventual scheduled rejection', async () => {
    const { owner, reconciler } = setup();
    const pending = deferred<boolean>();
    const error = new Error('late read');
    vi.mocked(WorkspaceService.checkoutExists).mockReturnValueOnce(pending.promise);
    owner.start(reconciler);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(WorkspaceService.checkoutExists).toHaveBeenCalledTimes(1);
    const disposed = owner.dispose();
    const settled = vi.fn();
    void disposed.then(settled);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await disposed;
    expect(outcome).toEqual({ status: 'timed-out' });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      '[workspace] Reconciliation disposal timed out; late cache writes remain fenced'
    );
    pending.reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      '[workspace] reconciliation failed:',
      error
    );
    expect(owner.dispose()).toBe(disposed);
    expect(await owner.dispose()).toBe(outcome);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['throw', 'reject'] as const)(
    'memoizes unexpected disposal %s as an observable failure',
    async (mode) => {
      const { owner, reconciler } = setup();
      const error = new Error('disposal failed');
      owner.start(reconciler);
      const dispose = vi.spyOn(reconciler, 'dispose').mockImplementation(() => {
        if (mode === 'throw') throw error;
        return Promise.reject(error);
      });
      const first = owner.dispose();
      expect(owner.dispose()).toBe(first);
      await expect(first).rejects.toBe(error);
      expect(owner.dispose()).toBe(first);
      await expect(owner.dispose()).rejects.toBe(error);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(() => owner.start(reconciler)).toThrow(/disposed/i);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );
});
