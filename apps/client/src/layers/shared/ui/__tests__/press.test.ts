/**
 * `press.ts`'s own card/row/mark ladder has three stops and the numbers are
 * the design system's, not an author's taste. Before it existed the codebase
 * held nine of them (0.85, 0.90, 0.93, 0.94, 0.95, 0.97, 0.98, 0.99) across two
 * mechanisms — DOR-1751. `Button`'s own `0.97` and the other named exceptions
 * intentionally sit outside this ladder; see `press.ts`'s module doc.
 */
import { describe, it, expect } from 'vitest';
import { PRESS_CARD, PRESS_MARK, PRESS_ROW } from '../press';

describe('press ladder', () => {
  it('scales by target size, using the three documented values', () => {
    expect(PRESS_CARD).toContain('motion-safe:active:scale-[0.99]');
    expect(PRESS_ROW).toContain('motion-safe:active:scale-[0.98]');
    expect(PRESS_MARK).toContain('motion-safe:active:scale-[0.94]');
  });

  it('lands the press in 80ms and lets the release ride the slower answer back up', () => {
    for (const stop of [PRESS_CARD, PRESS_ROW, PRESS_MARK]) {
      expect(stop).toContain('motion-safe:duration-(--identity-answer)');
      expect(stop).toContain('motion-safe:active:duration-(--identity-press)');
    }
  });

  it('names `scale` in the transition, which is the property Tailwind writes', () => {
    // An arbitrary list that spells `transform` literally transitions nothing
    // here: Tailwind v4's scale utilities write the standalone `scale`
    // property, not `transform`. `shared/ui/sidebar.tsx`'s
    // `transition-[width,height,padding,background-color,color,transform]`
    // had exactly that bug before it moved onto this ladder — measured against
    // the compiled stylesheet, `motion-safe:transition-transform` (the NAMED
    // utility `EntryActionMenu.tsx` and `EntryReactionPicker.tsx` used before
    // their own migration) already expands to `transform, translate, scale,
    // rotate` and was never actually broken.
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
