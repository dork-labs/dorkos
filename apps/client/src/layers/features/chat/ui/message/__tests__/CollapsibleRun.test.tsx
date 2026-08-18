/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CollapsibleRun, COLLAPSE_THRESHOLD, VISIBLE_COUNT } from '../CollapsibleRun';

/** A run of `n` numbered blocks, so an assertion can name which ones are on screen. */
function blocks(n: number) {
  return Array.from({ length: n }, (_, i) => (
    <div key={i} data-testid={`step-${i}`}>
      step {i}
    </div>
  ));
}

describe('CollapsibleRun', () => {
  afterEach(cleanup);

  it('renders a run at the threshold in full, with no collapse control', () => {
    render(<CollapsibleRun>{blocks(COLLAPSE_THRESHOLD)}</CollapsibleRun>);
    for (let i = 0; i < COLLAPSE_THRESHOLD; i++) {
      expect(screen.getByTestId(`step-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('collapses a longer run to the visible count and says how many it hid', () => {
    const total = COLLAPSE_THRESHOLD + 3;
    render(<CollapsibleRun>{blocks(total)}</CollapsibleRun>);
    for (let i = 0; i < VISIBLE_COUNT; i++) {
      expect(screen.getByTestId(`step-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId(`step-${VISIBLE_COUNT}`)).not.toBeInTheDocument();
    // The number is knowable, so it is asserted exactly.
    expect(screen.getByRole('button')).toHaveTextContent(`and ${total - VISIBLE_COUNT} more steps`);
  });

  it('is a real expand control: collapsed state is announced, and the click reveals every step', () => {
    const total = COLLAPSE_THRESHOLD + 1;
    render(<CollapsibleRun>{blocks(total)}</CollapsibleRun>);
    const control = screen.getByRole('button', {
      name: `Show ${total - VISIBLE_COUNT} more steps`,
    });
    // Seeded defect: pass `hideChevron` to the card again → `aria-expanded` is
    // dropped and this assertion goes red.
    expect(control).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(control);

    for (let i = 0; i < total; i++) {
      expect(screen.getByTestId(`step-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
