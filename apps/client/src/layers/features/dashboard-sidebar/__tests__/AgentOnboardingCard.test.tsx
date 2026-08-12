import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentOnboardingCard } from '../ui/AgentOnboardingCard';

afterEach(cleanup);

describe('AgentOnboardingCard', () => {
  it('renders explanation text', () => {
    render(<AgentOnboardingCard onAddAgent={vi.fn()} />);
    expect(screen.getByText(/Add more agents to your fleet/)).toBeInTheDocument();
  });

  it('renders Add agent CTA button', () => {
    render(<AgentOnboardingCard onAddAgent={vi.fn()} />);
    expect(screen.getByText('Add agent')).toBeInTheDocument();
  });

  it('calls onAddAgent when CTA is clicked', () => {
    const onAddAgent = vi.fn();
    render(<AgentOnboardingCard onAddAgent={onAddAgent} />);
    fireEvent.click(screen.getByText('Add agent'));
    expect(onAddAgent).toHaveBeenCalledOnce();
  });

  it('separates by tint and carries no hairline anywhere in it (R1)', () => {
    // This case used to assert the opposite — `toContain('border-dashed')` —
    // which pinned the last hairline in the sidebar in place. R1 removed every
    // border from the panel in favour of one `--sidebar-accent` ramp and wrote
    // no exception for empty states, and an invitation is exactly the surface
    // that should not be the one thing drawing a box on day one.
    //
    // `--muted` is banned here for the reason `SidebarRow` and `SidebarZone`
    // give: it is lighter than the panel in light mode and darker in dark, so
    // anything wearing it separates in opposite directions between themes.
    const { container } = render(<AgentOnboardingCard onAddAgent={vi.fn()} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toMatch(/\bbg-sidebar-accent\/40\b/);
    expect(container.innerHTML).not.toMatch(/\bborder|\bbg-muted\b|\btext-muted-foreground\b/);
  });
});
