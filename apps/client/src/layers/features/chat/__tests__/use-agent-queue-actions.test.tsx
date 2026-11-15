// @vitest-environment jsdom
/**
 * Send now and Don't deliver on another agent's queued message (DOR-3060),
 * through a mock Transport.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  notDeliveredLine,
  sendNowNotice,
  useAgentQueueActions,
} from '../model/messaging/use-agent-queue-actions';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const SESSION_ID = 'chat-1';

function mount() {
  const transport = createMockTransport();
  const view = renderHook(() => useAgentQueueActions(SESSION_ID), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    ),
  });
  return { transport, view };
}

beforeEach(() => {
  vi.mocked(toast).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe('useAgentQueueActions', () => {
  it('sends it now, with nothing to say when it joined the turn', async () => {
    const { transport, view } = mount();
    act(() => view.result.current.sendNow('row-1'));
    await waitFor(() =>
      expect(transport.steerQueuedChatMessage).toHaveBeenCalledWith(SESSION_ID, 'row-1')
    );
    expect(view.result.current.notices).toEqual({});
  });

  it('says it sends next when it could only move to the front', async () => {
    const { transport, view } = mount();
    vi.mocked(transport.steerQueuedChatMessage).mockResolvedValueOnce({
      outcome: 'moved-to-front',
      reason: 'steer-not-allowed',
    });
    act(() => view.result.current.sendNow('row-1'));
    await waitFor(() =>
      expect(view.result.current.notices['row-1']).toBe(
        'Sends next. This agent can’t take it mid-turn.'
      )
    );
  });

  it('takes it off the queue and says the sender’s chat shows it', async () => {
    const { transport, view } = mount();
    act(() => view.result.current.dontDeliver('row-1', 'Security'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Not delivered. Security’s chat shows it.')
    );
    expect(transport.removeQueuedMessage).toHaveBeenCalledWith(SESSION_ID, 'row-1');
  });

  it('stays quiet when the message already left the queue', async () => {
    const { transport, view } = mount();
    vi.mocked(transport.removeQueuedMessage).mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'QUEUED_MESSAGE_NOT_FOUND' })
    );
    act(() => view.result.current.dontDeliver('row-1', 'Security'));
    await waitFor(() => expect(transport.removeQueuedMessage).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Don’t deliver while Send now carries it', () => {
  it('says it is already on its way, not that something failed', async () => {
    const { transport, view } = mount();
    vi.mocked(transport.removeQueuedMessage).mockRejectedValueOnce(
      Object.assign(new Error('starting'), { code: 'QUEUED_MESSAGE_LAUNCHING' })
    );
    act(() => view.result.current.dontDeliver('row-1', 'Security'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('It’s already on its way.'));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the copy', () => {
  it('words each Send now outcome and the removal', () => {
    expect(sendNowNotice({ outcome: 'steered' })).toBeNull();
    expect(sendNowNotice({ outcome: 'moved-to-front', reason: 'no-running-turn' })).toBe(
      'Sends next.'
    );
    expect(sendNowNotice({ outcome: 'moved-to-front', reason: 'steer-did-not-land' })).toBe(
      'Sends next. This agent can’t take it mid-turn.'
    );
    expect(notDeliveredLine('Security')).toBe('Not delivered. Security’s chat shows it.');
  });
});
