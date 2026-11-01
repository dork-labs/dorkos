/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CountPill, CORNER_COUNT_CAP, COUNT_PILL_CAP, formatPillCount } from '../count-pill.js';

afterEach(cleanup);

describe('formatPillCount', () => {
  it('spells a count up to 99 and caps anything above at 99+', () => {
    expect(COUNT_PILL_CAP).toBe(99);
    expect(formatPillCount(1)).toBe('1');
    expect(formatPillCount(99)).toBe('99');
    expect(formatPillCount(100)).toBe('99+');
  });

  it('takes a cap', () => {
    expect(formatPillCount(9, CORNER_COUNT_CAP)).toBe('9');
    expect(formatPillCount(10, CORNER_COUNT_CAP)).toBe('9+');
  });
});

describe('CountPill', () => {
  it('draws nothing for zero', () => {
    const { container } = render(<CountPill count={0} label="0 mentions" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the real number out where it draws the cap', () => {
    render(<CountPill count={12} cap={9} label="More than 9 mentions" />);
    expect(screen.getByLabelText('More than 9 mentions')).toHaveTextContent('9+');
  });

  // The label is the whole accessible name; the drawn digit is not read twice.
  it('takes its accessible name from the label', () => {
    const { container } = render(<CountPill count={3} label="3 flagged" />);
    const pill = container.querySelector('[data-slot="count-pill"]');
    expect(pill).toHaveAccessibleName('3 flagged');
    expect(pill).not.toHaveAttribute('aria-hidden');
  });

  // Omitting the label means the parent's own name says the number.
  it('hides itself from a screen reader when it has no label', () => {
    const { container } = render(<CountPill count={3} />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstChild).not.toHaveAttribute('aria-label');
  });

  it('wears the orange ink on its own orange wash by default, because it is for you', () => {
    render(<CountPill count={2} label="2 mentions" />);
    const pill = screen.getByLabelText('2 mentions');
    expect(pill).toHaveAttribute('data-tone', 'you');
    expect(pill).toHaveClass('bg-brand/15', 'text-brand-text', 'rounded-full', 'tabular-nums');
  });

  it.each([
    ['warning', 'bg-status-warning-bg', 'bg-status-warning-fg'],
    ['error', 'bg-status-error-bg', 'bg-status-error-fg'],
    ['neutral', 'bg-foreground/10', 'bg-foreground'],
    ['you', 'bg-brand/15', 'bg-brand-text'],
  ] as const)('a %s count has a wash and a solid fill', (tone, wash, solid) => {
    const { rerender } = render(<CountPill count={1} tone={tone} label="one" />);
    expect(screen.getByLabelText('one')).toHaveClass(wash);
    rerender(<CountPill count={1} tone={tone} solid label="one" />);
    const pill = screen.getByLabelText('one');
    expect(pill).toHaveClass(solid, 'text-background');
  });

  it('sits in a control corner solid, out of flow, and caps at 9+', () => {
    render(<CountPill count={14} tone="warning" placement="corner" label="14 waiting" />);
    const pill = screen.getByLabelText('14 waiting');
    expect(pill).toHaveTextContent('9+');
    expect(pill).toHaveClass('absolute', 'pointer-events-none', 'bg-status-warning-fg');
    expect(pill).toHaveAttribute('data-placement', 'corner');
  });

  it('lets a caller class win a conflict', () => {
    render(<CountPill count={1} label="one" className="px-2" />);
    const pill = screen.getByLabelText('one');
    expect(pill).toHaveClass('px-2');
    expect(pill).not.toHaveClass('px-1.5');
  });
});
