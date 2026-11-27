/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { WorkItem } from '@dorkos/shared/work-graph-reads';
import { WorkItemList, WORK_ITEM_ROW_SLOT, type PullRequestsQuery } from '../index';

afterEach(() => cleanup());

/** A pull request with these links. */
function pr(id: string, text: string, links: WorkItem['links'], day = '2026-11-24'): WorkItem {
  return { ref: { kind: 'pr', id }, text, firstRecordedOn: day, links };
}

function query(items: WorkItem[], extra: Partial<PullRequestsQuery> = {}): PullRequestsQuery {
  return {
    items,
    isLoading: false,
    isError: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    ...extra,
  };
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${WORK_ITEM_ROW_SLOT}"]`));
}

describe('WorkItemList', () => {
  it('links a pull request to GitHub when its repository is known, and says how the chats came to it', () => {
    render(
      <WorkItemList
        emptyText="None yet."
        chatId="mine"
        query={query([
          pr('dork-labs/dorkos#42', 'dork-labs/dorkos#42', [
            { relation: 'opened', chatId: 'mine', recordedAt: '2026-11-24T10:00:00.000Z' },
            { relation: 'works_on', chatId: null, recordedOn: '2026-11-25' },
          ]),
          pr(
            '#7',
            'PR #7',
            [{ relation: 'works_on', chatId: 'child', recordedAt: '2026-11-20T10:00:00.000Z' }],
            '2025-11-20'
          ),
        ])}
      />
    );
    const [first, second] = rows();
    expect(first?.querySelector('a')).toHaveAttribute(
      'href',
      'https://github.com/dork-labs/dorkos/pull/42'
    );
    expect(first).toHaveTextContent('Opened · Works on · Nov 24');
    expect(first).not.toHaveTextContent('In a spin-off');
    // No repository, so no page to point at; and only a chat below this one is linked.
    expect(second?.querySelector('a')).toBeNull();
    expect(second).toHaveTextContent('Works on · Nov 20, 2025 · In a spin-off');
  });

  it('says so when there are none, and offers the next page while one waits', async () => {
    const { rerender } = render(<WorkItemList emptyText="None yet." query={query([])} />);
    expect(screen.getByText('None yet.')).toBeInTheDocument();

    const more = query([pr('#1', 'PR #1', [])], { hasMore: true });
    rerender(<WorkItemList emptyText="None yet." query={more} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(more.loadMore).toHaveBeenCalledOnce();
  });
});
