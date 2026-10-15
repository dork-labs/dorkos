import { mkdtemp, rm } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  proveInstalledLocalBrowserUi,
  proveInstalledPreparationFailure,
} from '../pages/local-browser-installed-proof';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function wrongHomeFixture() {
  const expected = await mkdtemp(path.join(tmpdir(), 'browser-proof-expected-'));
  const foreign = await mkdtemp(path.join(tmpdir(), 'browser-proof-foreign-'));
  directories.push(expected, foreign);
  const request = {
    get: vi.fn(async () => ({ ok: () => true, json: async () => ({ dorkHome: foreign }) })),
    post: vi.fn(async () => {
      throw new Error('A foreign server must never receive reset or seed');
    }),
    patch: vi.fn(async () => {
      throw new Error('A foreign server must never receive a config patch');
    }),
  };
  const close = vi.fn(async (): Promise<void> => undefined);
  const page = { request } as unknown as Page;
  const context = { newPage: vi.fn(async () => page), close };
  const browser = { newContext: vi.fn(async () => context) } as unknown as Browser;
  return { expected, foreign, request, close, browser };
}

describe('installed browser proof caller custody', () => {
  it('refuses the preparation-error caller before reset, seed, or patch and closes its context', async () => {
    const fixture = await wrongHomeFixture();
    await expect(
      proveInstalledPreparationFailure(
        fixture.browser,
        'http://127.0.0.1:6543',
        path.join(fixture.expected, 'output'),
        fixture.expected
      )
    ).rejects.toThrow(/explicitly owned data directory/);
    expect(fixture.request.get).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:6543/api/config');
    expect(fixture.request.post).not.toHaveBeenCalled();
    expect(fixture.request.patch).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('refuses the normal caller before mutation and closes both context and its local fixture', async () => {
    const fixture = await wrongHomeFixture();
    const closeFixture = vi.spyOn(Server.prototype, 'close');
    const closeConnections = vi.spyOn(Server.prototype, 'closeAllConnections');
    await expect(
      proveInstalledLocalBrowserUi(
        fixture.browser,
        'http://127.0.0.1:6543',
        path.join(fixture.expected, 'output'),
        fixture.expected
      )
    ).rejects.toThrow(/explicitly owned data directory/);
    expect(fixture.request.post).not.toHaveBeenCalled();
    expect(fixture.request.patch).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(closeConnections).toHaveBeenCalledOnce();
    expect(closeFixture).toHaveBeenCalledOnce();
    expect((closeFixture.mock.contexts[0] as Server).listening).toBe(false);
  });
});
