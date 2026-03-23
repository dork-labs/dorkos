/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentEmptyFilterState } from '../ui/AgentEmptyFilterState';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Suppress motion animation in tests
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('AgentEmptyFilterState', () => {
  it('renders the SearchX icon', () => {
    const onClearFilters = vi.fn();
    render(<AgentEmptyFilterState onClearFilters={onClearFilters} />);

    // lucide-react renders an svg; the icon container should be in the document
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders the "No agents match your filters" message', () => {
    const onClearFilters = vi.fn();
    render(<AgentEmptyFilterState onClearFilters={onClearFilters} />);

    expect(screen.getByText('No agents match your filters')).toBeInTheDocument();
  });

  it('renders the "Clear filters" button', () => {
    const onClearFilters = vi.fn();
    render(<AgentEmptyFilterState onClearFilters={onClearFilters} />);

    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('calls onClearFilters when the "Clear filters" button is clicked', () => {
    const onClearFilters = vi.fn();
    render(<AgentEmptyFilterState onClearFilters={onClearFilters} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
