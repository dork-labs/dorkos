/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// --- Mutable mock state -----------------------------------------------------

interface MockAttentionItem {
  id: string;
  description: string;
  action: { label: string; onClick: () => void };
}
interface MockActivityItem {
  id: string;
  summary: string;
}

let mockAttentionItems: MockAttentionItem[] = [];
let mockAttentionLoading = false;
let mockActivity: { groups: { label: string; items: MockActivityItem[] }[]; isLoading: boolean } = {
  groups: [],
  isLoading: false,
};

const mockNavigate = vi.fn();

// Router: only useNavigate is used by the sections.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// dashboard-attention: stub the model + a faithful row that surfaces the item's
// action (proving Pulse wires each item's deep-link through).
vi.mock('@/layers/features/dashboard-attention', () => ({
  useAttentionItems: () => ({ items: mockAttentionItems, isLoading: mockAttentionLoading }),
  AttentionItemRow: ({ item }: { item: MockAttentionItem }) => (
    <div data-testid="attention-row">
      <span>{item.description}</span>
      <button type="button" onClick={item.action.onClick}>
        {item.action.label}
      </button>
    </div>
  ),
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
  return Array.from({ length: n }, (_, i) => ({
    id: `att-${i}`,
    description: `Attention ${i}`,
    action: { label: 'View →', onClick: vi.fn() },
  }));
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
  mockAttentionLoading = false;
  mockActivity = { groups: [], isLoading: false };
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

  it('deep-links each attention item through its action', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onClick = vi.fn();
    mockAttentionItems = [
      { id: 'a', description: 'Session idle', action: { label: 'Open →', onClick } },
    ];

    render(<PulsePanel />);

    await user.click(screen.getByRole('button', { name: 'Open →' }));
    expect(onClick).toHaveBeenCalledTimes(1);
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

  it('keeps the attention section a labelled block above the rows', () => {
    mockAttentionItems = makeAttention(2);

    render(<PulsePanel />);

    const heading = screen.getByRole('heading', { name: 'Needs attention' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getAllByTestId('attention-row')).toHaveLength(2);
  });
});
