/**
 * The one list every lens draws: rows in order, unread marked, a click that both
 * reads and travels, and paging that asks for the next cursor rather than the
 * whole history.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
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

/** Build a roster agent, overriding only what a test cares about. */
function buildAgent(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'alpha',
    name: 'alpha',
    displayName: 'Alpha Bot',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
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

describe('InboxList', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('draws a row per notification, with its second line', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ title: 'Nightly sweep failed', body: 'Failed after 2m 14s.' })],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    expect(await screen.findByText('Nightly sweep failed')).toBeInTheDocument();
    expect(screen.getByText('Failed after 2m 14s.')).toBeInTheDocument();
  });

  it('marks unread rows and leaves read ones unmarked', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({ id: 'a', title: 'still new' }),
          build({ id: 'b', title: 'already seen', readAt: new Date().toISOString() }),
        ],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    await screen.findByText('still new');
    const rows = document.querySelectorAll('[data-slot="inbox-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-unread', 'true');
    expect(rows[1]).toHaveAttribute('data-unread', 'false');
  });

  it('reads the row and opens the session behind it', async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a', subject: { type: 'session', id: 'ses-77' } })],
        nextCursor: null,
        unreadCount: 1,
      }),
      markNotificationRead,
    });

    await userEvent.click(await screen.findByText('alpha finished'));

    expect(markNotificationRead).toHaveBeenCalledWith('a');
    expect(navigate).toHaveBeenCalledWith({ to: '/session', search: { session: 'ses-77' } });
  });

  it('keeps the failed-run deep link that predates the Inbox', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({
            id: 'r',
            kind: 'run.completed',
            tier: 'notable',
            subject: { type: 'run', id: 'run-4412' },
            title: 'Nightly sweep failed',
          }),
        ],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    await userEvent.click(await screen.findByText('Nightly sweep failed'));

    // The same URL people have been pasting to each other since before this
    // list existed, and it still opens the same sheet.
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { detail: 'failed-run', itemId: 'run-4412' },
    });
  });

  it('keeps the offline-agent deep link too', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({
            id: 'u',
            kind: 'agent.unreachable',
            tier: 'quiet',
            subject: { type: 'agent', id: 'tangerines' },
            title: 'tangerines stopped answering',
          }),
        ],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    await userEvent.click(await screen.findByText('tangerines stopped answering'));

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { detail: 'offline-agent', itemId: 'tangerines' },
    });
  });

  it('draws a row with nowhere to go as text, not a button pretending to travel', async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({
            id: 'v',
            kind: 'update.installed',
            tier: 'quiet',
            subject: { type: 'system', id: '0.61.0' },
            title: 'DorkOS updated to 0.61.0',
            agentId: undefined,
          }),
        ],
        nextCursor: null,
        unreadCount: 1,
      }),
      markNotificationRead,
    });

    await screen.findByText('DorkOS updated to 0.61.0');

    // No button affordance — InboxRow's non-interactive branch, not a
    // full-width control that visibly does nothing but clear a dot.
    expect(screen.queryByRole('button', { name: /DorkOS updated/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('DorkOS updated to 0.61.0'));

    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not re-mark a row that was already read', async () => {
    const markNotificationRead = vi.fn();
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a', readAt: new Date().toISOString() })],
        nextCursor: null,
        unreadCount: 0,
      }),
      markNotificationRead,
    });

    await userEvent.click(await screen.findByText('alpha finished'));

    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it('filters by agent when given an agent lens', async () => {
    // The agent profile's Notifications section is exactly this call.
    const listNotifications = vi
      .fn()
      .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 0 });
    renderList(<InboxList lens={{ agentId: 'tangerines' }} />, { listNotifications });

    await waitFor(() =>
      expect(listNotifications).toHaveBeenCalledWith({ limit: 25, agentId: 'tangerines' })
    );
  });

  it('offers Load more only while there is another page, and asks for the cursor', async () => {
    const listNotifications = vi
      .fn()
      .mockResolvedValueOnce({
        notifications: [build({ id: 'a' })],
        nextCursor: 'a',
        unreadCount: 1,
      })
      .mockResolvedValueOnce({
        notifications: [build({ id: 'b', title: 'older one' })],
        nextCursor: null,
        unreadCount: 1,
      });
    renderList(<InboxList />, { listNotifications });

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('older one')).toBeInTheDocument();
    expect(listNotifications).toHaveBeenLastCalledWith({ limit: 25, before: 'a' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    );
  });

  it('says what a lens is empty of, in the words its host chose', async () => {
    renderList(<InboxList emptyLabel="tangerines has not told you anything yet." />, {
      listNotifications: vi
        .fn()
        .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 0 }),
    });

    expect(
      await screen.findByText('tangerines has not told you anything yet.')
    ).toBeInTheDocument();
  });

  it('says so when the list cannot be read, rather than looking empty', async () => {
    // An empty list reads as "nothing has happened", which is the most
    // reassuring thing this surface can say. A failed read must not borrow it.
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockRejectedValue(new Error('offline')),
    });

    expect(
      await screen.findByText('DorkOS could not read your notifications.')
    ).toBeInTheDocument();
  });

  it('tells its host once a row has been opened', async () => {
    const onOpened = vi.fn();
    renderList(<InboxList onOpened={onOpened} />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a' })],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    await userEvent.click(await screen.findByText('alpha finished'));

    // The popover closes on this; a page passes nothing and stays put.
    expect(onOpened).toHaveBeenCalledTimes(1);
  });
});

