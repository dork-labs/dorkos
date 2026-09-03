/**
 * The press ladder has three stops and the numbers are the design system's, not
 * an author's taste. Before it existed the codebase held nine of them (0.85,
 * 0.90, 0.93, 0.94, 0.95, 0.97, 0.98, 0.99) across two mechanisms — DOR-1751.
 */
import { describe, it, expect } from 'vitest';
import { PRESS_CARD, PRESS_MARK, PRESS_ROW } from '../press';

describe('press ladder', () => {
  it('scales by target size, using the three documented values', () => {
    expect(PRESS_CARD).toContain('motion-safe:active:scale-[0.99]');
    expect(PRESS_ROW).toContain('motion-safe:active:scale-[0.98]');
    expect(PRESS_MARK).toContain('motion-safe:active:scale-[0.94]');
  });

  it('is three stops, never two that happen to look different', () => {
    const scale = (stop: string) => stop.match(/active:scale-\[([\d.]+)\]/)?.[1];
    expect(new Set([scale(PRESS_CARD), scale(PRESS_ROW), scale(PRESS_MARK)]).size).toBe(3);
  });

  it('lands the press in 80ms and lets the release ride the slower answer back up', () => {
    for (const stop of [PRESS_CARD, PRESS_ROW, PRESS_MARK]) {
      expect(stop).toContain('motion-safe:duration-(--identity-answer)');
      expect(stop).toContain('motion-safe:active:duration-(--identity-press)');
    }
  });

  it('names `scale` in the transition, which is the property Tailwind writes', () => {
    // A list saying `transform` transitions nothing here: Tailwind v4's scale
    // utilities write the standalone `scale` property. Two shipped call sites
    // had exactly that bug before they moved onto this ladder.
    for (const stop of [PRESS_CARD, PRESS_ROW, PRESS_MARK]) {
      expect(stop).toContain('scale]');
    }
  });

  it('carries the colour properties too, so a press class is a control’s only transition', () => {
    // One element, one `transition-property` list: a row that kept its own
    // `transition-colors` beside a press class would silently lose one of them.
    for (const stop of [PRESS_CARD, PRESS_ROW, PRESS_MARK]) {
      expect(stop).toContain('color,background-color,border-color');
    }
  });
});
