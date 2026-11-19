import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoBrowserDebugListener,
  proveOwnedBrowserViewer,
} from '../pages/browser-viewer-proof';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('sealed viewer proof custody', () => {
  it('refuses a foreign home before setup, browser actions or process inspection', async () => {
    const expected = await mkdtemp(path.join(tmpdir(), 'viewer-proof-owned-'));
    const foreign = await mkdtemp(path.join(tmpdir(), 'viewer-proof-foreign-'));
    directories.push(expected, foreign);
    const request = {
      get: vi.fn(async () => ({ ok: () => true, json: async () => ({ dorkHome: foreign }) })),
      post: vi.fn(),
      patch: vi.fn(),
    };
    const reload = vi.fn();
    await expect(
      proveOwnedBrowserViewer(
        { request, reload } as unknown as Page,
        'http://127.0.0.1:6543',
        expected
      )
    ).rejects.toThrow(/explicitly owned data directory/);
    expect(request.post).not.toHaveBeenCalled();
    expect(request.patch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('inspects only Chrome descendants of the owned server, without command arguments', async () => {
    const run = vi.fn(async (command: string, args: string[]) => ({
      stdout:
        command === '/bin/ps'
          ? '100 1 node\n101 100 Chromium\n102 101 Chrome Helper\n201 1 Google Chrome\n'
          : '',
    }));
    expect(await assertNoBrowserDebugListener(100, run)).toEqual({ checkedBrowserProcesses: 2 });
    expect(run.mock.calls[0]).toEqual(['/bin/ps', ['-axo', 'pid=,ppid=,comm=']]);
    expect(run.mock.calls[1]?.[1]).toContain('101,102');
  });

  it('fails if any owned Chrome process listens on TCP', async () => {
    const run = vi.fn(async (command: string) => ({
      stdout: command === '/bin/ps' ? '100 1 node\n101 100 Chromium\n' : 'p101\n',
    }));
    await expect(assertNoBrowserDebugListener(100, run)).rejects.toThrow(/must not listen/);
  });

  it('refuses a vacuous process proof with no owned Chrome', async () => {
    const run = vi.fn(async () => ({ stdout: '100 1 node\n201 1 Google Chrome\n' }));
    await expect(assertNoBrowserDebugListener(100, run)).rejects.toThrow(/owned Chrome/);
    expect(run).toHaveBeenCalledOnce();
  });
});