describe('InboxList burst coalescing', () => {
  it('collapses three consecutive same-agent, same-kind rows into one group', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({ id: 'a', kind: 'run.completed', tier: 'quiet', title: 'run a finished' }),
          build({ id: 'b', kind: 'run.completed', tier: 'quiet', title: 'run b finished' }),
          build({ id: 'c', kind: 'run.completed', tier: 'quiet', title: 'run c finished' }),
        ],
        nextCursor: null,
        unreadCount: 0,
      }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [buildAgent()] }),
    });

    expect(await screen.findByText('Alpha Bot finished 3 runs')).toBeInTheDocument();
    expect(screen.queryByText('run a finished')).not.toBeInTheDocument();
  });

  it('leaves two consecutive same-agent, same-kind rows as individual rows — below the threshold', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({ id: 'a', kind: 'run.completed', tier: 'quiet', title: 'run a finished' }),
          build({ id: 'b', kind: 'run.completed', tier: 'quiet', title: 'run b finished' }),
        ],
        nextCursor: null,
        unreadCount: 0,
      }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [buildAgent()] }),
    });

    expect(await screen.findByText('run a finished')).toBeInTheDocument();
    expect(screen.getByText('run b finished')).toBeInTheDocument();
    expect(screen.queryByText(/finished 2 runs/)).not.toBeInTheDocument();
  });

  it('expanding a group reveals its members and marks nothing read', async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({ id: 'a', kind: 'run.completed', tier: 'quiet', title: 'run a finished' }),
          build({ id: 'b', kind: 'run.completed', tier: 'quiet', title: 'run b finished' }),
          build({ id: 'c', kind: 'run.completed', tier: 'quiet', title: 'run c finished' }),
        ],
        nextCursor: null,
        unreadCount: 0,
      }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [buildAgent()] }),
      markNotificationRead,
    });

    await userEvent.click(await screen.findByText('Alpha Bot finished 3 runs'));

    expect(await screen.findByText('run a finished')).toBeInTheDocument();
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it('still opens an individual member row normally once expanded', async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [
          build({
            id: 'a',
            kind: 'run.completed',
            tier: 'quiet',
            title: 'run a finished',
            subject: { type: 'run', id: 'run-a' },
          }),
          build({
            id: 'b',
            kind: 'run.completed',
            tier: 'quiet',
            title: 'run b finished',
            subject: { type: 'run', id: 'run-b' },
          }),
          build({
            id: 'c',
            kind: 'run.completed',
            tier: 'quiet',
            title: 'run c finished',
            subject: { type: 'run', id: 'run-c' },
          }),
        ],
        nextCursor: null,
        unreadCount: 0,
      }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [buildAgent()] }),
      markNotificationRead,
    });

    await userEvent.click(await screen.findByText('Alpha Bot finished 3 runs'));
    await userEvent.click(await screen.findByText('run b finished'));

    expect(markNotificationRead).toHaveBeenCalledWith('b');
    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { detail: 'failed-run', itemId: 'run-b' },
    });
  });
});

describe('InboxList faces', () => {
  it('draws the resolved agent face on a row', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a', kind: 'run.completed', tier: 'quiet' })],
        nextCursor: null,
        unreadCount: 0,
      }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [buildAgent()] }),
    });

    await screen.findByText('alpha finished');
    expect(document.querySelector('[data-slot="agent-avatar"]')).toBeInTheDocument();
  });

  it('falls back to the kind glyph when the roster does not know the agent', async () => {
    renderList(<InboxList />, {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a', kind: 'run.completed', tier: 'quiet' })],
        nextCursor: null,
        unreadCount: 0,
      }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
    });

    await screen.findByText('alpha finished');
    expect(document.querySelector('[data-slot="agent-avatar"]')).not.toBeInTheDocument();
  });
});
