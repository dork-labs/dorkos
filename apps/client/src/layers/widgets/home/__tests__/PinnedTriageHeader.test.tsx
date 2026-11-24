/**
 * The pinned triage header: what it draws, what it refuses to draw, and what a decision answered
 * inside it does to the page around it (spec `team-room-home` D3.3). @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { Session, Task } from '@dorkos/shared/types';
import type {
  ListNotificationsResponse,
  NotificationDTO,
} from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';

/**
 * The viewport, as a box a test can set. jsdom has no media queries worth asking, and the
 * condense rule turns on the answer.
 */
const { viewport } = vi.hoisted(() => ({ viewport: { mobile: false } }));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useIsMobile: () => viewport.mobile };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { usePendingApprovals } from '@/layers/entities/attention';
import { useSessionListStore } from '@/layers/entities/session';
import {
  discardPendingRejections,
  discardSettlingSchedules,
} from '@/layers/features/schedule-approval';
import { discardSettlingApprovals } from '@/layers/features/approvals';
import { PinnedTriageHeader } from '../ui/PinnedTriageHeader';
import { type TriagePresenceSlot } from '../ui/PinnedTriageHeaderView';

/** The header element itself, or `null` when it drew nothing at all. */
function header(): HTMLElement | null {
  return document.querySelector('[data-slot="pinned-triage-header"]');
}

/** The condensed one-line bar, or `null` when the header is drawing in full. */
function summaryBar(): HTMLElement | null {
  return document.querySelector('[data-slot="pinned-triage-summary"]');
}

/** What the header is currently saying to a screen reader. */
function announcement(): string {
  return document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '';
}

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    answerNeedsStepUp: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8.5 * 60_000).toISOString(),
    ...overrides,
  };
}

/**
 * Frozen at module load rather than read per call, so every row in one run is the same age and a
 * suite that takes a minute cannot have its first fixture age differently from its last.
 */
const LOADED_AT = Date.now();

/** One minute, in milliseconds. */
const MINUTE_MS = 60_000;

/** An Inbox page holding one "agent stopped answering" row per name. */
function offlineAgents(...names: string[]) {
  return {
    notifications: names.map((name, i) => ({
      id: `01JZH000000000000000000${i}`,
      kind: 'agent.unreachable' as const,
      tier: 'quiet' as const,
      subject: { type: 'agent' as const, id: name },
      agentId: name,
      title: `${name} stopped answering`,
      // RELATIVE, never a literal date.
      createdAt: new Date(LOADED_AT - MINUTE_MS).toISOString(),
    })),
    nextCursor: null,
    unreadCount: names.length,
  };
}

/** The one unread `report.daily` row this file seeds, overriding only what a test cares about. */
function shiftReportRow(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZR000000000000000000S1',
    kind: 'report.daily',
    tier: 'quiet',
    subject: { type: 'system', id: '2026-08-19' },
    title: 'While you were away: 3 runs finished, 1 run needs a look',
    body: '3 runs finished. 1 run needs a look.',
    createdAt: new Date(LOADED_AT - MINUTE_MS).toISOString(),
    ...overrides,
  };
}

/** `listNotifications`, split by which lens is asking. */
function notificationsByLens(
  options: { activity?: ListNotificationsResponse; report?: NotificationDTO[] } = {}
) {
  const empty: ListNotificationsResponse = { notifications: [], nextCursor: null, unreadCount: 0 };
  return vi
    .fn()
    .mockImplementation((query?: { kind?: string[] }): Promise<ListNotificationsResponse> =>
      query?.kind?.includes('report.daily')
        ? Promise.resolve({
            notifications: options.report ?? [],
            nextCursor: null,
            unreadCount: options.report?.length ?? 0,
          })
        : Promise.resolve(options.activity ?? empty)
    );
}

/** A schedule an agent proposed and parked, waiting on a yes or a no. */
function parkedSchedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    approvalRevision: 'a'.repeat(64),
    name: 'nightly-sweep',
    displayName: 'Nightly sweep',
    description: null,
    prompt: 'Sweep the backlog.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    defaultCron: '0 3 * * *',
    defaultTimezone: 'UTC',
    timingOverridden: false,
    packageOwned: null,
    approvalChanges: [],
    agentId: null,
    // True: this fixture stands in for a schedule an AGENT proposed, which is asking to run by
    // definition (DOR-2059 only quiets a package-shipped schedule that ships switched off).
    enabled: true,
    sticky: false,
    maxRuntime: null,
    permissionMode: 'default',
    runtime: null,
    model: null,
    effort: null,
    account: null,
    status: 'pending_approval',
    approvedAt: null,
    approvedBy: null,
    approvedVia: null,
    filePath: '/tmp/nightly-sweep/SKILL.md',
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    reasonSource: null,
    nextRuns: [],
    ...overrides,
  };
}

