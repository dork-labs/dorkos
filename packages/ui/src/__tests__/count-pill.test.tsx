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
    expect(pill).toHaveClass(
      'bg-dui-brand/15',
      'text-dui-brand-text',
      'rounded-full',
      'tabular-nums'
    );
  });

  it.each([
    ['warning', 'bg-dui-status-warning-bg', 'bg-dui-status-warning-fg'],
    ['error', 'bg-dui-status-error-bg', 'bg-dui-status-error-fg'],
    ['neutral', 'bg-dui-foreground/10', 'bg-dui-foreground'],
    ['you', 'bg-dui-brand/15', 'bg-dui-brand-text'],
  ] as const)('a %s count has a wash and a solid fill', (tone, wash, solid) => {
    const { rerender } = render(<CountPill count={1} tone={tone} label="one" />);
    expect(screen.getByLabelText('one')).toHaveClass(wash);
    rerender(<CountPill count={1} tone={tone} solid label="one" />);
    const pill = screen.getByLabelText('one');
    expect(pill).toHaveClass(solid, 'text-dui-background');
  });

  it('sits in a control corner solid, out of flow, and caps at 9+', () => {
    render(<CountPill count={14} tone="warning" placement="corner" label="14 waiting" />);
    const pill = screen.getByLabelText('14 waiting');
    expect(pill).toHaveTextContent('9+');
    expect(pill).toHaveClass('absolute', 'pointer-events-none', 'bg-dui-status-warning-fg');
    expect(pill).toHaveAttribute('data-placement', 'corner');
  });

  // Read as a colour, text-dui-2xs would knock out the ink beside it, or the ink the size.
  it('keeps its size and its ink side by side', () => {
    render(<CountPill count={1} label="one" />);
    expect(screen.getByLabelText('one')).toHaveClass('text-dui-2xs', 'text-dui-brand-text');
    cleanup();
    render(<CountPill count={1} label="one" placement="corner" />);
    expect(screen.getByLabelText('one')).toHaveClass('text-dui-3xs', 'text-dui-background');
  });

  // A Space has only the package's tokens, so the pill may draw from nothing else.
  it.each(['you', 'warning', 'error', 'neutral'] as const)(
    'a %s pill names only dui colours',
    (tone) => {
      for (const solid of [false, true]) {
        render(<CountPill count={1} tone={tone} solid={solid} label="one" />);
        const colours = screen
          .getByLabelText('one')
          .className.split(/\s+/)
          .filter((c) => /^(?:bg|text)-/.test(c) && !/^text-(?:center|dui-[23]xs)$/.test(c));
        expect(colours.length).toBeGreaterThan(0);
        for (const c of colours) expect(c).toMatch(/^(?:bg|text)-dui-/);
        cleanup();
      }
    }
  );

  it("lets an app's own size replace the pill's", () => {
    render(<CountPill count={1} label="one" className="text-xs" />);
    const pill = screen.getByLabelText('one');
    expect(pill).toHaveClass('text-xs', 'text-dui-brand-text');
    expect(pill).not.toHaveClass('text-dui-2xs');
  });

  it('lets a caller class win a conflict', () => {
    render(<CountPill count={1} label="one" className="px-2" />);
    const pill = screen.getByLabelText('one');
    expect(pill).toHaveClass('px-2');
    expect(pill).not.toHaveClass('px-1.5');
  });
});
