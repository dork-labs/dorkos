/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { RemovableChip } from '../removable-chip';
import { Spinner } from '../spinner';

afterEach(cleanup);

describe('RemovableChip', () => {
  it('shows what it says and drops itself when the X is pressed', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <RemovableChip onRemove={onRemove} removeLabel="Remove agent filter">
        code-reviewer
      </RemovableChip>
    );
    expect(screen.getByText('code-reviewer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove agent filter' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  // It composes `Badge`'s pill rather than redrawing one, which is the whole
  // reason it exists — two chips drawn by hand were two pill geometries.
  it('is a badge wearing the pill shape', () => {
    const { container } = render(
      <RemovableChip onRemove={() => {}} removeLabel="Remove it">
        Status: running
      </RemovableChip>
    );
    const chip = container.querySelector('[data-slot="removable-chip"]');
    expect(chip).toHaveClass('rounded-full');
  });
});

describe('Spinner', () => {
  // A decorative spinner beside the word "Loading" read aloud as an unlabelled
  // image is the exact defect this default exists to prevent.
  it('hides itself from screen readers unless it has something to say', () => {
    const { container } = render(<Spinner />);
    const spinner = container.querySelector('[data-slot="spinner"]');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).not.toHaveAttribute('role');
  });

  it('announces itself when it is the only sign of life', () => {
    render(<Spinner label="Loading agents" />);
    const spinner = screen.getByRole('status', { name: 'Loading agents' });
    expect(spinner).not.toHaveAttribute('aria-hidden');
  });

  it('sizes from the shared icon scale', () => {
    const { container } = render(<Spinner size="xs" />);
    expect(container.querySelector('[data-slot="spinner"]')).toHaveClass('size-(--size-icon-xs)');
  });
});