/** A session row as the recent-sessions read answers with it. */
function sessionRow(id: string, title: string): Session {
  return {
    id,
    title,
    cwd: '/projects/alpha',
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
  };
}

/** Tell the global session store what each session is doing. */
function setLifecycles(entries: Record<string, 'blocked' | 'error'>) {
  act(() => {
    for (const [id, lifecycle] of Object.entries(entries)) {
      useSessionListStore.getState().setSessionStatus(id, { lifecycle } as never);
    }
  });
}

/** How many approvals the SERVER currently reports, drawn beside the header. */
function PendingApprovalsProbe() {
  const { approvals } = usePendingApprovals();
  return <span data-testid="pending-approvals">{`pending:${approvals.length}`}</span>;
}

/**
 * Render the header inside a router, because the attention rows navigate and the detail sheets
 * read the URL they navigate to.
 */
function renderHeader(
  overrides: Partial<Transport> = {},
  props: {
    presence?: TriagePresenceSlot;
    composerFocused?: boolean;
    onExpand?: () => void;
  } = {}
) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => (
      <>
        <PendingApprovalsProbe />
        <PinnedTriageHeader {...props} />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {/* The test tree is not the app's registered router; the cast is only so
            the provider's generic accepts it. */}
        <RouterProvider router={router as never} />
      </TransportProvider>
    </QueryClientProvider>
  );

  return { transport, router };
}

// The session store is a module singleton, so a lifecycle one case seeds would otherwise still be
// there for the next one.
beforeEach(() => {
  useSessionListStore.getState().resetStatuses();
});

/**
 * Getting out of the keyboard's way (spec task 2.7's browser gate). jsdom cannot measure a
 * software keyboard, so what is pinned here is the STATE MACHINE — when the header condenses,
 * what the line says, and what tapping it asks the host to do.
 */
describe('PinnedTriageHeader while the composer has the caret', () => {
  beforeEach(() => {
    vi.mocked(useEventSubscription).mockImplementation(() => {});
    viewport.mobile = true;
  });

  afterEach(() => {
    cleanup();
    discardPendingRejections();
    discardSettlingSchedules();
    discardSettlingApprovals();
    viewport.mobile = false;
    vi.clearAllMocks();
  });

  it('condenses to one line of counts on a phone', async () => {
    renderHeader(
      {
        listPendingApprovals: vi.fn().mockResolvedValue({
          approvals: [
            buildApproval({ approvalId: '01JZ0000000000000000000001' }),
            buildApproval({ approvalId: '01JZ0000000000000000000002' }),
          ],
        }),
        listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
      },
      { composerFocused: true }
    );

    expect(await screen.findByText('2 waiting · 1 needs attention')).toBeInTheDocument();
    expect(summaryBar()).not.toBeNull();
    // The cards are gone, not merely shorter: that is the point — every pixel they were taking
    // goes back to the box being typed in.
    expect(header()).toBeNull();
    expect(document.querySelector('[data-slot="approval-card"]')).toBeNull();
  });

  it('asks the host to give the caret back when the line is tapped', async () => {
    // The header cannot dismiss the keyboard itself; the composer holding it is a sibling.
    const onExpand = vi.fn();
    renderHeader(
      { listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }) },
      { composerFocused: true, onExpand }
    );

    await userEvent.click(await screen.findByRole('button', { name: /1 waiting/ }));

    expect(onExpand).toHaveBeenCalledOnce();
  });
});

