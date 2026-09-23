// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import {
  confirmCommunityAuthority,
  invalidateCommunityAuthority,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';

// Capture each (event → handler) the hook registers, without a stream — the
// seam `use-agents-sync.test` uses.
const handlers = new Map<string, (data: unknown) => void>();
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: (event: string, handler: (data: unknown) => void) => {
    handlers.set(event, handler);
  },
}));

let confirmed: ConfirmedCommunityAuthority | null;
vi.mock('../model/use-community-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../model/use-community-navigation')>()),
  useConfirmedCommunityAuthority: () => confirmed,
}));

import { communityKeys } from '../model/use-community-connections';
import { useCommunityConnectionsSync } from '../model/use-community-connections-sync';

let client: QueryClient;

function mount() {
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCommunityConnectionsSync(), { wrapper });
}

beforeEach(() => {
  handlers.clear();
  vi.useFakeTimers();
  const pending = invalidateCommunityAuthority();
  confirmCommunityAuthority(pending.epoch, 'owner-a');
  confirmed = { epoch: pending.epoch, ownerKey: 'owner-a' };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  invalidateCommunityAuthority();
});

describe('useCommunityConnectionsSync', () => {
  it('subscribes to community_connections_changed and nothing else', () => {
    mount();

    expect([...handlers.keys()]).toEqual(['community_connections_changed']);
  });

  it("invalidates this owner's connection list on the event itself — no timer to wait out", () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mount();

    handlers.get('community_connections_changed')!({ changedAt: '2026-09-23T00:00:00.000Z' });

    // Synchronous with the frame: not a debounce, and certainly not the
    // 30-second poll this replaces.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: communityKeys.connections(confirmed!),
      exact: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves another owner's cached list alone, and reads nothing from the frame", () => {
    const other = { epoch: confirmed!.epoch, ownerKey: 'owner-b' };
    client.setQueryData(communityKeys.connections(confirmed!), []);
    client.setQueryData(communityKeys.connections(other), [{ ref: 'b-private' }]);
    client.setQueryData([...communityKeys.remote(other, 'b-private'), 'rooms'], ['B private']);
    mount();

    // A frame that tried to name another owner's connection is ignored whole:
    // the refetch is always this window's own owner-scoped list.
    handlers.get('community_connections_changed')!({
      changedAt: '2026-09-23T00:00:00.000Z',
      ownerKey: 'owner-b',
      ref: 'b-private',
    });

    expect(client.getQueryState(communityKeys.connections(confirmed!))?.isInvalidated).toBe(true);
    expect(client.getQueryState(communityKeys.connections(other))?.isInvalidated).toBe(false);
    expect(client.getQueryData(communityKeys.connections(other))).toEqual([{ ref: 'b-private' }]);
    expect(client.getQueryData([...communityKeys.remote(other, 'b-private'), 'rooms'])).toEqual([
      'B private',
    ]);
  });

  it('does nothing before an owner is confirmed', () => {
    confirmed = null;
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mount();

    handlers.get('community_connections_changed')!({ changedAt: '2026-09-23T00:00:00.000Z' });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
