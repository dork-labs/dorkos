// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { UnclaimedChat } from '@dorkos/shared/relay-schemas';
import { ClaimFeed } from '../ui/ClaimFeed';

// "Answer in a channel" lands the person in the new channel via the router.
// The component is rendered outside a router here, so its one router call is
// mocked — the same pattern `BindingBridgeSection.test.tsx` uses for the
// "Bridge to a channel" action this primary action shares a path with.
const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateSpy }));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// `useUnclaimedChatsSync` rides the global `/api/events` fan-out, which needs
// the app-level `EventStreamProvider`. Nothing here is about that stream, so
// it is stubbed rather than dragging the provider into this test — the same
// approach `DashboardSidebar.test.tsx` uses.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: () => {},
  };
});

function chat(overrides: Partial<UnclaimedChat> = {}): UnclaimedChat {
  return {
    id: 'uc-1',
    adapterId: 'telegram-1',
    chatId: '998877',
    channelType: 'dm',
    chatKind: 'dm',
    senderName: 'Miguel',
    senderId: '42',
    chatTitle: null,
    status: 'pending',
    messageCount: 1,
    firstSeenAt: '2026-08-03T10:00:00.000Z',
    lastSeenAt: '2026-08-03T10:00:00.000Z',
    decidedAt: null,
    decidedAgentId: null,
    ...overrides,
  };
}

let transport: Transport;

function renderFeed() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ClaimFeed enabled />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  navigateSpy.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  transport = createMockTransport({
    listUnclaimedChats: vi.fn().mockResolvedValue([chat()]),
    listMeshAgents: vi.fn().mockResolvedValue({ agents: [{ id: 'dorkbot', name: 'DorkBot' }] }),
  });
});

afterEach(cleanup);

describe('ClaimFeed — "Answer in a channel" (DOR-882)', () => {
  it('the primary action claims with bridge: true and lands the person in the new channel', async () => {
    const claimed = {
      id: 'b-1',
      adapterId: 'telegram-1',
      agentId: 'dorkbot',
      bridge: 'room',
      roomId: 'room-42',
    };
    transport.claimUnclaimedChat = vi.fn().mockResolvedValue({ binding: claimed });
    renderFeed();

    await waitFor(() => expect(screen.getByText('Miguel messaged your bot')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Answer in a channel' }));

    await waitFor(() =>
      expect(transport.claimUnclaimedChat).toHaveBeenCalledWith('uc-1', {
        agentId: 'dorkbot',
        bridge: true,
      })
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({ to: '/channels', search: { id: 'room-42' } })
    );
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('DorkBot will answer this chat in a new channel')
    );
  });

  it('the secondary action claims with bridge: false and never navigates', async () => {
    const claimed = { id: 'b-1', adapterId: 'telegram-1', agentId: 'dorkbot', bridge: 'off' };
    transport.claimUnclaimedChat = vi.fn().mockResolvedValue({ binding: claimed });
    renderFeed();

    await waitFor(() => expect(screen.getByText('Miguel messaged your bot')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Answer privately' }));

    await waitFor(() =>
      expect(transport.claimUnclaimedChat).toHaveBeenCalledWith('uc-1', {
        agentId: 'dorkbot',
        bridge: false,
      })
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('a bridge failure still reports the claim as answered, with a warning naming why — never a silent drop', async () => {
    const claimed = { id: 'b-1', adapterId: 'telegram-1', agentId: 'dorkbot', bridge: 'off' };
    transport.claimUnclaimedChat = vi.fn().mockResolvedValue({
      binding: claimed,
      bridgeError: 'This is a broadcast channel, not a two-way conversation',
    });
    renderFeed();

    await waitFor(() => expect(screen.getByText('Miguel messaged your bot')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Answer in a channel' }));

    await waitFor(() => expect(transport.claimUnclaimedChat).toHaveBeenCalled());
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('broadcast channel'))
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
