// @vitest-environment jsdom
/**
 * The Inbox bell: it appears the moment an agent asks, from any route; it retires when the
 * request is decided or its window closes; it reads a count for a queue and a different, neutral
 * one for unread history; and it can be reached and opened from the keyboard alone.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectionState, Task } from '@dorkos/shared/types';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';

/** Global stream state the widget reads; mutable so a test can drop the link. */
let mockConnectionState: ConnectionState = 'connected';

/**
 * Whether `useIsMobile` reports the phone breakpoint; mutable so a test can drive the popover
 * into its Drawer (bottom sheet) branch instead of the default desktop Popover the rest of this
 * suite renders.
 */
const mockIsMobile = false;

/**
 * The router this suite does not mount.
 */
const mockNavigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
    useEventStream: () => ({
      subscribe: vi.fn(),
      connectionState: mockConnectionState,
      failedAttempts: 0,
    }),
    useSafeNavigate: () => mockNavigate,
    useIsMobile: () => mockIsMobile,
  };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { usePendingApprovals } from '@/layers/entities/attention';
import { useNotifications } from '@/layers/entities/notifications';
import { useConfig } from '@/layers/entities/config';
import { clearInboxRequest } from '@/layers/entities/notifications';
import {
  discardPendingRejections,
  discardSettlingSchedules,
} from '@/layers/features/schedule-approval';
import { discardSettlingApprovals } from '@/layers/features/approvals';
import { InboxBell } from '../ui/InboxBell';

/**
 * Renders the state the marker is derived from, so a test can wait for the reads to have LANDED
 * before asserting the marker is absent.
 */
