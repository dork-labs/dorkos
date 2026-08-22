/**
 * The Inbox bell: it appears the moment an agent asks, from any route; it
 * retires when the request is decided or its window closes; it reads a count for
 * a queue and a different, neutral one for unread history; and it can be reached
 * and opened from the keyboard alone.
 *
 * Everything above the "the Inbox half" block is the marker's ORIGINAL contract,
 * ported unchanged from `ApprovalsIndicator` — the amber pill still means exactly
 * one thing, and the settling rule that keeps a receipt on screen still holds.
 * The evolution had to leave those true, so they are asserted here in the same
 * words.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectionState, Task } from '@dorkos/shared/types';
import type { PendingApproval, StandingPermission } from '@dorkos/shared/approval-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';

/** Global stream state the widget reads; mutable so a test can drop the link. */
let mockConnectionState: ConnectionState = 'connected';

/**
 * Whether `useIsMobile` reports the phone breakpoint; mutable so a test can
 * drive the popover into its Drawer (bottom sheet) branch instead of the
 * default desktop Popover the rest of this suite renders.
 */
let mockIsMobile = false;

/**
 * The router this suite does not mount.
 *
 * `useSafeNavigate` only returns `null` in the Obsidian embed; everywhere else
 * it hands back TanStack's navigator, which mounts happily without a provider
 * and throws the moment it is CALLED. Opening an Inbox row calls it, so a suite
 * that renders the bell outside a router has to say where "go there" goes.
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
import { useStandingPermissions } from '@/layers/features/approvals';
import { useConfig } from '@/layers/entities/config';
import { clearInboxRequest, requestInbox } from '@/layers/entities/notifications';
import {
  discardPendingRejections,
  discardSettlingSchedules,
} from '@/layers/features/schedule-approval';
import { InboxBell } from '../ui/InboxBell';

/**
 * Renders the state the marker is derived from, so a test can wait for the reads
 * to have LANDED before asserting the marker is absent.
 *
 * `waitFor` resolves on its first synchronous check, so an absence assertion
 * inside one fires before any query settles — when the marker would be missing
 * whatever the component does. Two such cases were green here against a
 * deliberately broken build. This is the same probe pattern the card tests use,
 * and the reason is the same: proving a negative needs a positive first.
 */
function SettledProbe() {
  const { data: config } = useConfig();
  const { isLoading } = usePendingApprovals();
  const { permissions } = useStandingPermissions();
  const { isLoading: inboxLoading } = useNotifications();
  return (
    <span data-testid="settled">
      {`${config ? 'cfg' : 'nocfg'}:${isLoading ? 'loading' : 'loaded'}:${permissions.length}:${
        inboxLoading ? 'inbox-loading' : 'inbox-loaded'
      }`}
    </span>
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
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: '/tmp/nightly-sweep/SKILL.md',
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    nextRuns: [],
    ...overrides,
  };
}

/** Build a live standing permission. */
function buildPermission(overrides: Partial<StandingPermission> = {}): StandingPermission {
  return {
    grantId: '01JZ00000000000000000000G1',
    agentPath: '/Users/dev/agents/dorkbot',
    agentLabel: 'dorkbot',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(),
    ...overrides,
  };
}

/**
 * A config with both standing-permission settings on.
 *
 * The list is only read when they are, so a test about live permissions that
 * forgot this would assert against an empty list and pass for the wrong reason.
 */
