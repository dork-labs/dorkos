/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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
let mockErrors: MockSignal[] = [];
let mockAttentionLoading = false;
let mockActivity: { groups: { label: string; items: MockActivityItem[] }[]; isLoading: boolean } = {
  groups: [],
  isLoading: false,
};

const mockNavigate = vi.fn();
// Current route the sections read to hide their self-referential overflow link.
// Default to a neutral route so both "View all" links render unless a test opts in.
let mockPathname = '/team';

// Router: the sections use useNavigate (overflow links) and useRouterState
// (current pathname, to omit a link that would self-navigate).
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

// dashboard-attention: stub the composed model + faithful rows that surface
// each item's action (proving Pulse wires the deep-links and the two answers
// through). The model is one hook now — the second attention engine that used
// to live behind `useAttentionItems` is gone (DOR-1381).
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
  ScheduleApprovalRow: ({ task }: { task: MockSchedule }) => (
    <div data-testid="schedule-row">{task.displayName}</div>
  ),
}));

// The Inbox rows the activity teaser now draws. Stubbed for the same reason as
// everything else in this suite: the panel's job is composition and caps, and
// the real row would drag in the transport and the read-state mutation.
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
  mockErrors = [];
  mockAttentionLoading = false;
  mockActivity = { groups: [], isLoading: false };
  mockPathname = '/team';
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

  it('omits the Usage section — no honest off-session data exists', () => {
    mockAttentionItems = makeAttention(1);
    mockActivity = makeActivityGroup(1);

    render(<PulsePanel />);

    expect(screen.queryByText('Usage')).not.toBeInTheDocument();
  });

  it('caps the attention teaser at 5 rows and shows the overflow link', () => {
    mockAttentionItems = makeAttention(8);

    render(<PulsePanel />);

    expect(screen.getAllByTestId('attention-row')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'View all →' })).toBeInTheDocument();
  });

  it('spends the cap on what is blocking before what merely happened', () => {
    // Five rows is all a teaser gets, and a parked schedule and a wedged
    // session are the two a person can act on. Seeded defect: concatenate the
    // three lists the other way round and the schedule falls off the end.
    mockSchedules = [{ id: 'task-1', displayName: 'Nightly sweep' }];
    mockErrors = [{ id: 'error:ses-1', primary: 'tangerines' }];
    mockAttentionItems = makeAttention(8);

    render(<PulsePanel />);

    expect(screen.getByTestId('schedule-row')).toHaveTextContent('Nightly sweep');
    expect(screen.getByTestId('signal-row')).toHaveTextContent('tangerines');
    // Two of the five went to the blocking rows, so three activity rows remain.
    expect(screen.getAllByTestId('attention-row')).toHaveLength(3);
  });

  it('caps the activity teaser at 5 rows and shows the overflow link', () => {
    mockActivity = makeActivityGroup(9);

    render(<PulsePanel />);

    expect(screen.getAllByTestId('activity-row')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Open activity →' })).toBeInTheDocument();
  });

  it('collapses attention to a calm all-clear line when nothing needs the operator', () => {
    mockAttentionItems = [];
    mockActivity = makeActivityGroup(1);

    render(<PulsePanel />);

    expect(screen.getByText('All quiet — nothing needs you.')).toBeInTheDocument();
    // Nothing to view — the overflow link collapses too.
    expect(screen.queryByRole('button', { name: 'View all →' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('attention-row')).not.toBeInTheDocument();
  });

  it('collapses activity to a calm all-clear line when there is nothing recent', () => {
    mockActivity = { groups: [], isLoading: false };

    render(<PulsePanel />);

    expect(screen.getByText('No recent activity.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open activity →' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-row')).not.toBeInTheDocument();
  });

  it('does not flash the activity all-clear while the feed is still loading', () => {
    mockActivity = { groups: [], isLoading: true };

    render(<PulsePanel />);

    expect(screen.queryByText('No recent activity.')).not.toBeInTheDocument();
  });

  it('does not flash the attention all-clear while its queries are still loading', () => {
    // Cold load: no items yet but the backing queries are pending — the
    // reassurance must not render before the data that would justify it.
    mockAttentionItems = [];
    mockAttentionLoading = true;

    render(<PulsePanel />);

    expect(screen.queryByText('All quiet — nothing needs you.')).not.toBeInTheDocument();
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

  it('routes the overflow links to the dashboard and the activity page', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    mockAttentionItems = makeAttention(1);
    mockActivity = makeActivityGroup(1);

    render(<PulsePanel />);

    await user.click(screen.getByRole('button', { name: 'View all →' }));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });

    await user.click(screen.getByRole('button', { name: 'Open activity →' }));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/activity' });
  });

  it('hides the attention "View all" link on the dashboard (its own destination)', () => {
    mockPathname = '/';
    mockAttentionItems = makeAttention(2);
    mockActivity = makeActivityGroup(2);

    render(<PulsePanel />);

    // Self-navigation no-op omitted on '/', but the activity link (→ /activity)
    // still shows since we are not there.
    expect(screen.queryByRole('button', { name: 'View all →' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open activity →' })).toBeInTheDocument();
  });

  it('hides the activity "Open activity" link on /activity (its own destination)', () => {
    mockPathname = '/activity';
    mockAttentionItems = makeAttention(2);
    mockActivity = makeActivityGroup(2);

    render(<PulsePanel />);

    expect(screen.queryByRole('button', { name: 'Open activity →' })).not.toBeInTheDocument();
    // The attention link (→ /) still shows since we are not on the dashboard.
    expect(screen.getByRole('button', { name: 'View all →' })).toBeInTheDocument();
  });

  it('shows both overflow links on an unrelated route', () => {
    mockPathname = '/tasks';
    mockAttentionItems = makeAttention(2);
    mockActivity = makeActivityGroup(2);

    render(<PulsePanel />);

    expect(screen.getByRole('button', { name: 'View all →' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open activity →' })).toBeInTheDocument();
  });

  it('keeps the attention section a labelled block above the rows', () => {
    mockAttentionItems = makeAttention(2);

    render(<PulsePanel />);

    const heading = screen.getByRole('heading', { name: 'Needs attention' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getAllByTestId('attention-row')).toHaveLength(2);
  });
});
