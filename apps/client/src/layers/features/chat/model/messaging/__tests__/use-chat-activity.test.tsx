/**
 * @vitest-environment jsdom
 *
 * A chat's messaging read (spec `spin-off-chats` §6): the last answer stands
 * in while a new version lands, but never another chat's.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatActivityResponse } from '@dorkos/shared/chat-messages';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionStreamStore } from '@/layers/entities/session';
import { useChatActivity } from '../use-chat-activity';

const A_SENT: ChatActivityResponse = {
  sent: [
    {
      id: 'cm-a',
      kind: 'message',
      to: { chatId: 'chat-x' },
      text: 'From chat A.',
      delivery: 'queue',
      status: 'queued',
      sentAt: '2026-10-09T10:00:00.000Z',
    },
  ],
  stops: [],
};

function harness(getChatActivity: (id: string) => Promise<ChatActivityResponse>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport({ getChatActivity: vi.fn(getChatActivity) });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return wrapper;
}

describe('useChatActivity', () => {
  it('never shows one chat’s Sent cards in another chat while its read lands', async () => {
    const wrapper = harness((id) =>
      id === 'chat-a' ? Promise.resolve(A_SENT) : new Promise<ChatActivityResponse>(() => {})
    );
    const { result, rerender } = renderHook(({ id }) => useChatActivity(id), {
      wrapper,
      initialProps: { id: 'chat-a' },
    });
    await waitFor(() => expect(result.current.sent).toHaveLength(1));
    rerender({ id: 'chat-b' });
    expect(result.current.sent).toEqual([]);
  });

  it('keeps the same chat’s last answer on screen while a new version lands', async () => {
    let calls = 0;
    const wrapper = harness(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(A_SENT) : new Promise<ChatActivityResponse>(() => {});
    });
    const { result } = renderHook(() => useChatActivity('chat-a'), { wrapper });
    await waitFor(() => expect(result.current.sent).toHaveLength(1));
    useSessionStreamStore.getState().applyEvent('chat-a', { type: 'chat_activity', seq: 1 });
    await waitFor(() => expect(calls).toBe(2));
    expect(result.current.sent).toHaveLength(1);
  });
});
