/**
 * The continuity layer's numbers, asserted as numbers (spec D5).
 *
 * **This is the only place the reduced-motion promise CAN be settled.** jsdom
 * runs no animation and measures every element as 0×0, so a test that rendered a
 * folded section and found its rows gone would pass whether the spring lasted
 * 0 ms or two seconds. What is checkable is the value the component hands
 * `motion`, and that is what this file reads.
 */
import { describe, expect, it } from 'vitest';
import { buildSidebarModel } from '../../../model/build-sidebar-model';
import { powerFixture } from '../../../model/fixtures';
import {
  ARRIVED_TINT_MS,
  ARRIVE_RISE_PX,
  ARRIVE_SECONDS,
  DRAG_LIFT_SCALE,
  DRAG_LIFT_SECONDS,
  FOLD_DAMPING,
  FOLD_STIFFNESS,
  LAYOUT_KEY_SEPARATOR,
  LEAVE_SECONDS,
  arriveTransition,
  foldTransition,
  leaveTransition,
  sectionLayoutKey,
} from '../sidebar-motion';

/** D5's ceiling for everything except the fold spring, in seconds. */
const BUDGET_SECONDS = 0.2;

describe('reduced motion', () => {
  it('is instant, not merely quick', () => {
    // Zero, not a smaller number: the preference means no animation. Red the
    // moment somebody "respects" it by halving a duration instead.
    expect(foldTransition(true)).toEqual({ duration: 0 });
    expect(arriveTransition(true)).toEqual({ duration: 0 });
    expect(leaveTransition(true)).toEqual({ duration: 0 });
  });

  it('treats "not asked yet" as no preference', () => {
    // `useReducedMotion` answers `null` before it has read the media query, and
    // a `null` that suppressed the animation would make every first paint after
    // a route change silently motionless.
    expect(arriveTransition(null)).toEqual({ duration: ARRIVE_SECONDS });
    expect(foldTransition(null)).toMatchObject({ type: 'spring' });
  });
});

describe('the budget', () => {
  it('keeps every added animation at or under 200 ms except the fold spring', () => {
    expect(ARRIVE_SECONDS).toBeLessThanOrEqual(BUDGET_SECONDS);
    expect(LEAVE_SECONDS).toBeLessThanOrEqual(BUDGET_SECONDS);
    expect(DRAG_LIFT_SECONDS).toBeLessThanOrEqual(BUDGET_SECONDS);
    expect(ARRIVED_TINT_MS).toBeLessThanOrEqual(BUDGET_SECONDS * 1000);
  });

  it('folds with the spring D5 specified', () => {
    expect(FOLD_STIFFNESS).toBe(400);
    expect(FOLD_DAMPING).toBe(36);
    expect(foldTransition(false)).toEqual({
      type: 'spring',
      stiffness: FOLD_STIFFNESS,
      damping: FOLD_DAMPING,
    });
  });

  it('lifts a dragged row by 2% and no more', () => {
    // A drag that scaled further would stop reading as the row and start
    // reading as a card about the row.
    expect(DRAG_LIFT_SCALE).toBe(1.02);
  });

  it('drops a row in from above, never from the side', () => {
    // Negative: a row falls from its header. A positive rise would have it come
    // up from under the row below it, which is where nothing came from.
    expect(ARRIVE_RISE_PX).toBeGreaterThan(0);
    expect(arriveTransition(false)).toEqual({ duration: ARRIVE_SECONDS });
  });
});

describe('sectionLayoutKey', () => {
  it('is the section’s row ids, in order', () => {
    const sep = LAYOUT_KEY_SEPARATOR;
    expect(sectionLayoutKey([{ key: 'a' }, { key: 'b' }])).toBe(`a${sep}b`);
    // Order is the point: two sections holding the same rows in different
    // orders must not share a key, or a reorder would not re-measure.
    expect(sectionLayoutKey([{ key: 'b' }, { key: 'a' }])).toBe(`b${sep}a`);
  });

  it('separates on something a row key cannot contain', () => {
    // Row keys are built from titles and paths. A space or a comma as the
    // separator would let one row with a space in its key read back as two —
    // and `useArrivedRows` splits this string to answer "have I seen this row
    // before", so a false split is a false arrival.
    const spaced = sectionLayoutKey([{ key: 'room:general chat' }, { key: 'agent:/a' }]);
    expect(spaced.split(LAYOUT_KEY_SEPARATOR)).toEqual(['room:general chat', 'agent:/a']);
  });

  it('does not move when only the clock does', () => {
    // The 60 s tick: `useSidebarState` rebuilds the whole model every minute so
    // relative times stay honest. Every row's FLIP measures against this string,
    // so if the tick moved it, thirty rows would re-measure once a minute for a
    // change that moved nothing. Red if the key ever starts carrying a label, a
    // preview or a timestamp.
    const before = buildSidebarModel(powerFixture);
    const after = buildSidebarModel({ ...powerFixture, now: powerFixture.now + 60_000 });

    const keys = (model: ReturnType<typeof buildSidebarModel>) =>
      model.zones.flatMap((zone) =>
        zone.sections.map((section) => `${section.id}=${sectionLayoutKey(section.rows)}`)
      );

    // The fixture has to be a real panel, or "nothing changed" is a claim about
    // an empty list.
    expect(keys(before).length).toBeGreaterThan(2);
    expect(keys(after)).toEqual(keys(before));
  });
});
