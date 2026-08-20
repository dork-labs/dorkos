// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib';
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
    platformChatType: null,
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

function renderFeed(
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
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
  vi.mocked(toast.error).mockReset();
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

  it('a chat already claimed by someone else opens the move dialog, never a duplicate toast', async () => {
    // The real error policy (`createQueryClientConfig`), not the bare test
    // client — `useClaimUnclaimedChat`'s `meta.suppressErrorToast` is what
    // this proves: without it, the shared mutation cache would ALSO toast
    // underneath the dialog this opens instead.
    const conflict = Object.assign(new Error('already bound'), {
      code: 'CHAT_ALREADY_BOUND',
      body: { conflict: { bindingId: 'b-existing', agentId: 'scribe' } },
    });
    transport.claimUnclaimedChat = vi.fn().mockRejectedValue(conflict);
    renderFeed(new QueryClient(createQueryClientConfig()));

    await waitFor(() => expect(screen.getByText('Miguel messaged your bot')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Answer in a channel' }));

    await waitFor(() =>
      expect(screen.getByText('This chat already reaches someone')).toBeInTheDocument()
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a genuine claim failure still reports exactly once, now from ClaimFeed itself', async () => {
    // Suppressing the shared toast (finding above) must not go silent on a
    // REAL failure — this is the fallback that keeps it a one-toast story.
    transport.claimUnclaimedChat = vi.fn().mockRejectedValue(new Error('adapter unreachable'));
    renderFeed(new QueryClient(createQueryClientConfig()));

    await waitFor(() => expect(screen.getByText('Miguel messaged your bot')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Answer in a channel' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('adapter unreachable'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('This chat already reaches someone')).not.toBeInTheDocument();
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

describe('ClaimFeed — the group-add claim flow (DOR-883)', () => {
  it('Join always claims with bridge: true for a group', async () => {
    const claimed = {
      id: 'b-1',
      adapterId: 'telegram-1',
      agentId: 'dorkbot',
      bridge: 'room',
      roomId: 'room-9',
    };
    transport.claimUnclaimedChat = vi.fn().mockResolvedValue({ binding: claimed });
    transport.listUnclaimedChats = vi
      .fn()
      .mockResolvedValue([
        chat({ chatKind: 'group', platformChatType: 'supergroup', chatTitle: 'Release train' }),
      ]);
    renderFeed();

    await waitFor(() =>
      expect(screen.getByText('Miguel added your bot to “Release train”')).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() =>
      expect(transport.claimUnclaimedChat).toHaveBeenCalledWith('uc-1', {
        agentId: 'dorkbot',
        bridge: true,
      })
    );
  });

  it('Leave calls the transport and reports success, without navigating anywhere', async () => {
    transport.listUnclaimedChats = vi
      .fn()
      .mockResolvedValue([chat({ chatKind: 'group', platformChatType: 'supergroup' })]);
    transport.leaveUnclaimedChat = vi.fn().mockResolvedValue(undefined);
    renderFeed();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(transport.leaveUnclaimedChat).toHaveBeenCalledWith('uc-1'));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Left the group'))
    );
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('a broadcast channel offers only Ignore and Leave — no agent picker, no Join', async () => {
    transport.listUnclaimedChats = vi
      .fn()
      .mockResolvedValue([
        chat({ chatKind: 'group', platformChatType: 'channel', chatTitle: 'Announcements' }),
      ]);
    renderFeed();

    await waitFor(() =>
      expect(screen.getByText('Miguel added your bot to “Announcements”')).toBeInTheDocument()
    );

    expect(screen.getByRole('button', { name: 'Ignore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
