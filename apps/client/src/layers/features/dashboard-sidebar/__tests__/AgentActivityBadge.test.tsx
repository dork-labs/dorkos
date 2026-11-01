import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentActivityBadge } from '../ui/AgentActivityBadge';

afterEach(cleanup);

describe('AgentActivityBadge', () => {
  it('renders null for idle status', () => {
    const { container } = render(<AgentActivityBadge status="idle" label="Idle" />);
    expect(container.firstChild).toBeNull();
  });

  it('is a named image, never a live region of its own', () => {
    // A `status` role on every agent row is a live region per row, and the
    // whole list would be read out at once.
    render(<AgentActivityBadge status="streaming" label="Working" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Working' })).toBeInTheDocument();
  });

  it('renders the theme success token for streaming, never a raw palette green', () => {
    render(<AgentActivityBadge status="streaming" label="Working" />);
    const dot = screen.getByRole('img');
    expect(dot.className).toContain('bg-status-success');
    expect(dot.className).not.toContain('bg-green-500');
    expect(dot.className).toContain('rounded-full');
  });

  it('draws needs-you as a diamond in the brand ink, not an amber dot', () => {
    // The amber dot was 2.69:1 on the light panel, under 3:1, and a colour
    // alone beside a green and a grey dot (Phase 4 B4). A shape says it
    // without the colour.
    render(<AgentActivityBadge status="pendingApproval" label="Awaiting your approval" />);
    const mark = screen.getByRole('img');
    const classes = mark.className.split(' ');
    expect(mark).toHaveAttribute('data-row-mark', 'needs-you');
    expect(classes).toContain('bg-brand-text');
    expect(classes).toContain('rotate-45');
    expect(classes).not.toContain('rounded-full');
    expect(mark.className).not.toContain('status-warning');
  });

  it('renders the error token for error status', () => {
    render(<AgentActivityBadge status="error" label="Error" />);
    expect(screen.getByRole('img').className).toContain('bg-status-error');
  });

  it('draws unseen in the panel ink, not blue', () => {
    // The blue was 2.96:1 on the light panel; unseen is the quietest mark.
    render(<AgentActivityBadge status="unseen" label="New activity" />);
    const dot = screen.getByRole('img');
    expect(dot.className).toContain('bg-sidebar-foreground/60');
    expect(dot.className).not.toContain('status-info');
  });

  it('moves only for streaming — every other state holds still', () => {
    // Motion is what says "right now". An approval waiting on you is a state,
    // and a state that pulsed would claim to still be going.
    render(<AgentActivityBadge status="streaming" label="Working" />);
    expect(screen.getByRole('img').className).toContain('motion-safe:animate-pulse');

    cleanup();
    for (const status of ['pendingApproval', 'error', 'unseen'] as const) {
      render(<AgentActivityBadge status={status} label={status} />);
      expect(screen.getByRole('img').className).not.toContain('animate-pulse');
      cleanup();
    }
  });

  it('is a 6px dot with a mouse and grows to 8px on a phone', () => {
    render(<AgentActivityBadge status="streaming" label="Streaming" />);
    const dot = screen.getByRole('img');
    expect(dot.className).toContain('size-1.5');
    expect(dot.className).toContain('max-md:size-2');
  });
});
