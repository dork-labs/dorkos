import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionFileWatcher, type ExtensionFolderWatch } from '../extension-file-watcher.js';

describe('installed extension copy file watches', () => {
  let home: string;
  let folder: string;
  let records: ExtensionRecord[];
  let watcher: ExtensionFileWatcher;
  let changed: () => void;
  let failed: (err: unknown) => void;
  let idle: Promise<void>;
  let releaseIdle: (() => void) | undefined;
  let author: string | undefined;
  let baselines: Set<string>;
  const listeners = new Set<() => void>();
  const refresh = vi.fn();
  const presence = vi.fn();
  const close = vi.fn(async () => undefined);
  const watch = vi.fn<ExtensionFolderWatch>((_root, change, error) => {
    changed = change;
    failed = error;
    return { close };
  });

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-watch-')));
    folder = path.join(home, 'extensions', 'desk');
    await fs.mkdir(folder, { recursive: true });
    records = [
      {
        id: 'desk',
        path: folder,
        origin: 'user',
        currentDigest: 'sha256:known',
        manifest: { id: 'desk', name: 'Desk', version: '1.0.0' },
      } as ExtensionRecord,
    ];
    idle = Promise.resolve();
    releaseIdle = undefined;
    author = undefined;
    baselines = new Set();
    listeners.clear();
    vi.clearAllMocks();
    watcher = new ExtensionFileWatcher({
      source: {
        dorkHome: home,
        listRecords: () => records,
        requestRefresh: refresh,
        whenIdle: () => idle,
        onChange: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      presenceChanged: presence,
      watch,
      baselineIds: async () => baselines,
      authorOf: () => author,
      quietMs: 10,
      maxWaitMs: 40,
      reconcileMs: 0,
    });
    await watcher.start();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    releaseIdle?.();
    await watcher.stop();
    vi.useRealTimers();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('coalesces a burst and checks presence before requesting discovery', async () => {
    for (let index = 0; index < 20; index++) changed();
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(presence).toHaveBeenCalledTimes(1);
    expect(presence.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]!);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps at most one more refresh while a scan is running', async () => {
    idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    changed();
    await vi.advanceTimersByTimeAsync(10);
    for (let index = 0; index < 50; index++) changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseIdle!();
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('never lets an automatic refresh establish first-sight trust', async () => {
    changed();
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledWith({ establishBaseline: false });
  });

  it('does not defer forever while writes keep arriving', async () => {
    for (let index = 0; index < 8; index++) {
      changed();
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('closes a failed watch and still asks the manager to judge the copy', async () => {
    failed(new Error('Watch unavailable'));
    await vi.advanceTimersByTimeAsync(10);
    expect(close).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending burst and unsubscribes on stop', async () => {
    changed();
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not watch core copies', async () => {
    records = records.map((record) => ({ ...record, origin: 'core' }));
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('keeps observing a known folder while its files cannot be digested', async () => {
    records = records.map((record) => ({ ...record, currentDigest: undefined }));
    for (const listener of listeners) listener();
    // Drain the root reconciliation before checking the existing handle.
    await watcher.start();
    expect(close).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(1);

    changed();
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not watch development links', async () => {
    records = records.map((record) => ({ ...record, devLink: { path: folder } }));
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('waits for an author copy to have a saved baseline before opening its watch', async () => {
    author = path.join(home, 'agents', 'rowan');
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(watch).toHaveBeenCalledTimes(1);

    baselines.add('desk');
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
  });
});
