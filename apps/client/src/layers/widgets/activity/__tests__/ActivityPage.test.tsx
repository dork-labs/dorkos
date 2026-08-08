/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/layers/features/activity-feed-page', () => ({
  useFullActivityFeed: () => ({
    data: { pages: [{ items: [], nextCursor: null }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useActivityFilters: () => ({ queryFilters: {}, isFiltered: false }),
  useLastVisitedActivity: () => null,
  ActivitySinceLastVisit: () => null,
}));

vi.mock('../ui/ActivityTimeline', () => ({
  ActivityTimeline: () => <div data-testid="activity-timeline">timeline</div>,
}));

vi.mock('../ui/ActivityLoadMore', () => ({
  ActivityLoadMore: () => null,
}));

const useSessionActivity = vi.fn<() => number[] | null>();
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
    useSessionActivity.mockReturnValue([1, 0, 0, 0, 0, 0, 2]);
  });

  it('puts the week summary and extension sections above the feed, in that order', () => {
    register({
      id: 'acme:widget',
      component: () => <div data-testid="acme-widget">widget</div>,
    });

    const { container } = render(<ActivityPage />);

    const summary = screen.getByText('3 runs in this project this week');
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

  it('shows the feed with no week summary while the session list is unknown', () => {
    useSessionActivity.mockReturnValue(null);

    render(<ActivityPage />);

    expect(screen.queryByText(/this project this week/)).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-timeline')).toBeInTheDocument();
  });
});
