/**
 * The collapsed header for a burst of activity: its unread dot, its face,
 * the fixed glyph slot, and the read-state guarantees expanding it makes.
 *
 * @vitest-environment jsdom
 */
import { useState } from 'react';
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
function buildGroup(
  notifications: NotificationDTO[],
  overrides: Partial<Pick<InboxGroupItem, 'tone' | 'kind' | 'stateKey'>> = {}
): InboxGroupItem {
  return {
    type: 'group',
    id: notifications[notifications.length - 1].id,
    stateKey: 'alpha:run.completed:neutral#0',
    agentId: 'alpha',
    kind: 'run.completed',
    tone: 'neutral',
    notifications,
    ...overrides,
  };
}

const AGENT: AgentVisualSource = { id: 'alpha', color: '#6366f1', icon: '🐙' };
const READ = new Date().toISOString();

/**
 * `InboxGroupRow` no longer owns its own expand state — `InboxList` does,
 * per review round 1. This wrapper stands in for that owner so the
 * interaction tests below (click header, see members, click a member) keep
 * driving the same real toggle a person would.
 */
function ControlledGroupRow(props: {
  group: InboxGroupItem;
  agent?: AgentVisualSource | null;
  agentName: string;
  onOpenNotification: (notification: NotificationDTO) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <InboxGroupRow
      {...props}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((current) => !current)}
    />
  );
}

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
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
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
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveAttribute('data-unread', 'false');
  });
});

describe('InboxGroupRow expansion', () => {
  it('expanding the header marks nothing read', async () => {
    const onOpenNotification = vi.fn();
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <ControlledGroupRow
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
      <ControlledGroupRow
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
      <ControlledGroupRow
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

  it('calls onToggleExpanded, not any state of its own, when the header is clicked', async () => {
    // Direct render, uncontrolled: if InboxGroupRow ever regressed to owning
    // an internal `useState` again, `expanded` staying `false` here would
    // still flip the DOM (the old bug) even though this prop never changes —
    // proving the component TRULY takes its cue from the prop, not a click.
    const onToggleExpanded = vi.fn();
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={onToggleExpanded}
        onOpenNotification={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /alpha finished 3 runs/ }));

    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    // Still collapsed — this component does not decide that on its own.
    expect(screen.queryAllByText('run finished')).toHaveLength(0);
  });

  it('ties the member rows to the header via aria-controls once expanded', async () => {
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <ControlledGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        onOpenNotification={vi.fn()}
      />
    );

    const header = screen.getByRole('button', { name: /alpha finished 3 runs/ });
    await userEvent.click(header);

    const controlsId = header.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId as string)).not.toBeNull();
  });

  it('carries no aria-controls while collapsed — nothing exists for it to name', () => {
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).not.toHaveAttribute('aria-controls');
  });
});

describe('InboxGroupRow header title', () => {
  it('names the agent and the count', () => {
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );

    expect(screen.getByText('alpha finished 3 runs')).toBeInTheDocument();
  });

  it('reports the NEWEST member’s age, not the oldest', () => {
    const group = buildGroup([
      build({ id: 'a', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }), // 5m — newest
      build({ id: 'b', createdAt: new Date(Date.now() - 60 * 60_000).toISOString() }), // 1h
      build({ id: 'c', createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }), // 3h — oldest
    ]);

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );

    expect(screen.getByText('5m')).toBeInTheDocument();
    expect(screen.queryByText('3h')).not.toBeInTheDocument();
  });
});

describe('InboxGroupRow glyph', () => {
  it('draws both the icon and the face inside the fixed-width slot', () => {
    const group = buildGroup([build({ id: 'a' }), build({ id: 'b' }), build({ id: 'c' })]);
    const { rerender } = render(
      <InboxGroupRow
        group={group}
        agent={null}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );
    const iconSlot = document.querySelector('[data-slot="inbox-row-glyph"]');
    expect(iconSlot).toHaveClass('size-[18px]');

    rerender(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );
    const faceSlot = document.querySelector('[data-slot="inbox-row-glyph"]');
    expect(faceSlot).toHaveClass('size-[18px]');
  });

  it('keeps the coloured kind glyph on an error-tone group, even with a resolved agent', () => {
    const group = buildGroup(
      [
        build({ id: 'a', tier: 'notable' }),
        build({ id: 'b', tier: 'notable' }),
        build({ id: 'c', tier: 'notable' }),
      ],
      { tone: 'error' }
    );

    render(
      <InboxGroupRow
        group={group}
        agent={AGENT}
        agentName="alpha"
        expanded={false}
        onToggleExpanded={vi.fn()}
        onOpenNotification={vi.fn()}
      />
    );

    expect(document.querySelector('[data-slot="agent-avatar"]')).not.toBeInTheDocument();
  });
});
