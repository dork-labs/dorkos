// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createMockTransport } from '@dorkos/test-utils';
import { CommunityConnectionDescriptorSchema } from '@dorkos/shared/community-connections';
import { RemoteCommunityRoomSchema } from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { CommunityChannelGroups } from '../ui/CommunityChannelGroups';

afterEach(cleanup);
const connection = (ref: string) =>
  CommunityConnectionDescriptorSchema.parse({
    ref,
    remoteCommunityId: `deployment-${ref}`,
    label: `Community ${ref}`,
    pinnedOrigin: `https://${ref}.example.com`,
    connectedHumanMemberId: 'person',
    status: 'connected',
    expiresAt: null,
  });
const room = (community: string) =>
  RemoteCommunityRoomSchema.parse({
    community,
    roomId: 'same',
    remoteCommunityId: `deployment-${community}`,
    kind: 'channel',
    title: 'General',
    slug: 'general',
    topic: null,
    archived: false,
    createdAt: '2026-09-16T10:00:00Z',
    lastActivityAt: '2026-09-16T10:00:00Z',
    unreadCount: 2,
    visibility: 'public',
    readable: true,
    writable: true,
    joined: true,
    stale: false,
    cacheCursor: null,
    lastRemoteSeq: 0,
  });

function mount(failFirst = false) {
  const transport = createMockTransport();
  vi.mocked(transport.listCommunityConnections).mockResolvedValue([
    connection('a'),
    connection('b'),
  ]);
  vi.mocked(transport.listRemoteCommunityRooms).mockImplementation(async (ref) => {
    if (ref === 'a' && failFirst) throw new Error('offline');
    return { community: room(ref).community, rooms: [room(ref)], stale: false };
  });
  const root = createRootRoute({ component: CommunityChannelGroups, staticData: { header: null } });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('community channel discovery', () => {
  it('addresses identical channel IDs with different community refs', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole('link', { name: /general/ })).toHaveLength(2));
    const links = screen.getAllByRole('link', { name: /general/ });
    const addresses = links.map((link) => new URL(link.getAttribute('href')!, 'http://localhost'));
    expect(addresses.map((url) => url.searchParams.get('community'))).toEqual(['a', 'b']);
    expect(addresses.map((url) => url.searchParams.get('id'))).toEqual(['same', 'same']);
    expect(screen.getAllByLabelText('2 unread messages')).toHaveLength(2);
  });
  it('keeps a healthy community visible when another fails', async () => {
    const transport = mount(true);
    await waitFor(() => expect(transport.listRemoteCommunityRooms).toHaveBeenCalledWith('b'));
    expect(await screen.findByRole('link', { name: /general/ })).toHaveAttribute(
      'href',
      expect.stringContaining('community=b')
    );
    expect(await screen.findByText(/Community unavailable/)).toBeInTheDocument();
  });
});
