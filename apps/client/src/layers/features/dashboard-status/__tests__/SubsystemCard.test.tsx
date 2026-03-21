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

  it('renders title and primary metric', () => {
    render(<SubsystemCard title="Pulse" primaryMetric="3 schedules" onClick={mockOnClick} />);

    expect(screen.getByText('Pulse')).toBeInTheDocument();
    expect(screen.getByText('3 schedules')).toBeInTheDocument();
  });

  it('renders secondary info when provided', () => {
    render(
      <SubsystemCard
        title="Pulse"
        primaryMetric="3 schedules"
        secondaryInfo="Next: 47m"
        onClick={mockOnClick}
      />
    );

    expect(screen.getByText('Next: 47m')).toBeInTheDocument();
  });

  it('does not render exception text when count is 0', () => {
    render(
      <SubsystemCard
        title="Pulse"
        primaryMetric="3 schedules"
        exception={{ count: 0, label: 'failed today', severity: 'error' }}
        onClick={mockOnClick}
      />
    );

    expect(screen.queryByText(/failed today/)).not.toBeInTheDocument();
  });

  it('renders exception text when count is greater than 0', () => {
    render(
      <SubsystemCard
        title="Relay"
        primaryMetric="2 adapters"
        exception={{ count: 5, label: 'dead letters', severity: 'warning' }}
        onClick={mockOnClick}
      />
    );

    expect(screen.getByText('5 dead letters')).toBeInTheDocument();
  });

  it('shows "Disabled" label and muted title when disabled prop is true', () => {
    render(
      <SubsystemCard title="Pulse" primaryMetric="3 schedules" disabled onClick={mockOnClick} />
    );

    expect(screen.getByText('Disabled')).toBeInTheDocument();
    // Primary metric should not be rendered
    expect(screen.queryByText('3 schedules')).not.toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const { container } = render(
      <SubsystemCard title="Pulse" primaryMetric="0 schedules" onClick={mockOnClick} />
    );

    const button = container.querySelector('button')!;
    fireEvent.click(button);
    expect(mockOnClick).toHaveBeenCalledTimes(1);
  });

  it('calls onClick even when disabled', () => {
    const { container } = render(
      <SubsystemCard title="Pulse" primaryMetric="0 schedules" disabled onClick={mockOnClick} />
    );

    const button = container.querySelector('button')!;
    fireEvent.click(button);
    expect(mockOnClick).toHaveBeenCalledTimes(1);
  });
});
