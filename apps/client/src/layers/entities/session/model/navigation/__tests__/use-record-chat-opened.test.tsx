/**
 * The chat page records every chat it shows as opened by you (spec
 * `your-activity-first` D3) — so opening by deep link counts as touched.
 *
 * @module entities/session/model/navigation/__tests__/use-record-chat-opened
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { useInteractionStore } from '@/layers/entities/interactions';
import { TransportProvider } from '@/layers/shared/model';
import { setSessionRouteContext } from '../session-route-context';
import { useRecordChatOpened } from '../use-record-chat-opened';

let transport: Transport;

function wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={transport}>{children}</TransportProvider>;
}

beforeEach(() => {
  transport = createMockTransport();
  useInteractionStore.setState({ opened: {}, counts: {} });
});
afterEach(() => cleanup());

describe('useRecordChatOpened', () => {
  it('opening by deep link counts as touched: it records on mount, with no click', () => {
    // Nothing but the id from the URL — the shape of a deep link, a reload or
    // a notification. No click handler ran.
    renderHook(() => useRecordChatOpened('chat-from-link'), { wrapper });

    expect(transport.markSessionOpened).toHaveBeenCalledTimes(1);
    expect(transport.markSessionOpened).toHaveBeenCalledWith('chat-from-link');
    expect(useInteractionStore.getState().opened['session:chat-from-link']).toBeDefined();
  });

  it('records again each time the shown chat changes, and not on a plain re-render', () => {
    const { rerender } = renderHook(({ id }) => useRecordChatOpened(id), {
      wrapper,
      initialProps: { id: 'first' },
    });
    rerender({ id: 'first' });
    rerender({ id: 'second' });

    expect(vi.mocked(transport.markSessionOpened).mock.calls).toEqual([['first'], ['second']]);
  });

  it('records nothing when no chat is shown', () => {
    renderHook(() => useRecordChatOpened(null), { wrapper });
    expect(transport.markSessionOpened).not.toHaveBeenCalled();
  });

  it('skips a fresh chat that does not exist yet', () => {
    setSessionRouteContext('minted', { cwd: '/agents/a', draft: true });
    renderHook(() => useRecordChatOpened('minted'), { wrapper });
    expect(transport.markSessionOpened).not.toHaveBeenCalled();
    expect(useInteractionStore.getState().opened['session:minted']).toBeUndefined();
  });

  it('reports a failed record instead of throwing or toasting', async () => {
    vi.mocked(transport.markSessionOpened).mockRejectedValueOnce(new Error('offline'));
    renderHook(() => useRecordChatOpened('chat'), { wrapper });
    await waitFor(() => expect(transport.reportError).toHaveBeenCalled());
  });

  it('waits until the page is visible, then records once for the chat it shows', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      renderHook(() => useRecordChatOpened('background'), { wrapper });
      expect(transport.markSessionOpened).not.toHaveBeenCalled();
      expect(useInteractionStore.getState().opened['session:background']).toBeUndefined();

      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));

      expect(vi.mocked(transport.markSessionOpened).mock.calls).toEqual([['background']]);
      expect(useInteractionStore.getState().opened['session:background']).toBeDefined();
    } finally {
      visibility.mockRestore();
    }
  });
});

describe('useRecordChatOpened — the chat the app landed on (BC-22)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.resetModules();
  });

  /** Load the hook and the store fresh, as a page load that began on `url`. */
  async function loadAt(url: string) {
    window.history.replaceState(null, '', url);
    vi.resetModules();
    const hook = await import('../use-record-chat-opened');
    const interactions = await import('@/layers/entities/interactions');
    const model = await import('@/layers/shared/model');
    interactions.useInteractionStore.setState({ opened: {}, counts: {} });
    const freshWrapper = ({ children }: { children: ReactNode }) => (
      <model.TransportProvider transport={transport}>{children}</model.TransportProvider>
    );
    return { ...hook, ...interactions, freshWrapper };
  }

  it('tells the server about the landed chat but leaves the local record alone', async () => {
    const {
      useRecordChatOpened: record,
      useInteractionStore: store,
      freshWrapper,
    } = await loadAt('/session?session=landed');
    renderHook(() => record('landed'), { wrapper: freshWrapper });

    expect(transport.markSessionOpened).toHaveBeenCalledWith('landed');
    expect(store.getState().opened['session:landed']).toBeUndefined();
  });

  it('records locally once you go to another chat, and when you come back', async () => {
    const {
      useRecordChatOpened: record,
      useInteractionStore: store,
      freshWrapper,
    } = await loadAt('/session?session=landed');
    const { rerender } = renderHook(({ id }) => record(id), {
      wrapper: freshWrapper,
      initialProps: { id: 'landed' },
    });
    rerender({ id: 'next' });
    rerender({ id: 'landed' });

    expect(store.getState().opened['session:next']).toBeDefined();
    expect(store.getState().opened['session:landed']).toBeDefined();
  });

  it('records the first chat locally when the app was entered somewhere else', async () => {
    const {
      useRecordChatOpened: record,
      useInteractionStore: store,
      freshWrapper,
    } = await loadAt('/');
    renderHook(() => record('clicked'), { wrapper: freshWrapper });
    expect(store.getState().opened['session:clicked']).toBeDefined();
  });
});
