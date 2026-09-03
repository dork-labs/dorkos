// @vitest-environment jsdom
/**
 * What the foot of the room sheet does when the way back is refused.
 *
 * A channel's `#slug` is only reserved while it is live, so un-archiving has to
 * reclaim one and can find it taken — the one failure here a person can
 * actually act on, because the name field is a few lines above this button.
 * That only works if the server's own sentence reaches them, so these assert
 * through the REAL `createQueryClientConfig`: the line under test is the one
 * the shared mutation toast composes, not one the test wrote.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib/query-client';
import type { RoomDetailsRoom } from '../model/room-details';
import { RoomDetailsFooter } from '../ui/RoomDetailsFooter';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ARCHIVED: RoomDetailsRoom = {
  id: 'room-1',
  kind: 'channel',
  slug: 'backend',
  title: 'Backend',
  topic: null,
  archived: true,
  createdAt: '2026-07-26T10:00:00.000Z',
};

function renderFooter(room: RoomDetailsRoom, transport: Transport) {
  const queryClient = new QueryClient(createQueryClientConfig());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<RoomDetailsFooter room={room} />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('RoomDetailsFooter', () => {
  it('lets the server say why a room could not come back, in one line', async () => {
    // The name was taken while the room was away, and the way out — rename it
    // above, press this again — is only findable if the sentence arrives. Red
    // if a per-call `onError` is added here (two lines for one failure) or if
    // the toast is suppressed (none at all, on the one failure a person can fix).
    const transport = createMockTransport({
      updateRoom: vi.fn().mockRejectedValue(new Error('A channel called #backend already exists')),
    });
    renderFooter(ARCHIVED, transport);

    fireEvent.click(screen.getByRole('button', { name: 'Bring this room back' }));

    await waitFor(() =>
      // `expect.anything()` covers the shared "Report" action every
      // mutation-error toast carries; query-client.test.ts owns its content.
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't bring that room back",
        expect.objectContaining({ description: "A channel called #backend already exists" })
      )
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('leaves the room archived and the way back where it was', async () => {
    // The button must not flip to "Archive room" on a write that did not land:
    // it would be offering to archive a room that never came back.
    const transport = createMockTransport({
      updateRoom: vi.fn().mockRejectedValue(new Error('A channel called #backend already exists')),
    });
    renderFooter(ARCHIVED, transport);

    const back = screen.getByRole('button', { name: 'Bring this room back' });
    fireEvent.click(back);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(back).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Archive room' })).not.toBeInTheDocument();
  });

  it('says nothing at all when the room does come back', async () => {
    // Archiving and un-archiving both redraw the sheet the button lives in —
    // the badge appears, the button changes verb — so a toast confirming it is
    // a notification about something already on screen.
    const transport = createMockTransport({ updateRoom: vi.fn().mockResolvedValue({}) });
    renderFooter(ARCHIVED, transport);

    fireEvent.click(screen.getByRole('button', { name: 'Bring this room back' }));

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: false })
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