function SettledProbe() {
  const { data: config } = useConfig();
  const { approvals, isLoading } = usePendingApprovals();
  const { isLoading: inboxLoading } = useNotifications();
  return (
    <>
      <span data-testid="settled">
        {`${config ? 'cfg' : 'nocfg'}:${isLoading ? 'loading' : 'loaded'}:${
          inboxLoading ? 'inbox-loading' : 'inbox-loaded'
        }`}
      </span>
      {/* How many approvals the SERVER currently reports. The settling test
          needs to know the refetch has LANDED, not merely that it was asked
          for — `toHaveBeenCalledTimes` fires when the fetch starts, before the
          cache is rewritten and long before the popover re-renders off it. */}
      <span data-testid="pending-approvals">{`pending:${approvals.length}`}</span>
    </>
  );
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
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Build a schedule an agent proposed and parked. */
function parkedSchedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
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
    approvalRevision: 'a'.repeat(64),
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

/** Render the marker over a mock transport. */
function renderIndicator(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return {
    transport,
    ...render(
      <>
        <SettledProbe />
        <InboxBell />
      </>,
      { wrapper: Wrapper }
    ),
  };
}

describe('InboxBell', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeAll(() => {
    // ResponsivePopover asks matchMedia which shape to take; jsdom has none.
    // `matches: false` puts it on the desktop (popover) branch.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    handlers = new Map();
    mockConnectionState = 'connected';
    clearInboxRequest();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level so it can survive this popover unmounting, which means
    // `cleanup()` does not end it — a rejection left pending would fire its DELETE inside a
    // later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    discardSettlingApprovals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('appears the moment approval_pending arrives', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });
    await waitFor(() => expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument());

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('1 request needs your approval. Open to answer it.');
  });

  it('retires when the request is decided elsewhere', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    renderIndicator({ listPendingApprovals });
    await screen.findByTestId('inbox-bell');

    // Somebody answered — in this window, another tab, or from the CLI.
    listPendingApprovals.mockResolvedValue({ approvals: [] });
    act(() => handlers.get('approval_resolved')?.({ approvalId: '01JZ0000000000000000000001' }));

    await waitFor(() => expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument());
  });

  it('keeps the browser handoff receipt on screen after Stop task (DOR-3112)', async () => {
    const handoff = {
      id: 'h1',
      sessionId: 'chat-one',
      agentName: 'Atlas',
      agentId: null,
      agentFolder: '/work/atlas',
      profileId: null,
      reason: 'wall' as const,
      site: 'northwind.example',
      askedAt: '2026-11-03T14:30:00.000Z',
      outcome: null,
    };
    const state = {
      connectionId: 'c1',
      sessionId: 'chat-one',
      mode: 'new-window' as const,
      status: 'connected' as const,
      paused: true,
      tabs: [{ id: 't1', url: 'https://northwind.example/fares', title: 'Fares' }],
      selectedTabId: 't1',
      revision: 1,
      preparation: null,
      signIn: null,
      handoff,
    };
    const stopped = { ...state, handoff: { ...handoff, outcome: 'stopped' as const } };
    const getLocalBrowserHandoffState = vi.fn().mockResolvedValue(state);
    const stopLocalBrowserHandoff = vi.fn().mockImplementation(async () => {
      getLocalBrowserHandoffState.mockResolvedValue(stopped);
      return stopped;
    });
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getLocalBrowserHandoffState,
      stopLocalBrowserHandoff,
      interruptSession: vi.fn().mockResolvedValue({ receipt: 'none', cancelledQueued: [] }),
    });
    await userEvent.click(await screen.findByTestId('inbox-bell'));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop task' }));

    expect(stopLocalBrowserHandoff).toHaveBeenCalledWith('h1');
    // Nothing is waiting any more, but the answer must not look like a disappearance.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="browser-handoff-inbox-item"]')).toHaveTextContent(
        'Stopped. Atlas won’t carry on with this.'
      )
    );
    expect(document.querySelector('[data-slot="browser-handoff-card"]')).toBeNull();
  });

  it('is reachable from the keyboard and opens the cards in place', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    const marker = await screen.findByTestId('inbox-bell');

    await userEvent.tab();
    expect(marker).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    // The decision itself is here, not a route away.
    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t allow' })).toBeInTheDocument();
  });

  it('says so when the list cannot be read, rather than looking like silence', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('DorkOS couldn’t check approvals. Open for details.');

    await userEvent.click(marker);
    expect(await screen.findByText(/Couldn’t check for approvals/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('counts a schedule an agent parked, and answers it in the panel without closing it', async () => {
    // The one event with no marker anywhere before this: an agent proposes a scheduled run, it
    // parks because nothing arms itself, and the only way to find it was the Tasks page.
    const updateTask = vi.fn().mockResolvedValue(parkedSchedule({ status: 'active' }));
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listTasks: vi
        .fn()
        .mockResolvedValue([
          parkedSchedule(),
          parkedSchedule({ id: 'task-2', displayName: 'Weekly digest' }),
        ]),
      updateTask,
    });

    const marker = await screen.findByTestId('inbox-bell');
    await waitFor(() => expect(marker).toHaveTextContent('2'));
    // Two SCHEDULES, not two "requests" — the noun the pill uses has to match
    // what is actually waiting.
    expect(marker).toHaveAccessibleName(/2 schedules want your approval/i);

    await userEvent.click(marker);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    // The Inbox's pinned card shows its prompt, so its yes binds both words and revision.
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'active',
        expectedApprovalRevision: 'a'.repeat(64),
        approvalSurface: 'inbox',
        approvedPromptHash: 'sha256:PumzqSIeJOkvMji_z_hHg7UAzmnYW2kSn_2dPHDjyuQ',
      })
    );
    // Still open, and the schedule that was NOT decided is still answerable.
    expect(screen.getByRole('button', { name: 'Approve Weekly digest' })).toBeInTheDocument();
  });

  it('keeps the answered approval on screen once the server stops listing it', async () => {
    // The same disappearance, one card kind later (DOR-1411): answering is optimistic, the
    // refetch that follows drops the request from the pending list, and the `approvals.length >
    // 0` guard below took the whole `ApprovalList` — `AnimatePresence` and all — out of the tree
    // with it.
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    const grantApproval = vi.fn().mockImplementation(async () => {
      // The server has recorded the answer, so the pending list comes back
      // empty on the invalidation that follows.
      listPendingApprovals.mockResolvedValue({ approvals: [] });
      return { ok: true, approvalId: '01JZ0000000000000000000001', outcome: 'granted' };
    });
    renderIndicator({ listPendingApprovals, grantApproval });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    // Waits for the queue to be genuinely EMPTY — the cache rewritten and the popover re-rendered
    // off it.
    await screen.findByText('pending:0');

    // Still saying what happened, inside a section that has not collapsed.
    expect(screen.getByText('Allowed once')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();

    // And it does let go: a hold that never released would pin a decided card
    // to the panel forever.
    await waitFor(() => expect(screen.queryByText('Allowed once')).not.toBeInTheDocument(), {
      timeout: 4_000,
    });
  });
});

