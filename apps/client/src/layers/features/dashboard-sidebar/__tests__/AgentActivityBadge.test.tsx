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

  it('renders green dot for streaming status', () => {
    render(<AgentActivityBadge status="streaming" label="Streaming response" />);
    const dot = screen.getByRole('status');
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain('bg-green-500');
    expect(dot).toHaveAttribute('aria-label', 'Streaming response');
  });

  it('renders green dot for active status', () => {
    render(<AgentActivityBadge status="active" label="Active session" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('bg-green-500');
  });

  it('renders amber dot for pendingApproval status', () => {
    render(<AgentActivityBadge status="pendingApproval" label="Awaiting your approval" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('bg-amber-500');
  });

  it('renders destructive dot for error status', () => {
    render(<AgentActivityBadge status="error" label="Error" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('bg-destructive');
  });

  it('renders blue dot for unseen status', () => {
    render(<AgentActivityBadge status="unseen" label="New activity" />);
    const dot = screen.getByRole('status');
    expect(dot.className).toContain('bg-blue-500');
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