function configWithStandingGrants() {
  return vi.fn().mockResolvedValue({
    version: '1.0.0',
    port: 4242,
    uptime: 0,
    workingDirectory: '/test',
    nodeVersion: 'v20.0.0',
    platform: 'linux-x64',
    runtimes: ['claude-code'],
    claudeCliPath: null,
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
    tasks: { enabled: true },
    auth: { enabled: true },
    approvals: { standingGrants: true, trustWindowMinutes: 480 },
  });
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
    // The undo window is module-level so it can survive this popover
    // unmounting, which means `cleanup()` does not end it — a rejection left
    // pending would fire its DELETE inside a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows no visible marker while nothing is waiting', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    // Wait for both reads to land FIRST. `waitFor` around the absence alone
    // resolves on its first synchronous check, before either query settles, so it
    // would pass against a component that always renders the marker.
    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();
  });

  it('appears the moment approval_pending arrives', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });
    await waitFor(() => expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument());

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('1 request needs your approval. Open to answer it.');
  });

  it('keeps its live region mounted while quiet, so the arrival is announced', async () => {
    // A live region inserted at the same moment as its text is not reliably read
    // out. The region has to already exist when the count lands.
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    const announcer = await waitFor(() => screen.getByRole('status'));
    expect(announcer).toBeEmptyDOMElement();

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    await waitFor(() =>
      expect(announcer).toHaveTextContent('1 request needs your approval. Open to answer it.')
    );
  });

  it('reads a count when several agents are waiting at once', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [
          buildApproval(),
          buildApproval({ approvalId: '01JZ0000000000000000000002' }),
          buildApproval({ approvalId: '01JZ0000000000000000000003' }),
        ],
      }),
    });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('3 requests need your approval. Open to answer them.');
    expect(marker).toHaveTextContent('3');
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

  it('never shows a request whose window has already closed', async () => {
    // The server excludes these from `listPending`, but a card already on screen
    // when the window closes has to go too — nothing announces an expiry.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
      }),
    });

    await waitFor(() => expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument());
  });

  it('retires the marker when the window closes while you are looking at it', async () => {
    vi.useFakeTimers();
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ expiresAt: new Date(Date.now() + 60_000).toISOString() })],
      }),
    });

    // Let the first read land, then confirm the marker is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('inbox-bell')).toBeInTheDocument();

    // Sit past the deadline with nobody deciding and no agent retrying: the
    // server emits no event here, so the marker has to time itself out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: "Don't allow" })).toBeInTheDocument();
  });

  it('says so when the list cannot be read, rather than looking like silence', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('DorkOS could not check for approvals. Open for details.');

    await userEvent.click(marker);
    expect(
      await screen.findByText(/could not check whether anything is waiting/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('stays quiet about a failed read while the link is already known to be down', async () => {
    // A server restart fails the read too. Painting an amber alarm next to the
    // connection item's existing signal would double-report one outage and dilute
    // what this marker means, which is only ever "an agent is blocked".
    mockConnectionState = 'reconnecting';
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    await waitFor(() => expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument());
  });

  it('shows a quiet marker, not the amber one, when only standing permissions are live', async () => {
    // Nobody is blocked and nothing needs answering. The amber pill means exactly
    // one thing — an agent is waiting on you — and spending it on news that is not
    // urgent is how a marker stops being read.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('1 standing permission is live. Open to see it or end it.');
    expect(marker.className).not.toContain('bg-status-warning-bg');
    // The check-mark shield belongs to this state and only this one: live trust
    // that was actually verified, not a read that failed.
    expect(marker.querySelector('.lucide-shield-check')).toBeInTheDocument();
    expect(marker.querySelector('.lucide-shield-alert')).not.toBeInTheDocument();
  });

  it('opens onto the permissions, with the button that ends one', async () => {
    // A permission a person cannot find is a dark pattern, and this is the surface
    // they are most likely looking at when they wonder why nothing asked them.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));

    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stop trusting dorkbot/ })).toBeInTheDocument();
  });

  it('reports the pending queue when both are true, and puts the permissions under the cards', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName('1 request needs your approval. Open to answer it.');

    await userEvent.click(marker);
    await screen.findByRole('button', { name: 'Allow' });
    const card = document.querySelector('[data-slot="approval-card"]');
    const permission = document.querySelector('[data-slot="standing-permission"]');
    expect(card).not.toBeNull();
    expect(permission).not.toBeNull();
    // Something waiting on a person outranks something already decided.
    expect(
      (card as Node).compareDocumentPosition(permission as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('stays silent about permissions the settings do not allow to exist', async () => {
    // Standing permissions off means there is nothing to find, and the server
    // would refuse the read anyway. A marker here would be pure noise.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
    });

    // The probe proves the config landed and the permission list resolved to
    // nothing, which is what makes the marker's absence mean something.
    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();
  });

  it('says so when the permission list cannot be read, rather than looking untrusted', async () => {
    // An empty list here reads as "nothing is trusted", which is the most
    // reassuring thing this surface can say. A failed read must not borrow it: the
    // gate may still be auto-approving under a permission nobody can now see.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockRejectedValue(new Error('offline')),
    });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName(
      'DorkOS could not check which standing permissions are live. Open for details.'
    );
    // Not the check-mark shield: that icon says "verified", the opposite of what
    // a failed read means. A person reads this pill by silhouette far more often
    // than by the accessible name a screen reader gets.
    expect(marker.querySelector('.lucide-shield-alert')).toBeInTheDocument();
    expect(marker.querySelector('.lucide-shield-check')).not.toBeInTheDocument();

    await userEvent.click(marker);
    // Scoped to the panel: the live region announcing the same fact is not the
    // thing being asserted here.
    const panel = await screen.findByTestId('standing-permissions-error');
    expect(panel).toHaveTextContent(/could not check which standing permissions are live/i);
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('still shows requests it already knows about when the link drops', async () => {
    // Suppression covers the unknown-state pill only. Cards already read are real
    // and still have to be answerable.
    mockConnectionState = 'disconnected';
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });

    expect(await screen.findByTestId('inbox-bell')).toBeInTheDocument();
  });

  it('names an agent’s prompt as a question, never as an approval request', async () => {
    // Two different objects are counted by one pill, and a question is not a
    // permission request. Seeded defect: restore the old single sentence and
    // this reads "1 request needs your approval" over a question.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listPendingInteractions: vi.fn().mockResolvedValue({
        interactions: [
          {
            sessionId: 'session-1',
            cwd: '/projects/meeting-notes',
            interaction: {
              type: 'question',
              id: 'q-1',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              questions: [],
            },
          },
        ],
      }),
    });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveAccessibleName(/1 question needs your answer/i);
    expect(marker).not.toHaveAccessibleName(/approval/i);
  });

  it('counts a waiting prompt beside the approvals, and calls the agent by name', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listPendingInteractions: vi.fn().mockResolvedValue({
        interactions: [
          {
            sessionId: 'session-1',
            cwd: '/projects/meeting-notes',
            interaction: {
              type: 'approval',
              id: 'tc-1',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              toolName: 'Write',
              displayName: 'Write',
              description: '/projects/meeting-notes/standup.md',
              input: JSON.stringify({ file_path: '/projects/meeting-notes/standup.md' }),
              hasSuggestions: false,
            },
          },
        ],
      }),
    });

    const marker = await screen.findByTestId('inbox-bell');
    expect(marker).toHaveTextContent('1');
    await userEvent.click(marker);

    // The file is named, which is the whole point of the card — and the agent is
    // named from its directory when the roster holds nothing better.
    expect(await screen.findByText(/wants to write standup\.md/i)).toBeInTheDocument();
    expect(screen.getByText('/projects/meeting-notes/standup.md')).toBeInTheDocument();
    // The tray is never the session, so it owes a way into it.
    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();
  });

  it('counts a schedule an agent parked, and answers it in the panel without closing it', async () => {
    // The one event with no marker anywhere before this: an agent proposes a
    // scheduled run, it parks because nothing arms itself, and the only way to
    // find it was the Tasks page.
    //
    // Answering leaves the panel where it is, exactly as allowing an approval
    // card does. Seeded defect: hand the row an `onDecided` that calls
    // `setOpen(false)` and the second schedule's buttons are gone from under
    // the cursor the moment the first is decided.
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

    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'active', enabled: true });
    // Still open, and the schedule that was NOT decided is still answerable.
    expect(screen.getByRole('button', { name: 'Approve Weekly digest' })).toBeInTheDocument();
  });

  it('keeps the approved schedule on screen once the server stops listing it', async () => {
    // The disappearance this closes: approving is optimistic, and the refetch
    // that follows drops the task out of the parked list — which used to take
    // the card AND this whole pinned section out of the tree, tearing away the
    // only confirmation an approval gets (measured at 10-60ms).
    //
    // Driven through the REAL hold: nothing about `settling-approvals` is mocked
    // here, so this fails if the registry stops reporting or the section stops
    // reading it. Seeded defect: revert `shownSchedules` to `schedules` in
    // either the section's guard or its map, and the card is gone.
    const listTasks = vi.fn().mockResolvedValue([parkedSchedule()]);
    const updateTask = vi.fn().mockImplementation(async () => {
      // The server now calls it active, so the parked list comes back empty.
      listTasks.mockResolvedValue([parkedSchedule({ status: 'active', enabled: true })]);
      return parkedSchedule({ status: 'active', enabled: true });
    });
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listTasks,
      updateTask,
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    // Both facts in ONE `waitFor`, which is what makes this honest under a busy
    // machine: it passes the moment the refetch has landed AND the card is still
    // drawn, rather than racing a fixed sleep against the hold's own window.
    await waitFor(() => {
      expect(listTasks).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('schedule-approval-card')).toBeInTheDocument();
    });
    // Still saying what happened, inside a section that has not collapsed.
    expect(document.querySelector('[data-slot="schedule-receipt"]')).toHaveTextContent('Approved');
    expect(screen.getByRole('heading', { name: 'Needs You' })).toBeInTheDocument();
  });

  it('adds the parked schedule to the approvals already waiting', async () => {
    // The discriminating half: one capability approval plus one parked
    // schedule is two, not one. A count that forgot the schedules would still
    // read "1" here.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      listTasks: vi.fn().mockResolvedValue([parkedSchedule()]),
    });

    const marker = await screen.findByTestId('inbox-bell');
    await waitFor(() => expect(marker).toHaveTextContent('2'));
    // One of each kind, named as both: neither noun swallows the other.
    expect(marker).toHaveAccessibleName(/1 request and 1 schedule are waiting on you/i);
  });

  it('says nothing at all about a schedule that is already running', async () => {
    // An armed schedule is not waiting on anybody, and a pill that appeared for
    // one would be permanent decoration on every cockpit with a cron in it.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listTasks: vi.fn().mockResolvedValue([parkedSchedule({ status: 'active', enabled: true })]),
    });

    await screen.findByText(/^cfg:loaded/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The Inbox half — what the marker gained when it became the bell
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
    // The undo window is module-level so it can survive this popover
    // unmounting, which means `cleanup()` does not end it — a rejection left
    // pending would fire its DELETE inside a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
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
    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();
  });

  it('draws a neutral count, never the amber one, when the only news is unread', async () => {
    // The whole discrimination of the evolution: unread history is news, not an
    // alarm. Seeded defect — give the unread branch `tone="waiting"` and this
    // reads amber over a cockpit where nothing is blocked.
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification()],
        nextCursor: null,
        unreadCount: 4,
      }),
    });

    const bell = await screen.findByTestId('inbox-bell');
    expect(bell).toHaveAttribute('data-tone', 'neutral');
    expect(bell).toHaveTextContent('4');
    expect(bell).toHaveAccessibleName('4 unread notifications. Open your Inbox.');
    expect(bell.className).not.toContain('bg-status-warning-bg');
  });

  it('reports the blocking queue, not the unread count, when both are true', async () => {
    // One slot, and the half with a clock on it wins it.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification()],
        nextCursor: null,
        unreadCount: 9,
      }),
    });

    const bell = await screen.findByTestId('inbox-bell');
    expect(bell).toHaveAttribute('data-tone', 'waiting');
    expect(bell).toHaveAccessibleName('1 request needs your approval. Open to answer it.');
  });

  it('puts what needs you above what merely happened', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification({ title: 'meeting-notes finished' })],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));

    const card = await screen.findByText('Uninstall a marketplace package');
    const row = await screen.findByText('meeting-notes finished');
    // Something waiting on a person outranks something already over.
    expect(card.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    // Optimistic: the dots go in the same frame, and the header action goes with
    // them because there is nothing left to mark. The panel does NOT close —
    // reading your Inbox should not throw you out of it.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument()
    );
    expect(document.querySelectorAll('[data-slot="inbox-row"][data-unread="true"]')).toHaveLength(
      0
    );
  });

  it('offers no mark-all when nothing is unread', async () => {
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification({ readAt: new Date().toISOString() })],
        nextCursor: null,
        unreadCount: 0,
      }),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
      getConfig: configWithStandingGrants(),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    await screen.findByText('meeting-notes finished');
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.queryByText('Needs You')).not.toBeInTheDocument());
  });

  it('takes a live notification without being reopened', async () => {
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi
        .fn()
        .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 0 }),
    });
    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();

    act(() =>
      handlers.get('notification')?.({ notification: buildNotification({ id: 'live-1' }) })
    );

    // The pill has to appear from the stream alone — the count comes off the
    // same cached page the event was written into.
    const bell = await screen.findByTestId('inbox-bell');
    expect(bell).toHaveAttribute('data-tone', 'neutral');
  });

  it('opens filtered when a session asks for its own notifications', async () => {
    const listNotifications = vi
      .fn()
      .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 3 });
    renderIndicator({ ...NOTHING_WAITING, listNotifications });

    await screen.findByTestId('inbox-bell');
    act(() => requestInbox({ sessionId: 'ses-42' }));

    await waitFor(() =>
      expect(listNotifications).toHaveBeenCalledWith({ limit: 25, sessionId: 'ses-42' })
    );
    // And it says which slice it is showing, so the empty list is not read as a
    // broken Inbox.
    expect(await screen.findByText('Activity · this session')).toBeInTheDocument();
  });

  it('drops the session filter once the panel is closed again', async () => {
    // Something unread, so the bell is on screen on its own terms and closing
    // the panel does not simply unmount it.
    renderIndicator({
      ...NOTHING_WAITING,
      listNotifications: vi
        .fn()
        .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 2 }),
    });

    await screen.findByTestId('inbox-bell');
    act(() => requestInbox({ sessionId: 'ses-42' }));
    await screen.findByText('Activity · this session');

    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByTestId('inbox-bell'));

    // A filter nobody can see is a filter that makes the next open look broken.
    expect(await screen.findByText('Activity')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The escape hatch: a quiet cockpit that is ASKED for its Inbox
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
    // The undo window is module-level so it can survive this popover
    // unmounting, which means `cleanup()` does not end it — a rejection left
    // pending would fire its DELETE inside a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Nothing waiting, nothing unread, nothing trusted — the pill draws nothing. */
  const FULLY_QUIET = {
    listPendingApprovals: () => Promise.resolve({ approvals: [] }),
    listNotifications: () =>
      Promise.resolve({ notifications: [], nextCursor: null, unreadCount: 0 }),
  };

  it('opens for a session that asked, even with an empty Inbox and nothing waiting', async () => {
    // The escape hatch this pins: `quiet` normally unmounts the whole popover,
    // so without it "View notifications" in a session menu is a button that
    // does nothing on exactly the cockpit where a person is most likely to
    // press it — the calm one. Seeded defect: drop `&& !open` from `quiet` and
    // this finds no bell at all.
    renderIndicator(FULLY_QUIET);

    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();

    act(() => requestInbox({ sessionId: 'ses-42' }));

    const bell = await screen.findByTestId('inbox-bell');
    // Neutral, and no number: "0 trusted" is a sentence about nothing.
    expect(bell).toHaveAttribute('data-tone', 'neutral');
    expect(bell).toHaveAccessibleName('Your Inbox. Nothing is waiting and nothing is unread.');
    expect(bell).not.toHaveTextContent(/\d/);
    expect(await screen.findByText('Activity · this session')).toBeInTheDocument();
  });

  it('opens on ⌘⇧Y with no ask cards anywhere to jump to', async () => {
    // The shortcut's documented fallback — "opens whatever surface holds it" —
    // for a route showing none of them. It reaches `requestAskTray`, which sets
    // `open`, which is the only thing keeping the popover mounted here.
    renderIndicator(FULLY_QUIET);

    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument();

    await userEvent.keyboard('{Meta>}{Shift>}y{/Shift}{/Meta}');

    expect(await screen.findByTestId('inbox-bell')).toBeInTheDocument();
    // No lens: the shortcut asks for everything waiting, not for one session.
    expect(await screen.findByText('Activity')).toBeInTheDocument();
  });

  it('goes back to drawing nothing once the panel is closed', async () => {
    renderIndicator(FULLY_QUIET);

    await screen.findByText(/^cfg:loaded:0:inbox-loaded$/);
    act(() => requestInbox());
    await screen.findByTestId('inbox-bell');

    await userEvent.keyboard('{Escape}');

    // The hatch is for the duration of the asking, not a permanent promotion:
    // a marker that stayed behind would be the decoration-without-signal the
    // widget has always refused.
    await waitFor(() => expect(screen.queryByTestId('inbox-bell')).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Copy and ordering details the pill and panel owe
// ---------------------------------------------------------------------------

describe('InboxBell — what the panel says', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeEach(() => {
    handlers = new Map();
    mockConnectionState = 'connected';
    mockIsMobile = false;
    clearInboxRequest();
    mockNavigate.mockClear();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level so it can survive this popover
    // unmounting, which means `cleanup()` does not end it — a rejection left
    // pending would fire its DELETE inside a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('hides Mark all read under a filtered lens, where it would not mean what it says', async () => {
    // The button is fleet-global. Under a session header it reads as "mark this
    // session read" and would silently clear the whole Inbox.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listNotifications: vi
        .fn()
        .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 3 }),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeInTheDocument();

    act(() => requestInbox({ sessionId: 'ses-42' }));

    await screen.findByText('Activity · this session');
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();

    // And it comes back when the filter does.
    await userEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });

  it('says nothing is waiting rather than "0 requests" while a receipt is still up', async () => {
    // The settling window: the last ask has been answered, the card is still on
    // screen saying how it ended, and the count is zero. The old summary read
    // "0 requests are waiting for your answer", which is a sentence about
    // nothing said at the exact moment somebody finished their queue.
    const listPendingInteractions = vi.fn().mockResolvedValue({
      interactions: [
        {
          sessionId: 'session-1',
          cwd: '/projects/meeting-notes',
          interaction: {
            type: 'question',
            id: 'q-1',
            startedAt: Date.now(),
            remainingMs: 600_000,
            timeoutMs: 600_000,
            questions: [],
          },
        },
      ],
    });
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listPendingInteractions,
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));
    // The panel's own summary, not the pill's accessible name — both say a
    // version of this sentence, and only one of them is under test.
    expect(
      await screen.findByText(
        '1 question is waiting on your answer. Nothing carries on until you answer.'
      )
    ).toBeInTheDocument();

    // Somebody answered it, anywhere.
    act(() =>
      handlers.get('interaction_resolved')?.({
        sessionId: 'session-1',
        interactionId: 'q-1',
        outcome: 'answered',
        resolvedAt: new Date().toISOString(),
      })
    );

    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument());
    expect(screen.queryByText(/0 requests/)).not.toBeInTheDocument();
  });

  it('keeps saying "answered" over "trusted" while a receipt is still up', async () => {
    // Ordering inside the pill: a receipt is about the thing just finished and
    // outranks a standing permission, which is a state that has been true all
    // along. Seeded defect: move the trusted branch above the settling one and
    // the pill flips to "2 trusted" in the frame the answer lands.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
      listPendingInteractions: vi.fn().mockResolvedValue({
        interactions: [
          {
            sessionId: 'session-1',
            cwd: '/projects/meeting-notes',
            interaction: {
              type: 'question',
              id: 'q-1',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              questions: [],
            },
          },
        ],
      }),
    });

    const bell = await screen.findByTestId('inbox-bell');
    await waitFor(() => expect(bell).toHaveAttribute('data-tone', 'waiting'));

    act(() =>
      handlers.get('interaction_resolved')?.({
        sessionId: 'session-1',
        interactionId: 'q-1',
        outcome: 'answered',
        resolvedAt: new Date().toISOString(),
      })
    );

    await waitFor(() => expect(bell).toHaveTextContent('answered'));
    expect(bell).toHaveAttribute('data-tone', 'waiting');
    expect(bell).not.toHaveTextContent('trusted');
  });

  it('names schedules as schedules, never as "requests", when they are all that is waiting', async () => {
    // The bug this pins: a parked schedule is a decision to approve or reject,
    // not a question, and it is also not a generic capability "request" — it
    // is its own kind of thing. Seeded defect: fold `schedules` back into
    // `approvals` in the `waitingSummary` call and this reads "2 requests are
    // waiting for your approval. Nothing runs until you decide." instead.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
      listTasks: vi
        .fn()
        .mockResolvedValue([
          parkedSchedule(),
          parkedSchedule({ id: 'task-2', displayName: 'Weekly digest' }),
        ]),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));

    expect(
      await screen.findByText('2 schedules want your approval. Nothing runs until you decide.')
    ).toBeInTheDocument();
    // No COUNTED "request" anywhere on the panel — the mislabel this pins is a
    // sentence that reports a number of requests when the number is schedules.
    //
    // Scoped to counted phrases rather than the bare word, and that narrowing is
    // deliberate rather than a retreat: the cards themselves legitimately say
    // "Requested without an agent identity" for a proposal that carries no agent
    // path (the shared identity fallback), so a bare `/request/i` sweep now
    // matches honest copy about identity and would have to be deleted instead.
    // Seeded defect: fold `schedules` back into `approvals` in the
    // `waitingSummary` call and the panel reads "2 requests are waiting for your
    // approval", which this matches.
    expect(screen.queryByText(/\d+ requests? (is|are|need)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/requests? (is|are) waiting/i)).not.toBeInTheDocument();
  });

  it('names all three kinds at once, in the panel listing order, still promising nothing runs', async () => {
    // Two kinds of coverage a two-kind test cannot give: `countNoun`'s plural
    // path exercised on a THIRD kind in the same sentence, and the three-part
    // Oxford join (`a, b, and c`) — indistinguishable from a two-part join
    // (`a and b`) until a third part is actually present. Seeded defect:
    // break `countNoun`'s pluralization (drop the trailing `s`) or the Oxford
    // join (e.g. always `.join(', ')` with no "and") and this goes red.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      listTasks: vi
        .fn()
        .mockResolvedValue([
          parkedSchedule(),
          parkedSchedule({ id: 'task-2', displayName: 'Weekly digest' }),
        ]),
      listPendingInteractions: vi.fn().mockResolvedValue({
        interactions: [
          {
            sessionId: 'session-1',
            cwd: '/projects/meeting-notes',
            interaction: {
              type: 'question',
              id: 'q-1',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              questions: [],
            },
          },
          {
            sessionId: 'session-2',
            cwd: '/projects/roadmap',
            interaction: {
              type: 'question',
              id: 'q-2',
              startedAt: Date.now(),
              remainingMs: 600_000,
              timeoutMs: 600_000,
              questions: [],
            },
          },
        ],
      }),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));

    expect(
      await screen.findByText(
        '2 questions, 1 request, and 2 schedules are waiting on you. Nothing runs until you decide.'
      )
    ).toBeInTheDocument();
  });

  it('keeps every section heading in the accessible tree below the desktop breakpoint', async () => {
    // The four section headings used `hidden md:block`, which sets `display:
    // none` below `md` — removing the heading from the ACCESSIBILITY TREE, not
    // just off screen, and leaving a phone screen reader with one heading for
    // the entire popover. jsdom never loads the app's compiled stylesheet, so
    // no query here can observe `display: none` the way a real browser would —
    // `getByRole('heading', ...)` would find every heading on the old classes
    // too. What DOES discriminate is the class list itself: `sr-only` (visible
    // to assistive tech at every width) swapped in for `hidden`, with
    // `md:not-sr-only` restoring the exact desktop look at `md`. Rendered under
    // the Drawer (mobile/bottom-sheet) branch, which is where a phone user
    // actually meets these headings. Seeded defect: put `hidden md:block` back
    // on any of the four and this goes red.
    mockIsMobile = true;
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      listTasks: vi.fn().mockResolvedValue([parkedSchedule()]),
      getConfig: configWithStandingGrants(),
      listStandingPermissions: vi.fn().mockResolvedValue({ grants: [buildPermission()] }),
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [buildNotification()],
        nextCursor: null,
        unreadCount: 1,
      }),
    });

    await userEvent.click(await screen.findByTestId('inbox-bell'));

    for (const name of ['Needs You', 'Scheduled Runs', 'Activity', 'Standing Permissions']) {
      const heading = await screen.findByRole('heading', { name });
      expect(heading).toBeInTheDocument();
      expect(heading.className).toContain('sr-only');
      expect(heading.className).toContain('md:not-sr-only');
      expect(heading.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    }
  });
});
