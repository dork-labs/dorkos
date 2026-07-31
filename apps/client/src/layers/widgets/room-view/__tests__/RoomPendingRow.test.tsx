// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { usePendingPostStore, type PendingPost } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { RoomPendingRow } from '../ui/RoomPendingRow';

const ROOM = 'room-1';

function post(overrides: Partial<PendingPost> = {}): PendingPost {
  return {
    clientId: 'c1',
    roomId: ROOM,
    threadRootId: null,
    text: 'is the build ok?',
    status: 'sending',
    entryId: null,
    at: 0,
    ...overrides,
  };
}

function renderRow(pending: PendingPost, transport: Transport = createMockTransport()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(<RoomPendingRow post={pending} />, { wrapper: Wrapper });
}

beforeEach(() => {
  usePendingPostStore.setState({ posts: [post()] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RoomPendingRow', () => {
  it('keeps the words on screen while they are in the air', () => {
    renderRow(post());

    expect(screen.getByTestId('room-pending')).toHaveTextContent('is the build ok?');
    expect(screen.getByTestId('room-pending')).toHaveTextContent('Sending');
  });

  it('says a refused message is still here, and offers the two ways out', () => {
    renderRow(post({ status: 'failed' }));

    const row = screen.getByTestId('room-pending');
    expect(row).toHaveAttribute('data-status', 'failed');
    // The words above all — this is the only place they still exist.
    expect(row).toHaveTextContent('is the build ok?');
    expect(row).toHaveTextContent('Not sent.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('sends the same message again under the same id', async () => {
    const transport = createMockTransport();
    transport.postToRoom = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });
    renderRow(post({ status: 'failed' }), transport);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(transport.postToRoom).toHaveBeenCalledWith(ROOM, {
        text: 'is the build ok?',
      })
    );
    // Same client id, so the row already on screen moves back into flight
    // rather than a second copy of the sentence appearing under the first.
    await waitFor(() => {
      const held = usePendingPostStore.getState().posts;
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ clientId: 'c1', status: 'sending', entryId: 'entry-a' });
    });
  });

  it('re-sends a thread reply into its own thread', async () => {
    const transport = createMockTransport();
    transport.replyInThread = vi
      .fn()
      .mockResolvedValue({ accepted: true, entryId: 'entry-a', seq: 9 });
    usePendingPostStore.setState({ posts: [post({ threadRootId: 'root-1', status: 'failed' })] });
    renderRow(post({ threadRootId: 'root-1', status: 'failed' }), transport);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // Not `postToRoom`: a reply that retried into the room would put a private
    // aside in front of everyone.
    await waitFor(() =>
      expect(transport.replyInThread).toHaveBeenCalledWith(ROOM, {
        rootEntryId: 'root-1',
        text: 'is the build ok?',
      })
    );
    expect(transport.postToRoom).not.toHaveBeenCalled();
  });

  it('throws the words away only when somebody asks it to', () => {
    renderRow(post({ status: 'failed' }));

    expect(usePendingPostStore.getState().posts).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(usePendingPostStore.getState().posts).toHaveLength(0);
  });
});