describe('PinnedTriageHeader', () => {
  beforeEach(() => {
    vi.mocked(useEventSubscription).mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level on purpose (it has to survive the popover unmounting), so
    // `cleanup()` does not end it — a rejection left pending here would fire its DELETE in the
    // middle of a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    discardSettlingApprovals();
    vi.clearAllMocks();
  });

  it('draws nothing at all when nothing is waiting and nothing is wrong', async () => {
    const { transport } = renderHeader();

    // Wait for the reads to land: asserting absence before they resolve would pass against a
    // header that simply had not been told anything yet.
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());

    expect(header()).toBeNull();
    expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
    // The live region stays — always mounted, and silent.
    expect(announcement()).toBe('');
  });

  it('announces what arrived, by count rather than by card', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [
          buildApproval({ approvalId: '01JZ0000000000000000000001' }),
          buildApproval({ approvalId: '01JZ0000000000000000000002' }),
        ],
      }),
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    await waitFor(() =>
      expect(announcement()).toBe('2 requests are waiting on you. 1 thing needs attention.')
    );
  });

  it('answers an approval in place: the card retires, the header shrinks, the page stays put', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    // Held open on purpose.
    let settle: () => void = () => {};
    const grantApproval = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () =>
            resolve({ ok: true, approvalId: '01JZ0000000000000000000001', outcome: 'granted' });
        })
    );
    const { router } = renderHeader({ listPendingApprovals, grantApproval });

    await screen.findByText('Uninstall a marketplace package');

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(grantApproval).toHaveBeenCalledWith('01JZ0000000000000000000001', undefined);
    // Confirmed on the card while the request is still in flight.
    expect(await screen.findByText('Allowed once')).toBeInTheDocument();

    listPendingApprovals.mockResolvedValue({ approvals: [] });
    settle();
    // The card outlives the refetch by its receipt's hold now (DOR-1411), so the retirement is a
    // beat later than the drain rather than in the same frame — hence the longer window than
    // `waitFor`'s one-second default.
    await waitFor(() => expect(document.querySelector('[data-slot="approval-card"]')).toBeNull(), {
      timeout: 4_000,
    });
    // The last thing waiting was answered, so the header goes with it.
    await waitFor(() => expect(header()).toBeNull());
    // Answering is not navigating: the feed underneath must not move.
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows what recently went wrong, under its own quiet heading', async () => {
    // Agents nobody can reach is not a thing WAITING on a person — nothing is blocked on an
    // answer — so it draws under Recent activity rather than spending the header's amber on it.
    renderHeader({
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    expect(await screen.findByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('tangerines stopped answering')).toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('keeps the activity row deep link, and opens the sheet it addresses', async () => {
    const { router } = renderHeader({
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    // The row IS the button now — clicking it marks the notification read and travels, where the
    // old row carried a separate "View →".
    await userEvent.click(await screen.findByText('tangerines stopped answering'));

    await waitFor(() =>
      expect(router.state.location.search).toEqual(
        expect.objectContaining({ detail: 'offline-agent', itemId: 'tangerines' })
      )
    );
    expect(await screen.findByText('Agents that aren’t answering')).toBeInTheDocument();
  });

  it('approves a parked schedule in place', async () => {
    const updateTask = vi.fn().mockResolvedValue(parkedSchedule({ status: 'active' }));
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]), updateTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    // A yes identifies the reviewed work. Without a revision the real card must stay blocked.
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'active',
        expectedApprovalRevision: 'a'.repeat(64),
        approvalSurface: 'home',
      })
    );
  });

  it('rejects a parked schedule into a receipt, sending no delete yet', async () => {
    // Rejecting DELETES a schedule, and a delete has no server-side undo — so the card offers the
    // undo by simply not sending the request yet.
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]), deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));

    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('draws an agent waiting on you ONCE — the card, never a second row below it', async () => {
    // Both sessions raise a signal from the one engine: `blocked` becomes a permission prompt,
    // `error` becomes a wedge.
    renderHeader({
      listRecentSessions: vi.fn().mockResolvedValue({
        sessions: [
          sessionRow('ses-blocked', 'Ship the parser'),
          sessionRow('ses-wedged', 'Wedged'),
        ],
        agentActivity: {},
      }),
    });
    setLifecycles({ 'ses-blocked': 'blocked', 'ses-wedged': 'error' });

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="attention-signal-row"]')).toHaveLength(1)
    );
    expect(document.querySelector('[data-slot="attention-signal-row"]')?.textContent).toContain(
      'Stopped with an error'
    );
  });

  describe('the daily Shift Report card', () => {
    it('dismissing the card marks it read, and it disappears', async () => {
      const markNotificationRead = vi
        .fn()
        .mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
      renderHeader({
        listNotifications: notificationsByLens({ report: [shiftReportRow()] }),
        markNotificationRead,
      });

      await screen.findByText(/While you were away/);
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

      expect(markNotificationRead).toHaveBeenCalledWith(shiftReportRow().id);
      // The optimistic cache write is what makes it vanish — the mock above still answers the
      // same unread row if re-fetched, so a card that survives this proves the dismiss reads it
      // rather than merely calling the mutation.
      await waitFor(() =>
        expect(screen.queryByText(/While you were away/)).not.toBeInTheDocument()
      );
    });
  });

  it('puts the answers back when a rejection is undone', async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]), deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    // Answerable again, and still nothing sent — an undo that left the card
    // saying "Rejected" would be a button that did nothing.
    expect(await screen.findByRole('button', { name: 'Reject Nightly sweep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });
});
