import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';

const principal = { ownerId: 'owner', sessionId: 'app', clientId: 'client' };
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture() {
  const f = await leaseFixture();
  fixtures.push(f);
  const access = vi.fn(async () => undefined);
  f.service.useProfileAccess(access, () => true);
  return { service: f.service, launch: f.backend.launch, access };
}

describe('existing agent window viewer adapter', () => {
  it('never acquires a browser for a viewer', async () => {
    const f = await fixture();
    await expect(f.service.viewerPages.resolve('chat', principal, 'viewer')).rejects.toThrow(
      'viewer_unavailable'
    );
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
      const view = await f.service.viewerPages.resolve('chat', principal, 'viewer');
      expect(view.identity).toEqual({
        chatId: 'chat',
        profileId: 'profile',
        connectionId: state.connectionId,
        tabId: state.selectedTabId,
      });
      await expect(f.service.viewerPages.resolve('other', principal, 'viewer')).rejects.toThrow(
        'viewer_unavailable'
      );
      f.access.mockRejectedValueOnce(Error('grant ended'));
      await expect(view.assertCurrent()).rejects.toThrow('viewer_unavailable');
      expect(view.signal.aborted).toBe(true);
      expect(f.launch).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.closeAll();
    }
  });

  it('keeps a person-only window out of the agent viewer', async () => {
    const f = await fixture();
    try {
      await f.service.open({ mode: 'new-window' });
      await expect(f.service.viewerPages.resolve('chat', principal, 'viewer')).rejects.toThrow(
        'viewer_unavailable'
      );
    } finally {
      await f.service.closeAll();
    }
  });

  it('revokes viewers before connection cleanup awaits Chrome', async () => {
    const f = await fixture();
    await f.service.open({ mode: 'new-window', sessionId: 'chat' });
    const view = await f.service.viewerPages.resolve('chat', principal, 'viewer');
    const closing = f.service.closeAll();
    expect(view.signal.aborted).toBe(true);
    await closing;
  });
});
