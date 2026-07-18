/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PackageEmptyState } from '../ui/PackageEmptyState';

afterEach(() => cleanup());

describe('PackageEmptyState', () => {
  it('renders the default filter message with no button when no handler is given', () => {
    // A true empty catalog (no active filters) offers no escape hatch.
    render(<PackageEmptyState />);
    expect(screen.getByText('No packages match your filters')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a "Reset filters" button by default when a handler is given', () => {
    render(<PackageEmptyState onResetFilters={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument();
  });

  it('renders a category-scoped message and a "Clear category" button', () => {
    // Mirrors the zero-result category state PackageGrid renders.
    const onClear = vi.fn();
    render(
      <PackageEmptyState
        title="No packages in Security yet"
        description="No packages match this category. Try another category or clear the filter."
        resetLabel="Clear category"
        onResetFilters={onClear}
      />
    );
    expect(screen.getByText('No packages in Security yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear category' })).toBeInTheDocument();
  });

  it('invokes the handler when the escape-hatch button is clicked', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<PackageEmptyState resetLabel="Clear category" onResetFilters={onClear} />);

    await user.click(screen.getByRole('button', { name: 'Clear category' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
