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
    renderRow(item({ linkPath: '/tasks' }));

    const row = screen.getByRole('row');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.hasAttribute('data-activity-row')).toBe(true);

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith({ href: '/tasks', replace: false });
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
  // -------------------------------------------------------------------------
  // A server-written path is not a route until it is checked (DOR-924)
  // -------------------------------------------------------------------------

  it('does not navigate on a path naming no route the app serves', () => {
    // `linkPath` is written by the server and used to be cast straight into the
    // router's typed `to` (`item.linkPath as '/'`) — a claim about a string
    // nobody checked. A path with nowhere to go now leaves the row inert.
    renderRow(item({ linkPath: '/session/abc' }));

    const row = screen.getByRole('row');
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(row.hasAttribute('data-activity-row')).toBe(false);
    expect(screen.queryByRole('button', { name: /Open/ })).not.toBeInTheDocument();

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ])('does not navigate on the off-origin or hostile path %s', (linkPath) => {
    renderRow(item({ linkPath }));

    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates from the Open button only for a real route', () => {
    renderRow(item({ linkPath: '/agents' }));

    fireEvent.click(screen.getByRole('button', { name: /Open/ }));
    expect(navigate).toHaveBeenCalledWith({ href: '/agents', replace: false });
  });
});
