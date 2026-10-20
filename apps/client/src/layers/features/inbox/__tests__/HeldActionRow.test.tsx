/**
 * A held connected-app action in the Inbox (spec `trusted-by-default-flip`
 * §5.6): its waiting row offers Cancel, which reaches the server, until a later
 * row says the hold ended or its 60 seconds are up.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';

const navigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useSafeNavigate: () => navigate };
});

import { TransportProvider } from '@/layers/shared/model';
import { InboxList } from '../ui/InboxList';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZG0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-1' },
    sessionId: 'ses-1',
    agentId: 'alpha',
    title: 'alpha finished',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The waiting row the server writes when an agent's action is held. */
function waiting(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return build({
    id: 'w',
    kind: 'connector.destructive_pending',
    subject: { type: 'system', id: 'hold-1' },
    title: 'Scout will run “Delete message” in Gmail',
    body: 'Runs in 60 seconds unless someone cancels.',
    actions: [
      { id: 'cancel', label: 'Cancel', style: 'danger' },
      { id: 'open', label: 'Open', style: 'primary' },
    ],
    ...overrides,
  });
}

/** Render the list over a mock transport. */
function renderList(node: ReactNode, overrides: Partial<Transport> = {}) {
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
  return { transport, ...render(node, { wrapper: Wrapper }) };
}

describe('a held action in the Inbox', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function list(notifications: NotificationDTO[]) {
    return vi.fn().mockResolvedValue({ notifications, nextCursor: null, unreadCount: 1 });
  }

  it('cancels the hold through the server, and says so', async () => {
    const cancelHeldConnectorAction = vi
      .fn()
      .mockResolvedValue({ status: 'cancelled', holdId: 'hold-1' });
    renderList(<InboxList />, {
      listNotifications: list([waiting()]),
      cancelHeldConnectorAction,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(cancelHeldConnectorAction).toHaveBeenCalledWith('hold-1');
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('says it is too late when the action already ran', async () => {
    const cancelHeldConnectorAction = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    renderList(<InboxList />, {
      listNotifications: list([waiting()]),
      cancelHeldConnectorAction,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Too late to cancel')).toBeInTheDocument();
  });

  it('offers no Cancel once a later row says the hold ended', async () => {
    renderList(<InboxList />, {
      listNotifications: list([
        build({
          id: 'x',
          kind: 'connector.destructive_executed',
          subject: { type: 'system', id: 'hold-1' },
          title: 'Scout ran “Delete message” in Gmail',
          actions: [{ id: 'open', label: 'Open', style: 'primary' }],
        }),
        waiting(),
      ]),
    });

    await screen.findByText('Scout ran “Delete message” in Gmail');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('keeps Cancel for a full minute from when it arrived, whatever the client clock says', async () => {
    // A client clock running a minute fast reads a fresh row as already
    // past its 60 seconds. Cancel stays anyway, counted from arrival.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderList(<InboxList />, {
        listNotifications: list([
          waiting({ createdAt: new Date(Date.now() - 61_000).toISOString() }),
        ]),
      });
      expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rings the hold a link asked for and puts focus on its Cancel', async () => {
    renderList(<InboxList focusId="hold-1" />, { listNotifications: list([waiting()]) });

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    expect(document.querySelector('[data-slot="held-action-row"]')).toHaveAttribute(
      'data-focused',
      'true'
    );
  });
});
