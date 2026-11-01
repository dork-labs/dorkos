/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ROOM_MENTION_COUNT_CAP } from '@dorkos/shared/room-schemas';
import { CountPill, MENTION_COUNT_CAP, formatPillCount } from '../count-pill';

afterEach(cleanup);

describe('formatPillCount', () => {
  it('spells a count up to 99 and caps anything above at 99+', () => {
    expect(formatPillCount(1)).toBe('1');
    expect(formatPillCount(99)).toBe('99');
    expect(formatPillCount(100)).toBe('99+');
  });

  it('takes a cap', () => {
    expect(formatPillCount(9, 9)).toBe('9');
    expect(formatPillCount(10, 9)).toBe('9+');
  });

  // The server's "10" means "10 or more", so the honest drawing is 9+.
  it('caps mentions one under where the server stops counting', () => {
    expect(MENTION_COUNT_CAP).toBe(ROOM_MENTION_COUNT_CAP - 1);
    expect(formatPillCount(ROOM_MENTION_COUNT_CAP, MENTION_COUNT_CAP)).toBe('9+');
  });
});

describe('CountPill', () => {
  it('draws nothing for zero', () => {
    const { container } = render(<CountPill count={0} label="0 mentions" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the real number out where it draws the cap', () => {
    render(<CountPill count={12} cap={MENTION_COUNT_CAP} label="More than 9 mentions" />);
    expect(screen.getByLabelText('More than 9 mentions')).toHaveTextContent('9+');
  });

  // Omitting the label means the parent's own name says the number.
  it('hides itself from a screen reader when it has no label', () => {
    const { container } = render(<CountPill count={3} />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
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
});
