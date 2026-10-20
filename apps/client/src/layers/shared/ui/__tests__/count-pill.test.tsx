/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CountPill, formatPillCount } from '../count-pill';

afterEach(cleanup);

describe('CountPill', () => {
  it('spells a count up to nine and caps anything above at 9+', () => {
    expect(formatPillCount(1)).toBe('1');
    expect(formatPillCount(9)).toBe('9');
    expect(formatPillCount(10)).toBe('9+');
    expect(formatPillCount(240)).toBe('9+');
  });

  it('reads the real number out where it draws the cap', () => {
    render(<CountPill count={12} label="12 mentions" />);
    expect(screen.getByLabelText('12 mentions')).toHaveTextContent('9+');
  });

  it('wears neutral ink on a neutral tint', () => {
    render(<CountPill count={2} label="2 mentions" />);
    const pill = screen.getByLabelText('2 mentions');
    expect(pill).toHaveClass('bg-foreground/10', 'text-foreground');
    expect(pill.className).not.toMatch(/brand|warning|primary/);
  });
});
