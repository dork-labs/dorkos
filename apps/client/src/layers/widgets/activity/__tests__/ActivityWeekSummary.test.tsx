/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionWeekActivity } from '../model/use-session-activity';

const useSessionActivity = vi.fn<() => SessionWeekActivity | null>();
vi.mock('../model/use-session-activity', () => ({
  useSessionActivity: () => useSessionActivity(),
}));

import { ActivityWeekSummary } from '../ui/ActivityWeekSummary';

describe('ActivityWeekSummary', () => {
  beforeEach(() => {
    useSessionActivity.mockReset();
  });

  it('renders nothing while the count is unknown', () => {
    // First load in flight, a failed request, or an embed with no agent roster.
    // Silence there is an unanswered question, not a quiet week.
    useSessionActivity.mockReturnValue(null);

    const { container } = render(<ActivityWeekSummary />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing started once the count has answered and is zero', () => {
    useSessionActivity.mockReturnValue({ dailyCounts: [0, 0, 0, 0, 0, 0, 0], degraded: false });

    render(<ActivityWeekSummary />);

    expect(screen.getByText('Your agents started no sessions this week')).toBeInTheDocument();
  });

  it('says how busy the week has been across every agent', () => {
    useSessionActivity.mockReturnValue({ dailyCounts: [1, 0, 2, 0, 0, 3, 1], degraded: false });

    render(<ActivityWeekSummary />);

    expect(screen.getByText('Your agents started 7 sessions this week')).toBeInTheDocument();
  });

  it('reports a floor, not a total, when a runtime could not be read', () => {
    useSessionActivity.mockReturnValue({ dailyCounts: [1, 0, 2, 0, 0, 3, 1], degraded: true });

    render(<ActivityWeekSummary />);

    expect(
      screen.getByText('Your agents started at least 7 sessions this week')
    ).toBeInTheDocument();
  });

  it('draws one bar per day', () => {
    useSessionActivity.mockReturnValue({ dailyCounts: [1, 0, 2, 0, 0, 3, 1], degraded: false });

    const { container } = render(<ActivityWeekSummary />);

    expect(container.querySelectorAll('rect')).toHaveLength(7);
  });
});
