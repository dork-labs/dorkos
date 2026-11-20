import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoBrowserDebugListener,
  proveOwnedBrowserViewer,
  signInBrowserViewerOwner,
  assertBrowserViewerSessionSurvivesReload,
  assertViewerCanvasHidden,
} from '../pages/browser-viewer-proof';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('viewer owner sign-in', () => {
  it('registers and steps up through the app page', async () => {
    const owner = {
      email: 'viewer@example.test',
      name: 'Viewer owner',
      password: 'made-up-password',
    };
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, proof: 'made-up-proof' }),
    }));
    const setItem = vi.fn();
    const post = vi.fn(async () => ({
      ok: () => true,
      text: async () => '',
      json: async () => ({ ok: true, proof: 'made-up-proof' }),
    }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', {
      localStorage: { setItem },
      location: { origin: 'http://127.0.0.1:6543' },
    });
    const page = {
      request: { post },
      context: () => ({ request: { post } }),
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      addInitScript: vi.fn(),
    };
    try {
      await signInBrowserViewerOwner(page as unknown as Page, 'http://127.0.0.1:6543', owner);
      expect(post).not.toHaveBeenCalled();
      expect(fetch.mock.calls).toEqual([
        [
          'http://127.0.0.1:6543/api/auth/sign-up/email',
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(owner),
          },
        ],
        [
          'http://127.0.0.1:6543/api/person-session',
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: owner.password }),
          },
        ],
      ]);
      expect(setItem).toHaveBeenCalledWith('dorkos.person-proof', 'made-up-proof');
      expect(page.addInitScript).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('observes the secure cookie across reload without refreshing the session', async () => {
    const cookie = {
      name: '__Secure-better-auth-fixture.session_token',
      value: 'made-up-cookie',
      secure: true,
    };
    const cookies = vi.fn().mockResolvedValue([cookie]);
    const reload = vi.fn();
    const request = { get: vi.fn(), post: vi.fn() };
    const page = { context: () => ({ cookies, request }), reload, request };
    await expect(
      assertBrowserViewerSessionSurvivesReload(page as unknown as Page, 'http://127.0.0.1:6543')
    ).resolves.toEqual({ secureSessionCookie: true, sessionCookieSurvivedReload: true });
    expect(cookies.mock.calls).toEqual([['http://127.0.0.1:6543'], ['http://127.0.0.1:6543']]);
    expect(reload).toHaveBeenCalledOnce();
    expect(request.get).not.toHaveBeenCalled();
    expect(request.post).not.toHaveBeenCalled();
  });

  it('refuses a session cookie lost on navigation', async () => {
    const cookies = vi
      .fn()
      .mockResolvedValueOnce([
        {
          name: '__Secure-better-auth-fixture.session_token',
          value: 'made-up-cookie',
          secure: true,
        },
      ])
      .mockResolvedValueOnce([]);
    const page = { context: () => ({ cookies }), reload: vi.fn() };
    await expect(
      assertBrowserViewerSessionSurvivesReload(page as unknown as Page, 'http://127.0.0.1:6543')
    ).rejects.toThrow('Browser-set session cookie must survive top-level reload');
  });
});

describe('viewer sign-out', () => {
  it('accepts a removed canvas without evaluating its missing node', async () => {
    const canvas = {
      count: vi.fn(async () => 0),
      evaluate: vi.fn(async () => {
        throw Error('The canvas node no longer exists');
      }),
    };
    await expect(assertViewerCanvasHidden(canvas as unknown as Locator)).resolves.toBeUndefined();
    expect(canvas.evaluate).not.toHaveBeenCalled();
  }, 10_000);

  it('waits until the visible canvas disappears', async () => {
    const canvas = { count: vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0) };
    await assertViewerCanvasHidden(canvas as unknown as Locator);
    expect(canvas.count).toHaveBeenCalledTimes(2);
  });
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
    const run = vi.fn(async (command: string, _args: string[]) => ({
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
