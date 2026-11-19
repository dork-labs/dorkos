import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBrowserService } from '../../local-browser/service.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viewer-adapter-'));
  directories.push(dir);
  const events = new EventEmitter();
  const mainFrame = {};
  const page = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    mainFrame: () => mainFrame,
    frames: () => [],
    url: () => 'https://fixture.test/',
    title: async () => 'Fixture',
    isClosed: () => false,
    bringToFront: async () => undefined,
  } as unknown as Page;
  const context = {
    pages: () => [page],
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  const launch = vi.fn(async () => context);
  const service = new LocalBrowserService(
    dir,
    undefined,
    {
      launch,
      connect: vi.fn(async () => {
        throw Error('not used');
      }),
    },
    undefined,
    () => ({ platform: 'darwin' })
  );
  const access = vi.fn(async () => undefined);
  service.useProfileAccess(access, () => true);
  return { service, launch, context, access, events, mainFrame };
}

describe('existing agent window viewer adapter', () => {
  it('never acquires a browser for a viewer', async () => {
    const f = await fixture();
    await expect(f.service.viewerPages.resolve('chat')).rejects.toThrow('viewer_unavailable');
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('binds the existing agent window without changing its page or sharing it elsewhere', async () => {
    const f = await fixture();
    try {
      const state = await f.service.open({
        mode: 'new-window',
        sessionId: 'chat',
        profileId: 'profile',
      });
      const view = await f.service.viewerPages.resolve('chat');
      expect(view.identity).toEqual({
        chatId: 'chat',
        profileId: 'profile',
        connectionId: state.connectionId,
        tabId: state.selectedTabId,
      });
      await expect(f.service.viewerPages.resolve('other')).rejects.toThrow('viewer_unavailable');
      f.access.mockRejectedValueOnce(Error('grant ended'));
      await expect(view.assertCurrent()).rejects.toThrow('viewer_unavailable');
      expect(view.signal.aborted).toBe(true);
      expect(f.launch).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.disconnect();
    }
  });

  it('keeps a person-only window out of the agent viewer', async () => {
    const f = await fixture();
    try {
      await f.service.open({ mode: 'new-window' });
      await expect(f.service.viewerPages.resolve('chat')).rejects.toThrow('viewer_unavailable');
    } finally {
      await f.service.disconnect();
    }
  });

  it('revokes viewers before connection cleanup awaits Chrome', async () => {
    const f = await fixture();
    await f.service.open({ mode: 'new-window', sessionId: 'chat' });
    const view = await f.service.viewerPages.resolve('chat');
    const closing = f.service.disconnect();
    expect(view.signal.aborted).toBe(true);
    await closing;
  });
});
