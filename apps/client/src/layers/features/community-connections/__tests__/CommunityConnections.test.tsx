/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { createMockTransport } from '@dorkos/test-utils';
import { getCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { getCommunityRouteEpoch, TransportProvider } from '@/layers/shared/model';
import { communityKeys } from '@/layers/entities/community';
import { CommunityConnections } from '../ui/CommunityConnections';

const a: CommunityConnectionDescriptor = {
  ref: CommunityRefSchema.parse('ref-a'),
  remoteCommunityId: 'same-id',
  label: 'Community A',
  pinnedOrigin: 'https://a.example',
  connectedHumanMemberId: 'person',
  status: 'connected',
  expiresAt: null,
  access: {
    state: 'verified',
    effective: { read: true, post: true, enrollAgent: true, stream: true },
    lastKnown: {
      lifecycle: 'active',
      capabilities: { read: true, post: true, enrollAgent: true, stream: true },
      verifiedAt: '2026-09-21T12:00:00.000Z',
    },
  },
  attention: {
    state: 'verified',
    unreadCount: 0,
    mentionCount: 0,
    verifiedAt: '2026-09-21T12:00:00.000Z',
  },
};
const b = {
  ...a,
  ref: CommunityRefSchema.parse('ref-b'),
  label: 'Community B',
  pinnedOrigin: 'https://b.example',
};
afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});
function mount(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <CommunityConnections />
      </TransportProvider>
    </QueryClientProvider>
  );
  return client;
}

describe('community pairing controls', () => {
  it('connects through Transport and shows the public browser approval link', async () => {
    const user = userEvent.setup();
    const pending = {
      ...a,
      status: 'pending' as const,
      connectedHumanMemberId: null,
      access: null,
      attention: null,
    };
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([pending]);
    const transport = createMockTransport({
      listCommunityConnections: list,
      startCommunityConnection: vi.fn().mockResolvedValue({
        connection: pending,
        approvalUrl: 'https://a.example/pair?code=public',
      }),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    mount(transport);
    expect(await screen.findByText('No communities connected.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Community address'), 'https://a.example');
    await user.click(screen.getByRole('button', { name: 'Connect community' }));
    expect(transport.startCommunityConnection).toHaveBeenCalledWith({
      url: 'https://a.example',
      installName: 'My DorkOS',
    });
    const link = await screen.findByRole('link', { name: 'Open Community A to approve' });
    expect(link).toHaveAttribute('href', 'https://a.example/pair?code=public');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveFocus();
  });
  it('disconnects only the selected ref after confirmation and drops its cached data', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValueOnce([a, b]).mockResolvedValue([b]),
    });
    const client = mount(transport);
    await user.click(await screen.findByRole('button', { name: 'Disconnect Community A' }));
    const currentAuthority = getCommunityAuthority();
    if (!currentAuthority.ownerKey) throw new Error('Community owner was not confirmed');
    const authority = {
      ...currentAuthority,
      ownerKey: currentAuthority.ownerKey,
      route: getCommunityRouteEpoch(),
    };
    client.setQueryData(communityKeys.room(authority, a.ref, 'same-room-id'), { text: 'A only' });
    client.setQueryData(communityKeys.room(authority, b.ref, 'same-room-id'), { text: 'B only' });
    expect(transport.disconnectCommunity).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep connected' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Keep connected' }));
    expect(screen.getByRole('button', { name: 'Disconnect Community A' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Disconnect Community A' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    await waitFor(() => expect(transport.disconnectCommunity).toHaveBeenCalledWith(a.ref));
    await waitFor(() => expect(screen.queryByText('Community A')).not.toBeInTheDocument());
    expect(screen.getByText('Community B')).toBeInTheDocument();
    expect(screen.getByLabelText('Community address')).toHaveFocus();
    expect(
      client.getQueryData(communityKeys.room(authority, a.ref, 'same-room-id'))
    ).toBeUndefined();
    expect(client.getQueryData(communityKeys.room(authority, b.ref, 'same-room-id'))).toEqual({
      text: 'B only',
    });
  });
  it('says so when this DorkOS disconnected but the Community could not be told', async () => {
    const user = userEvent.setup();
    mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValueOnce([a, b]).mockResolvedValue([b]),
        disconnectCommunity: vi.fn().mockResolvedValue({ remoteRevoked: false }),
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Disconnect Community A' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Community A is disconnected here, but it couldn’t be reached. To finish, remove this DorkOS under Local connections on Community A.'
    );
    await waitFor(() => expect(screen.queryByText('Community A')).not.toBeInTheDocument());
  });
  it('retains the connection after a failed disconnect', async () => {
    const user = userEvent.setup();
    mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValue([a]),
        disconnectCommunity: vi.fn().mockRejectedValue(new Error('offline')),
      })
    );
    await user.click(await screen.findByRole('button', { name: 'Disconnect Community A' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm disconnection');
    expect(screen.getByText('Community A')).toBeInTheDocument();
  });
  it('explains how to replace a rejected grant and removes its local connection', async () => {
    const user = userEvent.setup();
    const reconnectRequired = {
      ...a,
      status: 'reconnect-required' as CommunityConnectionDescriptor['status'],
    };
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([reconnectRequired]),
    });
    mount(transport);
    expect(await screen.findByText('Reconnect required')).toBeInTheDocument();
    expect(screen.getByText('Disconnect here, then connect again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect Community A' }));
    await waitFor(() => expect(transport.disconnectCommunity).toHaveBeenCalledWith(a.ref));
  });
  it('handles expired approval and removes the pending row after a refreshed list', async () => {
    const pending = { ...a, status: 'pending' as const };
    mount(
      createMockTransport({
        listCommunityConnections: vi.fn().mockResolvedValueOnce([pending]).mockResolvedValue([]),
        pollCommunityConnection: vi.fn().mockResolvedValue({ status: 'expired', connection: null }),
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Approval for Community A expired')
    );
    expect(await screen.findByText('No communities connected.')).toBeInTheDocument();
  });
  it('renders an honest failed-list state with a working retry', async () => {
    const user = userEvent.setup();
    mount(
      createMockTransport({
        listCommunityConnections: vi
          .fn()
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValue([b]),
      })
    );
    expect(await screen.findByText('Couldn’t load communities')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Community B')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });
});
