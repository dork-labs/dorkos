/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const useSessionActivity = vi.fn<() => number[] | null>();
vi.mock('../model/use-session-activity', () => ({
  useSessionActivity: () => useSessionActivity(),
}));

import { ActivityWeekSummary } from '../ui/ActivityWeekSummary';

describe('ActivityWeekSummary', () => {
  beforeEach(() => {
    useSessionActivity.mockReset();
  });

  it('renders nothing while the session list is unknown', () => {
    // A disabled query (no project selected yet) or a first load in flight.
    // An empty list there is an unanswered question, not a quiet week.
    useSessionActivity.mockReturnValue(null);

    const { container } = render(<ActivityWeekSummary />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing ran once the list has answered and is empty', () => {
    useSessionActivity.mockReturnValue([0, 0, 0, 0, 0, 0, 0]);

    render(<ActivityWeekSummary />);

    expect(screen.getByText('No runs in this project this week')).toBeInTheDocument();
  });

  it('says how busy the week has been', () => {
    useSessionActivity.mockReturnValue([1, 0, 2, 0, 0, 3, 1]);

    render(<ActivityWeekSummary />);

    expect(screen.getByText('7 runs in this project this week')).toBeInTheDocument();
  });

  it('draws one bar per day', () => {
    useSessionActivity.mockReturnValue([1, 0, 2, 0, 0, 3, 1]);

    const { container } = render(<ActivityWeekSummary />);

    expect(container.querySelectorAll('rect')).toHaveLength(7);
  });
});
