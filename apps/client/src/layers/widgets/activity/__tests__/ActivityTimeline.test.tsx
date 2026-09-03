/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActivityItem } from '@dorkos/shared/activity-schemas';

// `ActivityRow` reads `useNavigate` from the router, and `ActivityEmptyState`
// reads filter state from it too — neither is under test here, so both are
// stood in for rather than wiring up a router the assertions never touch.
vi.mock('@/layers/features/activity-feed-page', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/activity-feed-page')>();
  return {
    ...actual,
    ActivityRow: ({ item }: { item: ActivityItem }) => (
      <tr>
        <td>{item.summary}</td>
      </tr>
    ),
    ActivityEmptyState: () => <div data-testid="activity-empty-state" />,
  };
});

import { ActivityTimeline } from '../ui/ActivityTimeline';

const ITEM: ActivityItem = {
  id: 'evt-1',
  occurredAt: new Date().toISOString(),
  actorType: 'agent',
  actorId: 'agent-1',
  actorLabel: 'Warden',
  category: 'agent',
  eventType: 'session.started',
  resourceType: null,
  resourceId: null,
  resourceLabel: null,
  summary: 'Warden started a session',
  linkPath: null,
  metadata: null,
};

describe('ActivityTimeline', () => {
  it('shows the skeleton while loading with nothing loaded yet', () => {
    const { container } = render(
      <ActivityTimeline items={[]} isLoading isError={false} onRetry={vi.fn()} isFiltered={false} />
    );

    expect(container.querySelector('[data-slot="activity-timeline-skeleton"]')).not.toBeNull();
  });

  it('shows the empty state when there is genuinely nothing to show', () => {
    // The positive control the next test's absence assertion was missing: it
    // is not enough to prove `activity-empty-state` is ABSENT under
    // `isError` — something has to prove it is REACHABLE at all, or the
    // absence assertion is unfalsifiable.
    render(
      <ActivityTimeline
        items={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        isFiltered={false}
      />
    );

    expect(screen.getByTestId('activity-empty-state')).toBeInTheDocument();
  });

  it('shows the error state instead of the empty state when the feed fails to load', () => {
    // The bug this pins (batch 06, finding 6.4): before `isError` was threaded
    // through, a failed fetch left `items` at `[]` and this branch fell straight
    // to `ActivityEmptyState` — a broken request looked exactly like a quiet
    // week. Flip `isError` to `false` here and this assertion goes red.
    render(
      <ActivityTimeline items={[]} isLoading={false} isError onRetry={vi.fn()} isFiltered={false} />
    );

    expect(screen.getByText(/couldn.t load your activity/i)).toBeInTheDocument();
    expect(screen.queryByTestId('activity-empty-state')).not.toBeInTheDocument();
  });

  it('retries through the callback the page wired up', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ActivityTimeline items={[]} isLoading={false} isError onRetry={onRetry} isFiltered={false} />
    );

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps showing already-loaded items over the error state', () => {
    // Mirrors `InboxList`'s own guard: a later page failing to load should not
    // blank out a feed that already has rows on screen.
    render(
      <ActivityTimeline
        items={[ITEM]}
        isLoading={false}
        isError
        onRetry={vi.fn()}
        isFiltered={false}
      />
    );

    expect(screen.getByText('Warden started a session')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your activity/i)).not.toBeInTheDocument();
  });
});
