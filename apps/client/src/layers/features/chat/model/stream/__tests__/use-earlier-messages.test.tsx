/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { HistoryMessage, HistoryPage } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useHistoryWindowStore } from '@/layers/entities/session';
import { useEarlierMessages } from '../use-earlier-messages';
import type { ChatMessage } from '../../chat-types';

/**
 * The way back past a long conversation's opening window (DOR-2889): older
 * pages go in front of the transcript, a page is read with the oldest loaded
 * message as its cursor, and a link to an old message reads pages until it is
 * loaded.
 */

const history = (from: number, to: number): HistoryMessage[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `m${from + i}`,
    role: 'user' as const,
    content: `message ${from + i}`,
  }));
const chat = (from: number, to: number): ChatMessage[] =>
  history(from, to).map((m) => ({
    id: m.id,
    role: 'user',
    content: m.content,
    parts: [{ type: 'text', text: m.content }],
    timestamp: '',
  })) as ChatMessage[];

function setup(pages: Record<string, HistoryPage>) {
  const transport = createMockTransport();
  vi.mocked(transport.getMessages).mockImplementation(async (_id, _cwd, before) => {
    const page = before ? pages[before] : undefined;
    if (!page) throw new Error(`no page before ${before}`);
    return page;
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  return { transport, wrapper };
}

beforeEach(() => {
  useHistoryWindowStore.setState({ sessions: {}, seeks: {} });
});

describe('useEarlierMessages', () => {
  it('offers nothing for a conversation that opened whole', () => {
    const { wrapper } = setup({});
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm0', 0);
    const transcript = chat(0, 5);

    const { result } = renderHook(() => useEarlierMessages('s1', transcript), { wrapper });

    expect(result.current.canLoadEarlier).toBe(false);
    expect(result.current.messages).toBe(transcript);
  });

  it('reads the page before the oldest message and puts it in front', async () => {
    const { wrapper, transport } = setup({
      m200: { messages: history(100, 200), earlierMessages: 100 },
      m100: { messages: history(0, 100), earlierMessages: 0 },
    });
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm200', 200);
    const transcript = chat(200, 350);

    const { result } = renderHook(() => useEarlierMessages('s1', transcript), { wrapper });
    expect(result.current.canLoadEarlier).toBe(true);

    act(() => result.current.loadEarlier());
    await waitFor(() => expect(result.current.earlierCount).toBe(100));
    expect(transport.getMessages).toHaveBeenLastCalledWith('s1', undefined, 'm200');
    expect(result.current.messages[0]!.id).toBe('m100');
    expect(result.current.messages).toHaveLength(250);

    act(() => result.current.loadEarlier());
    await waitFor(() => expect(result.current.earlierCount).toBe(200));
    expect(transport.getMessages).toHaveBeenLastCalledWith('s1', undefined, 'm100');
    expect(result.current.canLoadEarlier).toBe(false);
  });

  it('steps aside once the transcript no longer starts at the window', async () => {
    const { wrapper } = setup({ m200: { messages: history(100, 200), earlierMessages: 100 } });
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm200', 200);
    let transcript = chat(200, 350);
    const { result, rerender } = renderHook(() => useEarlierMessages('s1', transcript), {
      wrapper,
    });
    act(() => result.current.loadEarlier());
    await waitFor(() => expect(result.current.earlierCount).toBe(100));

    // A whole-history reload replaced the window: it holds the older messages
    // itself, so the pages would only repeat them.
    transcript = chat(0, 351);
    rerender();

    expect(result.current.earlierCount).toBe(0);
    expect(result.current.canLoadEarlier).toBe(false);
    expect(result.current.messages).toBe(transcript);
  });

  it('drops a page that arrives after a new snapshot moved the window', async () => {
    let release: (page: HistoryPage) => void = () => {};
    const { wrapper, transport } = setup({});
    vi.mocked(transport.getMessages).mockImplementation(
      () => new Promise<HistoryPage>((resolve) => (release = resolve))
    );
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm200', 200);
    const transcript = chat(200, 350);
    const { result } = renderHook(() => useEarlierMessages('s1', transcript), { wrapper });

    act(() => result.current.loadEarlier());
    act(() => useHistoryWindowStore.getState().noteSnapshot('s1', 'm210', 210));
    await act(async () => release({ messages: history(100, 200), earlierMessages: 100 }));

    expect(useHistoryWindowStore.getState().sessions.s1!.earlier).toEqual([]);
  });

  it('reads pages until a linked message is loaded, then ends the seek', async () => {
    const { wrapper, transport } = setup({
      m200: { messages: history(100, 200), earlierMessages: 100 },
      m100: { messages: history(0, 100), earlierMessages: 0 },
    });
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm200', 200);
    useHistoryWindowStore.getState().seek('s1', 'm42');
    const transcript = chat(200, 350);

    const { result } = renderHook(() => useEarlierMessages('s1', transcript), { wrapper });

    await waitFor(() => expect(result.current.isSeeking).toBe(false));
    expect(transport.getMessages).toHaveBeenCalledTimes(2);
    expect(result.current.messages.some((m) => m.id === 'm42')).toBe(true);
  });

  it('ends a seek for a message no page holds once nothing remains', async () => {
    const { wrapper, transport } = setup({
      m200: { messages: history(0, 200), earlierMessages: 0 },
    });
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm200', 200);
    useHistoryWindowStore.getState().seek('s1', 'never-existed');
    const transcript = chat(200, 350);

    const { result } = renderHook(() => useEarlierMessages('s1', transcript), { wrapper });

    await waitFor(() => expect(result.current.isSeeking).toBe(false));
    expect(transport.getMessages).toHaveBeenCalledTimes(1);
  });
});
