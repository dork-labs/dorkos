/**
 * The collapsed header for a burst of activity: its unread dot, its face,
 * and the read-state guarantees expanding it makes.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { AgentVisualSource } from '@/layers/entities/agent';
import { InboxGroupRow } from '../ui/InboxGroupRow';
import type { InboxGroupItem } from '../lib/group-activity-rows';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZG0000000000000000001',
    kind: 'run.completed',
    tier: 'quiet',
    subject: { type: 'run', id: 'run-1' },
    agentId: 'alpha',
    title: 'run finished',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a three-member group, newest first, all defaulting to read. */
function buildGroup(notifications: NotificationDTO[]): InboxGroupItem {
  return {
    type: 'group',
    id: notifications[notifications.length - 1].id,
    agentId: 'alpha',
    kind: 'run.completed',
    tone: 'neutral',
    notifications,
  };
}

const AGENT: AgentVisualSource = { id: 'alpha', color: '#6366f1', icon: '🐙' };
const READ = new Date().toISOString();

afterEach(() => {
  cleanup();
});

describe('InboxGroupRow unread dot', () => {
  it('shows the dot when every member is read but ONE is not — any-unread semantics', () => {
    const group = buildGroup([
      build({ id: 'a', readAt: READ }),
      build({ id: 'b', readAt: READ }),
      build({ id: 'c' }), // the one unread member
    ]);

    render(
      <InboxGroupRow group={group} agent={AGENT} agentName="alpha" onOpenNotification={vi.fn()} />
    );

    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'true');
  });

  it('hides the dot only when every member is read', () => {
    const group = buildGroup([
      build({ id: 'a', readAt: READ }),
      build({ id: 'b', readAt: READ }),
      build({ id: 'c', readAt: READ }),
    ]);

    render(
      <InboxGroupRow group={group} agent={AGENT} agentName="alpha" onOpenNotification={vi.fn()} />
    );

    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'false');
  });
});

describe('InboxGroupRow expansion', () => {
  it('expanding the header marks nothing read', async () => {
    const onOpenNotification = vi.fn();
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        onOpenNotification={onOpenNotification}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /alpha finished 3 runs/ }));

    expect(onOpenNotification).not.toHaveBeenCalled();
    // The member rows are now visible — expansion happened.
    expect(screen.getAllByText('run finished')).toHaveLength(3);
  });

  it('collapses again on a second click, without ever opening a notification', async () => {
    const onOpenNotification = vi.fn();
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        onOpenNotification={onOpenNotification}
      />
    );

    const header = screen.getByRole('button', { name: /alpha finished 3 runs/ });
    await userEvent.click(header);
    await userEvent.click(header);

    expect(screen.queryAllByText('run finished')).toHaveLength(0);
    expect(onOpenNotification).not.toHaveBeenCalled();
  });

  it('clicking an individual member row once expanded opens THAT notification', async () => {
    const onOpenNotification = vi.fn();
    const group = buildGroup([
      build({ id: 'a', title: 'run a finished' }),
      build({ id: 'b', title: 'run b finished' }),
      build({ id: 'c', title: 'run c finished' }),
    ]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        onOpenNotification={onOpenNotification}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /alpha finished 3 runs/ }));
    await userEvent.click(screen.getByText('run b finished'));

    expect(onOpenNotification).toHaveBeenCalledTimes(1);
    expect(onOpenNotification).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });
});

describe('InboxGroupRow header title', () => {
  it('names the agent and the count', () => {
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <InboxGroupRow group={group} agent={AGENT} agentName="alpha" onOpenNotification={vi.fn()} />
    );

    expect(screen.getByText('alpha finished 3 runs')).toBeInTheDocument();
  });
});