// --------------------------------------------------------------------------- The Inbox half —
// what the marker gained when it became the bell
// ---------------------------------------------------------------------------

/** Build a notification, overriding only what a test cares about. */
function buildNotification(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZE0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-1' },
    sessionId: 'ses-1',
    agentId: 'alpha',
    title: 'meeting-notes finished',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A quiet approvals leg, so a test about the Inbox is only about the Inbox. */
const NOTHING_WAITING = {
  listPendingApprovals: () => Promise.resolve({ approvals: [] }),
};

describe('InboxBell — history and read state', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeEach(() => {
    handlers = new Map();
    mockConnectionState = 'connected';
    clearInboxRequest();
    mockNavigate.mockClear();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level so it can survive this popover unmounting, which means
    // `cleanup()` does not end it — a rejection left pending would fire its DELETE inside a
    // later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    discardSettlingApprovals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stays invisible when nothing waits AND nothing is unread', async () => {
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi
        .fn()
        .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 0 }),
    });

    // Both legs settled first: an absence assertion that fires before the reads
    // land would pass against a component that always renders the pill.
    await screen.findByText(/^cfg:loaded:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();
  });

  it('marks everything read from the panel header', async () => {
    const markAllNotificationsRead = vi
      .fn()
      .mockResolvedValue({ ok: true, marked: 2, unreadCount: 0 });
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification({ id: 'n1' }), buildNotification({ id: 'n2' })],
        nextCursor: null,
        unreadCount: 2,
      }),
      markAllNotificationsRead,
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));

    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1);
    // Optimistic: the dots go in the same frame, and the header action goes with them because
    // there is nothing left to mark.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument()
    );
    expect(document.querySelectorAll('[data-slot="inbox-row"][data-unread="true"]')).toHaveLength(
      0
    );
  });

  it('marks a row read when it is opened, travels, and gets out of the way', async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification({ id: 'n1', sessionId: 'ses-77' })],
        nextCursor: null,
        unreadCount: 1,
      }),
      markNotificationRead,
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    await userEvent.click(await screen.findByText('meeting-notes finished'));

    expect(markNotificationRead).toHaveBeenCalledWith('n1');
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'ses-1' },
    });
    // The panel closes behind you: a popover left open over the page you just
    // asked for is a second thing to dismiss.
    await waitFor(() => expect(screen.queryByText('Needs you')).not.toBeInTheDocument());
  });
});

// --------------------------------------------------------------------------- The escape hatch: a
// quiet cockpit that is ASKED for its Inbox
// ---------------------------------------------------------------------------

describe('InboxBell — opening a bell that has nothing to say', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeEach(() => {
    handlers = new Map();
    mockConnectionState = 'connected';
    clearInboxRequest();
    mockNavigate.mockClear();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level so it can survive this popover unmounting, which means
    // `cleanup()` does not end it — a rejection left pending would fire its DELETE inside a
    // later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    discardSettlingApprovals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Nothing waiting and nothing unread — the pill draws nothing. */
  const FULLY_QUIET = {
    listPendingApprovals: () => Promise.resolve({ approvals: [] }),
    listNotifications: () =>
      Promise.resolve({ notifications: [], nextCursor: null, unreadCount: 0 }),
  };

  it('opens on ⌘⇧Y with no ask cards anywhere to jump to', async () => {
    // The shortcut's documented fallback — "opens whatever surface holds it" — for a route
    // showing none of them.
    renderIndicator(FULLY_QUIET);

    await screen.findByText(/^cfg:loaded:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();

    await userEvent.keyboard('{Meta>}{Shift>}y{/Shift}{/Meta}');

    expect(await screen.findByTestId('inbox-bell')).toBeInTheDocument();
    // No lens: the shortcut asks for everything waiting, not for one session.
    expect(await screen.findByText('Activity')).toBeInTheDocument();
  });
});

// --------------------------------------------------------------------------- Copy and ordering
// details the pill and panel owe
// ---------------------------------------------------------------------------
