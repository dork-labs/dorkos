/**
 * The request card inside the room whose turn raised it (spec
 * `agent-permissions` D7): drawn in that room, not in another, answered from
 * there like anywhere else.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import { discardSettlingApprovals } from '@/layers/features/approvals';
import { RoomApprovalCards } from '../ui/RoomApprovalCards';

/** A Rooms request DorkBot's turn in `room-lunar` raised. */
function roomRequest(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ00000000000000000000R1',
    capabilityId: 'rooms.create',
    capabilityTitle: 'Open a room',
    tier: 'act',
    summary: '"DorkBot" wants to run "Open a room" with title: "proj-lunar"',
    requestedBy: 'DorkBot',
    hasAgentPath: true,
    area: 'rooms',
    alwaysOffered: true,
    roomId: 'room-lunar',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Render the cards for one room over a mock transport. */
function renderCards(roomId: string, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, ...render(<RoomApprovalCards roomId={roomId} />, { wrapper: Wrapper }) };
}

beforeAll(() => {
  // `sonner` asks for matchMedia when a refused answer toasts.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  discardSettlingApprovals();
});

describe('RoomApprovalCards', () => {
  it('draws the card in the room whose turn raised it', async () => {
    renderCards('room-lunar', {
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [roomRequest()] }),
    });

    expect(await screen.findByRole('button', { name: 'Always allow' })).toBeInTheDocument();
    expect(screen.getByText('Open a room')).toBeInTheDocument();
  });

  it('draws nothing in another room, or for a request no room raised', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({
      approvals: [
        roomRequest(),
        roomRequest({ approvalId: '01JZ00000000000000000000R2', roomId: undefined }),
      ],
    });
    renderCards('room-other', { listPendingApprovals });

    await waitFor(() => expect(listPendingApprovals).toHaveBeenCalled());
    // The read landed (the call resolved) and still nothing is drawn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-slot="room-approvals"]')).toBeNull();
  });

  it('answers from the room the same way it answers anywhere', async () => {
    const grantApproval = vi.fn().mockResolvedValue({ ok: true, outcome: 'granted' });
    renderCards('room-lunar', {
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [roomRequest()] }),
      grantApproval,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Always allow' }));

    expect(grantApproval).toHaveBeenCalledWith('01JZ00000000000000000000R1', { answer: 'always' });
    expect(await screen.findByText('Always allowed for DorkBot: Open a room')).toBeInTheDocument();
  });
});
