// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { BindingBridgeSection } from '../BindingBridgeSection';

// The bridge action lands the person in the new channel via the router. The
// component is rendered outside a router here, so its one router call is mocked.
const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateSpy }));

function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-1',
    adapterId: 'telegram-1',
    agentId: 'agent-1',
    chatId: '12345',
    // Default is a DM — the one shape the detail sheet can bridge. A private
    // chat is provably not a broadcast; group/broadcast cases override this.
    channelType: 'dm',
    sessionStrategy: 'per-chat',
    label: 'Ana',
    permissionMode: 'default',
    enabled: true,
    canInitiate: false,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    bridge: 'off',
    roomId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

let transport: Transport;

function renderSection(binding: AdapterBinding, onDone = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <BindingBridgeSection binding={binding} onDone={onDone} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  transport = createMockTransport();
  navigateSpy.mockReset();
});

afterEach(() => cleanup());

describe('BindingBridgeSection — bridge action (§3.1, A12.2)', () => {
  it('shows the three §9.4 warnings and a live bridge action for a bridgeable chat', () => {
    renderSection(makeBinding());
    expect(
      screen.getByText(/lets people you may not know put text in front of your agent/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/permission mode is the real bound/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps the whole record/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Bridge to a channel$/i })).toBeEnabled();
  });

  it('A12.2: one click fires updateBinding with bridge: "room" exactly once — no reload', async () => {
    (transport.updateBinding as Mock).mockResolvedValue(
      makeBinding({ bridge: 'room', roomId: 'room-9' })
    );
    renderSection(makeBinding());

    fireEvent.click(screen.getByRole('button', { name: /^Bridge to a channel$/i }));

    await waitFor(() => expect(transport.updateBinding).toHaveBeenCalledTimes(1));
    expect(transport.updateBinding).toHaveBeenCalledWith('b-1', { bridge: 'room' });
    // Lands in the new channel — one action, no restart or re-auth.
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({ to: '/channels', search: { id: 'room-9' } })
    );
  });
});

describe('BindingBridgeSection — refusals render their reason, not a dead button', () => {
  it('a chat-wildcard binding shows the reason and offers no bridge button', () => {
    renderSection(makeBinding({ chatId: undefined }));
    expect(screen.getByText(/Can't bridge this chat/i)).toBeInTheDocument();
    expect(screen.getByText(/reaches every chat here/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bridge to a channel/i })).not.toBeInTheDocument();
  });

  // DOR-907: a REAL broadcast (persisted platformChatType: 'channel') shows a
  // broadcast-specific reason, never bridged — a one-way feed is not a chat.
  it('a real broadcast binding (platformChatType: channel) shows the broadcast reason and offers no bridge button', () => {
    renderSection(makeBinding({ platformChatType: 'channel', channelType: 'group' }));
    expect(screen.getByText(/Can't bridge this chat/i)).toBeInTheDocument();
    expect(screen.getByText(/broadcast channel, not a two-way conversation/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bridge to a channel/i })).not.toBeInTheDocument();
  });

  // Back-compat: an OLD binding (no persisted platform type) that is a group by
  // its subject channel type takes the conservative refusal — we cannot prove
  // it is not a folded broadcast, so we do not bridge it.
  it('an old group binding with no platform type shows the conservative reason and offers no bridge button', () => {
    renderSection(makeBinding({ channelType: 'group', platformChatType: undefined }));
    expect(screen.getByText(/Can't bridge this chat/i)).toBeInTheDocument();
    expect(screen.getByText(/before we started noting/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bridge to a channel/i })).not.toBeInTheDocument();
  });
});

describe('BindingBridgeSection — a known group is now bridgeable (DOR-907)', () => {
  it('a group binding (platformChatType: group) shows the warnings and a live bridge action', () => {
    renderSection(makeBinding({ platformChatType: 'group', channelType: 'group' }));
    expect(
      screen.getByText(/lets people you may not know put text in front of your agent/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Bridge to a channel$/i })).toBeEnabled();
  });

  it('a supergroup binding (platformChatType: supergroup) is bridgeable', () => {
    renderSection(makeBinding({ platformChatType: 'supergroup', channelType: 'group' }));
    expect(screen.getByRole('button', { name: /^Bridge to a channel$/i })).toBeEnabled();
  });
});

describe('BindingBridgeSection — bridged state', () => {
  const bridgedRoom: RoomWithRoster = {
    id: 'room-9',
    kind: 'channel',
    title: 'Support',
    slug: 'support',
    topic: null,
    archived: false,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    members: [],
    viewerAuthorId: 'me',
    reactionFrequents: ['👍', '🎉', '❤️'],
    deliverNotices: false,
  } as unknown as RoomWithRoster;

  beforeEach(() => {
    (transport.getRoom as Mock).mockResolvedValue(bridgedRoom);
  });

  it('un-bridge confirms first, stating the archival consequences and the fresh-start path', async () => {
    renderSection(makeBinding({ bridge: 'room', roomId: 'room-9' }));

    fireEvent.click(screen.getByRole('button', { name: /un-bridge this chat/i }));

    // Consequences shown BEFORE the mutation fires.
    expect(await screen.findByText(/goes back to a private, one-to-one line/i)).toBeInTheDocument();
    expect(screen.getByText(/For a clean start with no old messages/i)).toBeInTheDocument();
    expect(transport.updateBinding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Un-bridge$/i }));
    await waitFor(() =>
      expect(transport.updateBinding).toHaveBeenCalledWith('b-1', { bridge: 'off' })
    );
  });

  it('offers the deliver-notices override labelled by what it does, and writes it to the room', async () => {
    renderSection(makeBinding({ bridge: 'room', roomId: 'room-9' }));

    const toggle = await screen.findByRole('switch', {
      name: /tell this chat when a turn fails or is stopped/i,
    });
    // Disabled until the room resolves, so it never flashes a wrong state
    // (Fix 3). Once loaded it reads its value from the room, not a guess.
    expect(toggle).toBeDisabled();
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith('room-9', { deliverNotices: true })
    );
  });
});
