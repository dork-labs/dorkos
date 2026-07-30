// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LoudnessMeter } from '../ui/LoudnessMeter';
import type { LoudnessLevel } from '../lib/loudness';

/**
 * The bars, and which of them are lit.
 *
 * Reading the lit class is the ONE thing jsdom can see here: it reports every
 * element as 0 × 0, so the ascending heights, the sizes and the colours
 * themselves are settled in a real browser and not asserted here. What this can
 * still catch is the off-by-one — a meter lighting one bar too many says the
 * agent is louder than it is, on every row at once.
 */
function bars(container: HTMLElement): { total: number; lit: number } {
  const all = container.querySelectorAll('[data-slot="loudness-meter"] > span');
  return {
    total: all.length,
    lit: [...all].filter((bar) => bar.className.includes('bg-brand')).length,
  };
}

afterEach(cleanup);

describe('LoudnessMeter', () => {
  it.each([0, 1, 2, 3, 4] as LoudnessLevel[])('lights exactly %i of four bars', (level) => {
    const { container } = render(<LoudnessMeter level={level} />);

    expect(bars(container)).toEqual({ total: 4, lit: level });
  });

  it('keeps a dormant meter at the same position, in grey', () => {
    // An archived room triggers nobody, so brand-coloured bars claim a setting
    // that is in effect. Going UNLIT would be the opposite lie — the rung is
    // still stored and still what the agent does the moment the room is back.
    // Red if `dormant` starts changing how many bars are lit, or stops changing
    // what they are painted with.
    const { container } = render(<LoudnessMeter level={3} dormant />);

    expect(bars(container)).toEqual({ total: 4, lit: 0 });
    expect(
      container.querySelectorAll('[data-slot="loudness-meter"] > span.bg-muted-foreground\\/60')
    ).toHaveLength(3);
  });

  it('says nothing to a screen reader', () => {
    // Every place this is drawn has the words beside it. A meter announcing
    // "3 of 4" next to a label reading `Engaged` is the same fact twice.
    const { container } = render(<LoudnessMeter level={3} />);

    expect(container.querySelector('[data-slot="loudness-meter"]')).toHaveAttribute('aria-hidden');
  });
});
