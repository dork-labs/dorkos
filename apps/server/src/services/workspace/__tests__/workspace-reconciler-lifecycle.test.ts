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
});
