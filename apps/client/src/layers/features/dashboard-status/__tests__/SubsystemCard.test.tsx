/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SubsystemCard } from '../ui/SubsystemCard';

describe('SubsystemCard', () => {
  const mockOnClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('leads with the outcome and keeps the subsystem name as a caption', () => {
    render(<SubsystemCard caption="Relay" outcome="Connected to Telegram" onClick={mockOnClick} />);

    expect(screen.getByText('Relay')).toBeInTheDocument();
    expect(screen.getByText('Connected to Telegram')).toBeInTheDocument();
  });

  it('renders a detail line when provided', () => {
    render(
      <SubsystemCard
        caption="Tasks"
        outcome="3 scheduled"
        detail="Next run in 47m"
        onClick={mockOnClick}
      />
    );

    expect(screen.getByText('Next run in 47m')).toBeInTheDocument();
  });

  it('does not render exception text when count is 0', () => {
    render(
      <SubsystemCard
        caption="Tasks"
        outcome="3 scheduled"
        exception={{ count: 0, label: 'failed today', severity: 'error' }}
        onClick={mockOnClick}
      />
    );

    expect(screen.queryByText(/failed today/)).not.toBeInTheDocument();
  });

  it('renders exception text when count is greater than 0', () => {
    render(
      <SubsystemCard
        caption="Relay"
        outcome="Connected to Slack"
        exception={{ count: 5, label: 'dead letters', severity: 'warning' }}
        onClick={mockOnClick}
      />
    );

    expect(screen.getByText('5 dead letters')).toBeInTheDocument();
  });

  it('shows "Disabled" instead of the outcome when disabled', () => {
    render(<SubsystemCard caption="Tasks" outcome="3 scheduled" disabled onClick={mockOnClick} />);

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.queryByText('3 scheduled')).not.toBeInTheDocument();
    // The caption still names the subsystem even when disabled.
    expect(screen.getByText('Tasks')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const { container } = render(
      <SubsystemCard caption="Tasks" outcome="Nothing scheduled yet" onClick={mockOnClick} />
    );

    fireEvent.click(container.querySelector('button')!);
    expect(mockOnClick).toHaveBeenCalledTimes(1);
  });

  it('calls onClick even when disabled', () => {
    const { container } = render(
      <SubsystemCard
        caption="Tasks"
        outcome="Nothing scheduled yet"
        disabled
        onClick={mockOnClick}
      />
    );

    fireEvent.click(container.querySelector('button')!);
    expect(mockOnClick).toHaveBeenCalledTimes(1);
  });
});
