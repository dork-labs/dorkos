// @vitest-environment jsdom
/**
 * What a room-settings failure says, and — the reason these hooks are split at
 * all — whether it says anything once its caller has gone.
 *
 * These assert through the REAL `createQueryClientConfig`, so the sentence
 * under test is the one a person actually reads, composed by the shared
 * mutation toast rather than by the test.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import {
  useArchiveRoom,
  useRenameRoom,
  useSetDeliverNotices,
  useUnarchiveRoom,
} from '../model/use-room-settings';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient(createQueryClientConfig());
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A transport whose `updateRoom` always refuses the way the server does. */
function refusingTransport(message: string): Transport {
  return createMockTransport({ updateRoom: vi.fn().mockRejectedValue(new Error(message)) });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('room settings failures', () => {
  it('names the attempt and lets the server say why', async () => {
    const transport = refusingTransport('A channel called #backend already exists');
    const { result } = renderHook(() => useRenameRoom(), { wrapper: wrapperFor(transport) });

    result.current.mutate({ roomId: 'room-1', title: 'Backend' });

    await waitFor(() =>
      // The second argument is the shared "Report" action every mutation-error
      // toast now carries; its content is query-client.test.ts's subject, not
      // this file's. Asserted as `anything()` rather than dropped, so a toast
      // raised with no options at all still fails here.
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't rename that room",
        expect.objectContaining({ description: 'A channel called #backend already exists' })
      )
    );
    // Exactly one line. A per-call `onError` toast beside this one is what
    // produced two toasts for a single failure.
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('still says why when the caller that started it has gone', async () => {
    // The case this whole split exists for. Archiving a room unmounts the row
    // that archived it, so the "Undo" offered afterwards runs against an
    // observer with no listeners — TanStack gates per-call `onError` on exactly
    // that, so a handler passed to `mutate` would never fire and the failure
    // would surface as the generic "That didn't work. Try again." on a room
    // the sidebar has already dropped and nothing else can bring back.
    const transport = refusingTransport('A channel called #backend already exists');
    const { result, unmount } = renderHook(() => useUnarchiveRoom(), {
      wrapper: wrapperFor(transport),
    });

    unmount();
    result.current.mutate({ roomId: 'room-1' });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't bring that room back",
        expect.objectContaining({ description: 'A channel called #backend already exists' })
      )
    );
  });

  it('sends the un-archive and its new name together, so one write decides both', async () => {
    // The server applies the rename before it judges the un-archive, which is
    // what lets a room come back under a different name when its own was taken
    // while it was away. Two calls could not do that: the first would be
    // refused.
    const transport = createMockTransport({ updateRoom: vi.fn().mockResolvedValue({}) });
    const { result } = renderHook(() => useUnarchiveRoom(), { wrapper: wrapperFor(transport) });

    result.current.mutate({ roomId: 'room-1', title: 'Backend two' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', {
        archived: false,
        title: 'Backend two',
      })
    );
  });

  it('omits the title when the room comes back under its own name', async () => {
    const transport = createMockTransport({ updateRoom: vi.fn().mockResolvedValue({}) });
    const { result } = renderHook(() => useUnarchiveRoom(), { wrapper: wrapperFor(transport) });

    result.current.mutate({ roomId: 'room-1' });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: false })
    );
  });

  it('archives by id alone', async () => {
    const transport = createMockTransport({ updateRoom: vi.fn().mockResolvedValue({}) });
    const { result } = renderHook(() => useArchiveRoom(), { wrapper: wrapperFor(transport) });

    result.current.mutate('room-1');

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: true })
    );
  });

  it('sets the per-bridge deliver-notices override on the room (chats-as-channels §6.2)', async () => {
    const transport = createMockTransport({ updateRoom: vi.fn().mockResolvedValue({}) });
    const { result } = renderHook(() => useSetDeliverNotices(), { wrapper: wrapperFor(transport) });

    result.current.mutate({ roomId: 'room-1', deliverNotices: true });

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { deliverNotices: true })
    );
  });
});
