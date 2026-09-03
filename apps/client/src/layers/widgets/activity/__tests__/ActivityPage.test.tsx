/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/layers/features/activity-feed-page', () => ({
  useFullActivityFeed: () => ({
    data: { pages: [{ items: [], nextCursor: null }] },
    isLoading: false,
    // Kept alongside the fields above rather than omitted: `ActivityPage`
    // reads both and wires `refetch` into `onRetry` (batch 06, finding 6.4).
    // `ActivityTimeline` is mocked below so nothing here calls `onRetry`
    // today, but a hook shape this file doesn't otherwise reproduce is a
    // false green waiting for that mock to come off.
    isError: false,
    refetch: vi.fn(),
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useActivityFilters: () => ({ queryFilters: {}, isFiltered: false }),
  useLastVisitedActivity: () => null,
  ActivitySinceLastVisit: () => null,
  // The chips are the filter feature's and have their own suite; what this file
  // asserts is WHERE they are rendered, which is a fact about this page.
  ActivityFilterBar: () => <div data-testid="activity-filter-bar">filters</div>,
}));

vi.mock('../ui/ActivityTimeline', () => ({
  ActivityTimeline: () => <div data-testid="activity-timeline">timeline</div>,
}));

vi.mock('../ui/ActivityLoadMore', () => ({
  ActivityLoadMore: () => null,
}));

const useSessionActivity = vi.fn<() => { dailyCounts: number[]; degraded: boolean } | null>();
vi.mock('../model/use-session-activity', () => ({
  useSessionActivity: () => useSessionActivity(),
}));

import { useExtensionRegistry, createInitialSlots } from '@/layers/shared/model';
import type { DashboardSectionContribution } from '@/layers/shared/model';
import { ActivityPage } from '../ActivityPage';

const register = (contribution: DashboardSectionContribution) =>
  useExtensionRegistry.getState().register('dashboard.sections', contribution);

describe('ActivityPage', () => {
  beforeEach(() => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    useSessionActivity.mockReset();
    useSessionActivity.mockReturnValue({ dailyCounts: [1, 0, 0, 0, 0, 0, 2], degraded: false });
  });

  it('opens with the filters — they belong to the feed, not to the header (phase H1)', () => {
    // They used to ride in the bar's identity zone, which left no room for the
    // home surface tabs on a phone. A filter toolbar as the page's first row is
    // the pattern the rest of the cockpit already uses.
    render(<ActivityPage />);

    const filters = screen.getByTestId('activity-filter-bar');
    const timeline = screen.getByTestId('activity-timeline');
    expect(filters.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('puts the week summary and extension sections above the feed, in that order', () => {
    register({
      id: 'acme:widget',
      component: () => <div data-testid="acme-widget">widget</div>,
    });

    const { container } = render(<ActivityPage />);

    const summary = screen.getByText('Your agents started 3 sessions this week');
    const heading = screen.getByText('From your extensions');
    const widget = screen.getByTestId('acme-widget');
    const timeline = screen.getByTestId('activity-timeline');

    // Node.compareDocumentPosition returns DOCUMENT_POSITION_FOLLOWING (4) when
    // the argument comes after the node in document order.
    const follows = (before: Element, after: Element) =>
      Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(container).toContainElement(summary);
    expect(follows(summary, heading)).toBe(true);
    expect(follows(heading, widget)).toBe(true);
    expect(follows(widget, timeline)).toBe(true);
  });

  it('renders no extensions heading when only built-in sections are registered', () => {
    register({ id: 'recent-activity', component: () => <div data-testid="built-in" /> });

    render(<ActivityPage />);

    expect(screen.queryByText('From your extensions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('built-in')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-timeline')).toBeInTheDocument();
  });

  it('shows the feed with no week summary while the count is unknown', () => {
    useSessionActivity.mockReturnValue(null);

    render(<ActivityPage />);

    expect(screen.queryByText(/this week/)).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-timeline')).toBeInTheDocument();
  });
});
