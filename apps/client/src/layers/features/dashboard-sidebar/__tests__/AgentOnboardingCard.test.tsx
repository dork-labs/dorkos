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

  it('renders with dashed border styling', () => {
    const { container } = render(<AgentOnboardingCard onAddAgent={vi.fn()} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-dashed');
  });
});
