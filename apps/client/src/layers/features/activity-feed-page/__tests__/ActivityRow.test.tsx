/**
 * @vitest-environment jsdom
 *
 * A row that highlights, takes a Tab stop and answers Enter is promising an
 * action. Two thirds of the rows on Home's Pulse panel have no `linkPath` and
 * made all three promises anyway (DOR-1751).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

import type { ActivityItem } from '@/layers/entities/activity';
import { Table, TableBody } from '@/layers/shared/ui';
import { ActivityRow } from '../ui/ActivityRow';

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

const item = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'act-1',
  occurredAt: new Date().toISOString(),
  actorType: 'agent',
  actorId: 'agent-1',
  actorLabel: 'Scout',
  category: 'agent',
  eventType: 'session.completed',
  resourceType: null,
  resourceId: null,
  resourceLabel: null,
  summary: 'Finished a run',
  linkPath: null,
  metadata: null,
  ...overrides,
});

const renderRow = (activity: ActivityItem) =>
  render(
    <Table>
      <TableBody>
        <ActivityRow item={activity} />
      </TableBody>
    </Table>
  );

describe('ActivityRow', () => {
  it('is focusable and navigable when the event has somewhere to go', () => {
    renderRow(item({ linkPath: '/session/abc' }));

    const row = screen.getByRole('row');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.hasAttribute('data-activity-row')).toBe(true);

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith({ to: '/session/abc', replace: false });
  });

  it('renders as plain text when there is nothing to open', () => {
    renderRow(item({ linkPath: null }));

    const row = screen.getByRole('row');
    // No Tab stop, and no arrow-key stop either: `data-activity-row` is what
    // `useActivityKeyboardNav` walks, and it can only focus what is focusable.
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(row.hasAttribute('data-activity-row')).toBe(false);
    // And no hover highlight — the row inherits TableRow's, so it cancels it.
    expect(row.className).toContain('hover:bg-transparent');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
  });
});
