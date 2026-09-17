// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  RemoteCommunityEntrySchema,
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
const ownerEntry = RemoteCommunityEntrySchema.parse({
  community: 'a',
  roomId: 'same',
  id: 'owner-confirmed',
  authorId: 'owner',
  authorKind: 'human',
  authorDisplayName: 'Alex Owner',
  text: 'The accepted owner post is visible',
  mentions: [],
  parentEntryId: null,
  threadRootEntryId: null,
  depth: 0,
  remoteSeq: 1,
  attachments: [],
  cursor: 'cursor-1',
  createdAt: '2026-09-16T10:00:00Z',
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
  vi.mocked(transport.setRemoteCommunityReadCursor).mockResolvedValue({
    cursor: null,
    unreadCount: 0,
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

  it('shows agent deliveries as unconfirmed and removes them on an empty replacement', async () => {
    const view = mount();
    await waitFor(() => expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalled());
    const delivery = {
      idempotencyKey: 'agent-output',
      author: { kind: 'agent' as const, displayName: 'Builder' },
      text: 'Local agent output',
      parentEntryId: null,
      attachments: [{ name: 'proof.png', contentType: 'image/png', byteSize: 42 }],
      state: 'pending' as const,
      failure: null,
      retryable: false,
    };
    act(() =>
      view.emit({
        type: 'deliveries',
        community: room.community,
        roomId: room.roomId,
        deliveries: [delivery],
      })
    );
    expect(screen.getByText('Builder · Agent')).toBeInTheDocument();
    expect(screen.getByText('Waiting for community confirmation…')).toBeInTheDocument();
    expect(screen.getByText('proof.png')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'proof.png' })).not.toBeInTheDocument();
    act(() =>
      view.emit({
        type: 'deliveries',
        community: room.community,
        roomId: room.roomId,
        deliveries: [
          {
            idempotencyKey: delivery.idempotencyKey,
            author: delivery.author,
            text: delivery.text,
            parentEntryId: delivery.parentEntryId,
            attachments: delivery.attachments,
            state: 'failed',
            failure: 'expired',
          },
        ],
      })
    );
    expect(
      screen.getByText('Delivery not confirmed. The retry window has ended.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Waiting for community confirmation…')).not.toBeInTheDocument();
    act(() =>
      view.emit({
        type: 'deliveries',
        community: room.community,
        roomId: room.roomId,
        deliveries: [],
      })
    );
    expect(screen.queryByText('Local agent output')).not.toBeInTheDocument();
  });

  it('offers retry only for eligible agent deliveries and refreshes after the qualified request', async () => {
    const view = mount();
    await waitFor(() =>
      expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalledTimes(1)
    );
    const delivery = {
      idempotencyKey: 'agent-retry',
      author: { kind: 'agent' as const, displayName: 'Builder' },
      text: 'Unconfirmed output',
      parentEntryId: null,
      attachments: [],
      state: 'pending' as const,
      failure: null,
      retryable: false,
    };
    const snapshot = {
      type: 'deliveries' as const,
      community: room.community,
      roomId: room.roomId,
      deliveries: [delivery],
    };
    act(() => view.emit(snapshot));
    expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument();
    act(() => view.emit({ ...snapshot, deliveries: [{ ...delivery, retryable: true }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    await waitFor(() =>
      expect(view.transport.retryRemoteCommunityDelivery).toHaveBeenCalledWith(
        'a',
        'same',
        'agent-retry'
      )
    );
    await waitFor(() =>
      expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalledTimes(2)
    );
    expect(screen.queryByText('Unconfirmed output')).not.toBeInTheDocument();
  });

  it('keeps an unconfirmed delivery visible when the retry is refused', async () => {
    const view = mount();
    vi.mocked(view.transport.retryRemoteCommunityDelivery).mockRejectedValue(
      new Error('The retry window has ended.')
    );
    await waitFor(() =>
      expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalledTimes(1)
    );
    act(() =>
      view.emit({
        type: 'deliveries',
        community: room.community,
        roomId: room.roomId,
        deliveries: [
          {
            idempotencyKey: 'refused-retry',
            author: { kind: 'agent', displayName: 'Builder' },
            text: 'Still unconfirmed',
            parentEntryId: null,
            attachments: [],
            state: 'pending',
            failure: null,
            retryable: true,
          },
        ],
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(await screen.findByText('The retry window has ended.')).toBeInTheDocument();
    expect(screen.getByText('Still unconfirmed')).toBeInTheDocument();
    expect(view.transport.subscribeRemoteCommunityRoom).toHaveBeenCalledTimes(1);
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

  it('reveals a confirmed owner post without waiting for a remote stream echo', async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const view = mount();
    vi.mocked(view.transport.postRemoteCommunityEntry).mockResolvedValue(ownerEntry);
    try {
      const input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: ownerEntry.text } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      await waitFor(() =>
        expect(view.transport.postRemoteCommunityEntry).toHaveBeenCalledWith(
          'a',
          'same',
          expect.objectContaining({ text: ownerEntry.text })
        )
      );
      expect(await screen.findByText(ownerEntry.text, { exact: true })).toBeVisible();
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        value: originalScrollTo,
      });
    }
  });
});
