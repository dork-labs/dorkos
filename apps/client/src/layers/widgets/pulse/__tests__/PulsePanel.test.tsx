/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// --- Mutable mock state -----------------------------------------------------

interface MockAttentionItem {
  id: string;
  title: string;
}
interface MockActivityItem {
  id: string;
  summary: string;
}
interface MockSignal {
  id: string;
  primary: string;
}
interface MockSchedule {
  id: string;
  displayName: string;
}

let mockAttentionItems: MockAttentionItem[] = [];
const mockOpenNotification = vi.fn();
let mockSchedules: MockSchedule[] = [];
/** Schedules the hold is still drawing after the server stopped counting them. */
let mockSettlingSchedules: MockSchedule[] = [];
let mockErrors: MockSignal[] = [];
let mockAttentionLoading = false;
let mockActivity: { groups: { label: string; items: MockActivityItem[] }[]; isLoading: boolean } = {
  groups: [],
  isLoading: false,
};

/** What the Inbox's waiting queue holds — the queue the bell's pill counts. */
let mockWaiting: {
  approvals: unknown[];
  asks: unknown[];
  schedules: unknown[];
  extensionApprovals: unknown[];
  extensionDecisions: unknown[];
  isLoading: boolean;
  isAnyError: boolean;
} = emptyWaiting();
/** Whether the panel is a modal sheet (below desktop width) in this case. */
let mockBelowDesktop = false;
const mockRequestInbox = vi.fn();
const mockRetryFailed = vi.fn();

function emptyWaiting() {
  return {
    approvals: [],
    asks: [],
    schedules: [],
    extensionApprovals: [],
    extensionDecisions: [],
    pausedConnections: [],
    isLoading: false,
    isAnyError: false,
  };
}

const mockNavigate = vi.fn();
// Current route the sections read to hide their self-referential overflow link.
// Default to a neutral route so both "View all" links render unless a test opts in.
let mockPathname = '/team';

// Router: the sections use useNavigate (overflow links) and useRouterState
// (current pathname, to omit a link that would self-navigate).
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  // Present, because these cases render inside a routed cockpit. The safe-router
  // wrappers ask before reading route state (DOR-1444).
  useRouter: () => ({ stores: {} }),
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

// Only the viewport question is stubbed; the app store and the rest are real,
// so a case can read `rightPanelOpen` back out of the store it wrote to.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsBelowDesktop: () => mockBelowDesktop };
});

// The waiting queue is the bell's own hook.
vi.mock('@/layers/entities/attention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/attention')>();
  const { deriveWaitingItems } =
    await import('@/layers/entities/attention/model/derive-waiting-items');
  return {
    ...actual,
    useWaitingQueue: () => ({
      ...mockWaiting,
      decisionOffers: [],
      items: deriveWaitingItems(mockWaiting as Parameters<typeof deriveWaitingItems>[0]),
      isError: false,
      retryFailed: mockRetryFailed,
      retry: () => {},
    }),
  };
});

vi.mock('@/layers/entities/notifications', () => ({
  requestInbox: () => mockRequestInbox(),
}));

// dashboard-attention: stub the composed model + faithful rows that surface each item's action
// (proving Pulse wires the deep-links and the two answers through).
vi.mock('@/layers/features/dashboard-attention', () => ({
  useAttentionRows: () => ({
    schedules: mockSchedules,
    errors: mockErrors,
    activity: mockAttentionItems,
    isLoading: mockAttentionLoading,
    total: mockSchedules.length + mockErrors.length + mockAttentionItems.length,
  }),
  AttentionSignalRow: ({ signal }: { signal: MockSignal }) => (
    <div data-testid="signal-row">{signal.primary}</div>
  ),
}));

// The proposed-schedule card moved to its own slice when it stopped being a row (DOR-1398).
vi.mock('@/layers/features/schedule-approval', () => ({
  ScheduleApprovalCard: ({ task }: { task: MockSchedule }) => (
    <div data-testid="schedule-row">{task.displayName}</div>
  ),
  // Pass-through: with nothing settling the real hook returns its argument unchanged, which is
  // the only state these composition-and-cap cases are about.
  useScheduleApprovalCards: (schedules: MockSchedule[]) =>
    mockSettlingSchedules.length > 0 ? [...schedules, ...mockSettlingSchedules] : schedules,
}));

// The Inbox rows the activity teaser now draws.
vi.mock('@/layers/features/inbox', () => ({
  InboxRow: ({ notification, onOpen }: { notification: MockAttentionItem; onOpen: () => void }) => (
    <div data-testid="attention-row">
      <span>{notification.title}</span>
      <button type="button" onClick={onOpen}>
        Open →
      </button>
    </div>
  ),
  useOpenNotification: () => mockOpenNotification,
}));

// dashboard-activity: stub the model.
vi.mock('@/layers/features/dashboard-activity', () => ({
  useDashboardActivity: () => mockActivity,
}));

