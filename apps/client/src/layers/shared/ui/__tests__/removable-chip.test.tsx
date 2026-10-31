/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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

  it('is a full-radius pill on the chip tint, with a 24px ×', () => {
    const { container } = render(
      <RemovableChip onRemove={() => {}} removeLabel="Remove it">
        Status: running
      </RemovableChip>
    );
    const chip = container.querySelector('[data-slot="removable-chip"]');
    expect(chip).toHaveClass('rounded-full', 'bg-foreground/7');
    const x = screen.getByRole('button', { name: 'Remove it' });
    expect(x).toHaveClass('size-6', 'focus-ring', 'max-md:w-11');
  });

  // Focus that falls to <body> loses a keyboard user's place in the page.
  it('moves focus to the next chip, then the previous, then the add control', async () => {
    const user = userEvent.setup();
    function Group() {
      const [items, setItems] = useState(['a', 'b', 'c']);
      return (
        <div>
          <div data-chip-group="">
            {items.map((item) => (
              <RemovableChip
                key={item}
                onRemove={() => setItems((all) => all.filter((x) => x !== item))}
                removeLabel={`Remove ${item}`}
              >
                {item}
              </RemovableChip>
            ))}
          </div>
          <button type="button" data-chip-group-add="">
            Add
          </button>
        </div>
      );
    }
    render(<Group />);

    await user.click(screen.getByRole('button', { name: 'Remove b' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove c' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Remove c' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove a' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Remove a' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus());
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
