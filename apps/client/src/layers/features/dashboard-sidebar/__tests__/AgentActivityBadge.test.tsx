import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentActivityBadge } from '../ui/AgentActivityBadge';
import type { SessionBorderKind } from '@/layers/entities/session';

afterEach(cleanup);

describe('AgentActivityBadge', () => {
  it('renders null for idle status', () => {
    const { container } = render(<AgentActivityBadge status="idle" label="Idle" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the theme success token for streaming, never a raw palette green', () => {
    // `bg-green-500` here and `bg-status-success` in a room was one fact wearing
    // two spellings, each free to move when either theme did.
    render(<AgentActivityBadge status="streaming" label="Working" />);
    const dot = screen.getByRole('status');
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain('bg-status-success');
    expect(dot.className).not.toContain('bg-green-500');
    expect(dot).toHaveAttribute('aria-label', 'Working');
  });

  it('renders the contrast-safe warning token for pendingApproval status', () => {
    // `bg-status-warning-dot`, not the fill-tuned `bg-status-warning`: a 6px
    // mark that means something by colour alone owes 3:1 against the surface
    // (WCAG 1.4.11), and the general amber is 2.15:1 on a light one.
    render(<AgentActivityBadge status="pendingApproval" label="Awaiting your approval" />);
    const dot = screen.getByRole('status');
    expect(dot.className.split(' ')).toContain('bg-status-warning-dot');
    expect(dot.className.split(' ')).not.toContain('bg-status-warning');
    expect(dot.className).not.toContain('bg-amber-500');
  });

  it('renders the error token for error status', () => {
    render(<AgentActivityBadge status="error" label="Error" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('bg-status-error');
  });

  it('renders the info token for unseen status', () => {
    render(<AgentActivityBadge status="unseen" label="New activity" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('bg-status-info');
    expect(dot.className).not.toContain('bg-blue-500');
  });

  it('moves only for streaming — every other state holds still', () => {
    // Motion is what says "right now". An approval waiting on you is a state,
    // and a state that pulsed would claim to still be going.
    render(<AgentActivityBadge status="streaming" label="Working" />);
    expect(screen.getByRole('status').className).toContain('motion-safe:animate-pulse');

    cleanup();
    for (const status of ['pendingApproval', 'error', 'unseen'] as const) {
      render(<AgentActivityBadge status={status} label={status} />);
      expect(screen.getByRole('status').className).not.toContain('animate-pulse');
      cleanup();
    }
  });

  it('has size-1.5 for compact 6px dot', () => {
    render(<AgentActivityBadge status="streaming" label="Streaming" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('size-1.5');
  });

  it('passes aria-label for screen readers', () => {
    render(<AgentActivityBadge status="error" label="Error — check session" />);
    expect(screen.getByLabelText('Error — check session')).toBeInTheDocument();
  });
});
