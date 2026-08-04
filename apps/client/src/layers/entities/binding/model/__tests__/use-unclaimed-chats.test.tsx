/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { UnclaimedChat } from '@dorkos/shared/relay-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useUnclaimedChats,
  useClaimUnclaimedChat,
  useIgnoreUnclaimedChat,
  useBlockUnclaimedChat,
} from '../use-unclaimed-chats';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const CHAT: UnclaimedChat = {
  id: 'uc-1',
  adapterId: 'telegram-1',
  chatId: '99887766',
  channelType: 'dm',
  chatKind: 'dm',
  senderName: 'Miguel',
  senderId: '4242',
  chatTitle: null,
  status: 'pending',
  messageCount: 3,
  firstSeenAt: '2026-08-03T10:00:00.000Z',
  lastSeenAt: '2026-08-03T10:05:00.000Z',
  decidedAt: null,
  decidedAgentId: null,
};

describe('useUnclaimedChats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the pending slice by default', async () => {
    const transport = createMockTransport({
      listUnclaimedChats: vi.fn().mockResolvedValue([CHAT]),
    });

    const { result } = renderHook(() => useUnclaimedChats(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.listUnclaimedChats).toHaveBeenCalledWith('pending');
    expect(result.current.data).toEqual([CHAT]);
  });

  it('skips the request entirely when disabled', () => {
    const transport = createMockTransport({
      listUnclaimedChats: vi.fn().mockResolvedValue([]),
    });

    renderHook(() => useUnclaimedChats('pending', false), {
      wrapper: createWrapper(transport),
    });

    expect(transport.listUnclaimedChats).not.toHaveBeenCalled();
  });

  it('carries no message body — the row exposes identity and counts only', async () => {
    const transport = createMockTransport({
      listUnclaimedChats: vi.fn().mockResolvedValue([CHAT]),
    });

    const { result } = renderHook(() => useUnclaimedChats(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The claim feed's central invariant: a stranger's text never reaches the
    // client at all, so no surface can render it or feed it to a model.
    const row = result.current.data?.[0] as Record<string, unknown>;
    for (const forbidden of ['body', 'text', 'message', 'content', 'payload']) {
      expect(row).not.toHaveProperty(forbidden);
    }
  });
});

describe('unclaimed-chat decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claim passes the agent through and returns the new binding', async () => {
    const binding = { id: 'b-1', adapterId: 'telegram-1', agentId: 'dorkbot' };
    const transport = createMockTransport({
      claimUnclaimedChat: vi.fn().mockResolvedValue({ binding }),
    });

    const { result } = renderHook(() => useClaimUnclaimedChat(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'uc-1', input: { agentId: 'dorkbot' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.claimUnclaimedChat).toHaveBeenCalledWith('uc-1', { agentId: 'dorkbot' });
    expect(result.current.data).toEqual({ binding });
  });

  it("passes bridge: true through for 'Answer in a channel'", async () => {
    const binding = {
      id: 'b-1',
      adapterId: 'telegram-1',
      agentId: 'dorkbot',
      bridge: 'room',
      roomId: 'room-1',
    };
    const transport = createMockTransport({
      claimUnclaimedChat: vi.fn().mockResolvedValue({ binding }),
    });

    const { result } = renderHook(() => useClaimUnclaimedChat(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'uc-1', input: { agentId: 'dorkbot', bridge: true } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.claimUnclaimedChat).toHaveBeenCalledWith('uc-1', {
      agentId: 'dorkbot',
      bridge: true,
    });
    expect(result.current.data).toEqual({ binding });
  });

  it('resolves with a bridgeError instead of rejecting when the bridge step fails', async () => {
    const binding = { id: 'b-1', adapterId: 'telegram-1', agentId: 'dorkbot', bridge: 'off' };
    const transport = createMockTransport({
      claimUnclaimedChat: vi.fn().mockResolvedValue({
        binding,
        bridgeError: 'This is a broadcast channel, not a two-way conversation',
      }),
    });

    const { result } = renderHook(() => useClaimUnclaimedChat(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'uc-1', input: { agentId: 'dorkbot', bridge: true } });

    // The claim itself is a success — the chat was answered (privately, as a
    // fallback), never left unclaimed by a bridge failure.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ binding, bridgeError: expect.any(String) });
  });

  it('surfaces a CHAT_ALREADY_BOUND refusal instead of swallowing it', async () => {
    const conflict = Object.assign(new Error('already bound'), {
      code: 'CHAT_ALREADY_BOUND',
      status: 409,
    });
    const transport = createMockTransport({
      claimUnclaimedChat: vi.fn().mockRejectedValue(conflict),
    });

    const { result } = renderHook(() => useClaimUnclaimedChat(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'uc-1', input: { agentId: 'dorkbot' } });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { code?: string })?.code).toBe('CHAT_ALREADY_BOUND');
  });

  it('ignore and block each take a bare row id', async () => {
    const transport = createMockTransport({
      ignoreUnclaimedChat: vi.fn().mockResolvedValue(undefined),
      blockUnclaimedChat: vi.fn().mockResolvedValue(undefined),
    });
    const wrapper = createWrapper(transport);

    const ignore = renderHook(() => useIgnoreUnclaimedChat(), { wrapper });
    ignore.result.current.mutate('uc-1');
    await waitFor(() => expect(ignore.result.current.isSuccess).toBe(true));
    expect(transport.ignoreUnclaimedChat).toHaveBeenCalledWith('uc-1');

    const block = renderHook(() => useBlockUnclaimedChat(), { wrapper });
    block.result.current.mutate('uc-2');
    await waitFor(() => expect(block.result.current.isSuccess).toBe(true));
    expect(transport.blockUnclaimedChat).toHaveBeenCalledWith('uc-2');
  });
});
