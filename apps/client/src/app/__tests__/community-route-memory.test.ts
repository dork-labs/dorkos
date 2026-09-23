import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { confirmCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { createCommunityRouteMemory } from '../community-route-memory';

/**
 * Every remembered place is a rewrite of `~/.dork/config.json`, so this pins
 * the one promise that keeps that cheap: a write goes out only when the value
 * changed from the last one this tab sent.
 */
describe('community route memory', () => {
  let transport: Transport;
  let remember: ReturnType<typeof createCommunityRouteMemory>;

  beforeEach(() => {
    const authority = invalidateCommunityAuthority();
    confirmCommunityAuthority(authority.epoch, 'local-owner');
    transport = createMockTransport() as Transport;
    remember = createCommunityRouteMemory(new QueryClient(), transport);
  });
  afterEach(() => {
    invalidateCommunityAuthority();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('saves a local route once, and again only when it changes', async () => {
    remember({ pathname: '/tasks', search: { view: 'board' } });
    await settle();
    remember({ pathname: '/tasks', search: { view: 'board' } });
    await settle();
    expect(transport.rememberCommunityInstallationDestination).toHaveBeenCalledTimes(1);

    remember({ pathname: '/tasks', search: { view: 'list' } });
    await settle();
    remember({ pathname: '/tasks', search: { view: 'board' } });
    await settle();
    expect(
      vi.mocked(transport.rememberCommunityInstallationDestination).mock.calls.map(([d]) => d)
    ).toEqual([
      { path: '/tasks', search: { view: 'board' } },
      { path: '/tasks', search: { view: 'list' } },
      { path: '/tasks', search: { view: 'board' } },
    ]);
  });

  it('saves a Community room once, and again only when the room or thread changes', async () => {
    const room = { pathname: '/channels', search: { community: 'a', id: 'room-1' } };
    remember(room);
    await settle();
    remember(room);
    await settle();
    expect(transport.getCommunityNavigation).toHaveBeenCalledTimes(1);
    expect(transport.rememberCommunityNavigation).toHaveBeenCalledTimes(1);

    remember({ pathname: '/channels', search: { community: 'a', id: 'room-1', thread: 't' } });
    await settle();
    expect(transport.rememberCommunityNavigation).toHaveBeenCalledTimes(2);
  });

  it('tries again after a failed write rather than trusting it landed', async () => {
    vi.mocked(transport.rememberCommunityInstallationDestination).mockRejectedValueOnce(
      new Error('offline')
    );
    remember({ pathname: '/tasks', search: {} });
    await settle();
    remember({ pathname: '/tasks', search: {} });
    await settle();
    expect(transport.rememberCommunityInstallationDestination).toHaveBeenCalledTimes(2);
  });

  it('saves the same place again for a different owner', async () => {
    remember({ pathname: '/tasks', search: {} });
    await settle();
    const next = invalidateCommunityAuthority();
    confirmCommunityAuthority(next.epoch, 'local-owner');
    remember({ pathname: '/tasks', search: {} });
    await settle();
    expect(transport.rememberCommunityInstallationDestination).toHaveBeenCalledTimes(2);
  });
});
