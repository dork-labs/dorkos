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
});