// activity-feed-page: stub the row (rendered inside a real Table/TableBody).
vi.mock('@/layers/features/activity-feed-page', () => ({
  ActivityRow: ({ item }: { item: MockActivityItem }) => (
    <tr data-testid="activity-row">
      <td>{item.summary}</td>
    </tr>
  ),
}));

import { PulsePanel } from '../ui/PulsePanel';

function makeAttention(n: number): MockAttentionItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `att-${i}`, title: `Attention ${i}` }));
}

function makeActivityGroup(n: number) {
  return {
    groups: [
      {
        label: 'Today',
        items: Array.from({ length: n }, (_, i) => ({ id: `act-${i}`, summary: `Activity ${i}` })),
      },
    ],
    isLoading: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockAttentionItems = [];
  mockOpenNotification.mockClear();
  mockSchedules = [];
  mockSettlingSchedules = [];
  mockErrors = [];
  mockAttentionLoading = false;
  mockActivity = { groups: [], isLoading: false };
  mockPathname = '/team';
  mockWaiting = emptyWaiting();
  mockBelowDesktop = false;
});

describe('PulsePanel', () => {
  it('renders the Needs attention and Activity sections in order', () => {
    mockAttentionItems = makeAttention(1);
    mockActivity = makeActivityGroup(1);

    render(<PulsePanel />);

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    const attnIdx = headings.indexOf('Needs attention');
    const actIdx = headings.indexOf('Activity');
    expect(attnIdx).toBeGreaterThanOrEqual(0);
    expect(actIdx).toBeGreaterThan(attnIdx);
  });

  it('caps the attention teaser at 5 rows and shows the overflow link', () => {
    mockAttentionItems = makeAttention(8);

    render(<PulsePanel />);

    expect(screen.getAllByTestId('attention-row')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'View all →' })).toBeInTheDocument();
  });

  it('spends the cap on what is blocking before what merely happened', () => {
    // Five rows is all a teaser gets, and a parked schedule and a wedged session are the two a
    // person can act on.
    mockSchedules = [{ id: 'task-1', displayName: 'Nightly sweep' }];
    mockErrors = [{ id: 'error:ses-1', primary: 'tangerines' }];
    mockAttentionItems = makeAttention(8);

    render(<PulsePanel />);

    expect(screen.getByTestId('schedule-row')).toHaveTextContent('Nightly sweep');
    expect(screen.getByTestId('signal-row')).toHaveTextContent('tangerines');
    // Two of the five went to the blocking rows, so three activity rows remain.
    expect(screen.getAllByTestId('attention-row')).toHaveLength(3);
  });

  it('collapses attention to a calm all-clear line when nothing needs the operator', () => {
    mockAttentionItems = [];
    mockActivity = makeActivityGroup(1);

    render(<PulsePanel />);

    expect(screen.getByText('All quiet. Nothing needs you.')).toBeInTheDocument();
    // Nothing to view — the overflow link collapses too.
    expect(screen.queryByRole('button', { name: 'View all →' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('attention-row')).not.toBeInTheDocument();
  });

  it('opens the Inbox from the waiting line', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    mockWaiting = { ...emptyWaiting(), extensionDecisions: [{ id: 'dec-1' }] };

    render(<PulsePanel />);

    await user.click(screen.getByRole('button', { name: 'Open Inbox' }));
    expect(mockRequestInbox).toHaveBeenCalledTimes(1);
  });

  it('says it could not check, never all quiet, when a waiting read failed', () => {
    // A failed read answers with an empty list. Seeded defect: drop
    // `&& !unreadable` from the `empty` gate and the all-clear is drawn over it.
    mockWaiting = { ...emptyWaiting(), isAnyError: true };

    render(<PulsePanel />);

    expect(screen.queryByText('All quiet. Nothing needs you.')).not.toBeInTheDocument();
    expect(screen.getByText('Couldn’t check everything waiting on you.')).toBeInTheDocument();
  });

  it('does not flash the all-clear while the waiting queue is still loading', () => {
    mockWaiting = { ...emptyWaiting(), isLoading: true };

    render(<PulsePanel />);

    expect(screen.queryByText('All quiet. Nothing needs you.')).not.toBeInTheDocument();
  });

  it('deep-links each attention item through the one open-a-notification rule', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    mockAttentionItems = [{ id: 'a', title: 'A message could not be delivered' }];

    render(<PulsePanel />);

    await user.click(screen.getByRole('button', { name: 'Open →' }));
    // The same callback the bell and home use, so a row opened here reads and
    // travels exactly as it does there.
    expect(mockOpenNotification).toHaveBeenCalledWith(mockAttentionItems[0]);
  });

  it('drops the attention section on the home surface, which already shows it', () => {
    // Home's pinned triage header is this same list at full size.
    mockPathname = '/';
    mockAttentionItems = makeAttention(2);
    mockActivity = makeActivityGroup(2);

    render(<PulsePanel />);

    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View all →' })).not.toBeInTheDocument();
    // Activity is not duplicated here, so it still draws — with its link.
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open activity →' })).toBeInTheDocument();
  });
});
