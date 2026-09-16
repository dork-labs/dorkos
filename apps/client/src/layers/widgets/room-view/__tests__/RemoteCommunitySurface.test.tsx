// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  RemoteCommunityRoomSchema,
  type RemoteCommunityEvent,
} from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RemoteCommunitySurface } from '../ui/RemoteCommunitySurface';

afterEach(cleanup);
const room = RemoteCommunityRoomSchema.parse({
  community: 'a',
  roomId: 'same',
  remoteCommunityId: 'deployment',
  kind: 'channel',
  title: 'General',
  slug: 'general',
  topic: null,
  archived: false,
  createdAt: '2026-09-16T10:00:00Z',
  lastActivityAt: '2026-09-16T10:00:00Z',
  unreadCount: 0,
  visibility: 'public',
  readable: true,
  writable: true,
  joined: true,
  stale: false,
  cacheCursor: null,
  lastRemoteSeq: 0,
});
function mount() {
  const transport = createMockTransport();
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let emit!: (event: RemoteCommunityEvent) => void;
  vi.mocked(transport.getRemoteCommunityRoom).mockResolvedValue(room);
  vi.mocked(transport.listRemoteCommunityEntries).mockResolvedValue({
    community: room.community,
    roomId: room.roomId,
    entries: [],
    nextCursor: null,
    lastRemoteSeq: 0,
    stale: false,
  });
  vi.mocked(transport.listRemoteCommunityMembers).mockResolvedValue({
    community: room.community,
    roomId: room.roomId,
    members: [],
    stale: false,
  });
  vi.mocked(transport.subscribeRemoteCommunityRoom).mockImplementation(
    async (_ref, _room, callback, options) => {
      emit = callback;
      callback({
        type: 'snapshot',
        room,
        entries: [],
        cursor: null,
        lastRemoteSeq: 0,
        stale: false,
      });
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      );
    }
  );
  const onThread = vi.fn();
  const mounted = render(
    <QueryClientProvider client={queries}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <RemoteCommunitySurface community="a" roomId="same" onThread={onThread} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...mounted, transport, emit: (event: RemoteCommunityEvent) => emit(event), onThread };
}

describe('remote community surface', () => {
  it('keeps local Stop available when remote access is revoked and hides the composer', async () => {
    const view = mount();
    await waitFor(() => expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalled());
    act(() =>
      view.emit({
        type: 'closed',
        community: room.community,
        roomId: room.roomId,
        reason: 'revoked',
      })
    );
    expect(
      await screen.findByText('You no longer have access to this channel.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop my agents' }));
    await waitFor(() =>
      expect(view.transport.haltRemoteCommunityRoom).toHaveBeenCalledWith('a', 'same')
    );
    expect(view.transport.haltRoom).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('refreshes the live room authority after joining instead of retaining a read-only snapshot', async () => {
    const view = mount();
    vi.mocked(view.transport.joinRemoteCommunityRoom).mockResolvedValue(room);
    await waitFor(() =>
      expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalledTimes(1)
    );
    act(() =>
      view.emit({
        type: 'snapshot',
        room: { ...room, joined: false, writable: false },
        entries: [],
        cursor: null,
        lastRemoteSeq: 0,
        stale: false,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Join channel' }));
    await waitFor(() =>
      expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalledTimes(2)
    );
    expect(screen.queryByRole('button', { name: 'Join channel' })).not.toBeInTheDocument();
  });

  it('sends only through the qualified remote transport and leaves local room APIs unused', async () => {
    const view = mount();
    vi.mocked(view.transport.postRemoteCommunityEntry).mockRejectedValue(
      new Error('Network unavailable')
    );
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'Hello remote community' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() =>
      expect(view.transport.postRemoteCommunityEntry).toHaveBeenCalledWith(
        'a',
        'same',
        expect.objectContaining({
          text: 'Hello remote community',
          idempotencyKey: expect.any(String),
        })
      )
    );
    expect(await screen.findByText('Delivery not confirmed.')).toBeInTheDocument();
    expect(view.transport.postToRoom).not.toHaveBeenCalled();
  });
});
