// @vitest-environment jsdom
/**
 * The Getting-started swap under `prefers-reduced-motion` (BC-52).
 *
 * A file of its own with a `motion/react` mock of its own, because the global
 * one in `test-setup.ts` always answers "no preference" — the same reason
 * `ApprovalReceipt-reduced-motion.test.tsx` is its own file.
 *
 * The rest of this sidebar's reduced-motion contract suppresses things: the
 * welcome-back glow and the all-clear beat do not render at all. That is right
 * for a flourish about something that already happened, and wrong here. Damping
 * a swap is timing, not animation, and the operator who asked for less movement
 * is the last one who should be handed the undamped version — so this file
 * drives the same floor the main suite drives and expects the same answer.
 *
 * @module features/dashboard-sidebar/model/__tests__/use-getting-started-return-reduced-motion
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('motion/react', () => ({ useReducedMotion: () => true }));

import {
  ZONE_LABEL,
  type SidebarModel,
  type SidebarZoneId,
  type SidebarZoneModel,
} from '../build-sidebar-model';
import {
  GETTING_STARTED_RETURN_FLOOR_MS,
  useGettingStartedReturn,
} from '../holds/use-getting-started-return';

/** A zone reduced to what the swap reads: its id. */
function zone(id: SidebarZoneId): SidebarZoneModel {
  return { id, label: ZONE_LABEL[id], sections: [], reason: `zone:${id}` };
}

const SUGGESTIONS: SidebarModel = { zones: [zone('getting-started'), zone('today')] };
const SIGNAL: SidebarModel = { zones: [zone('now'), zone('today')] };

/** Whether the panel is currently drawing the Getting-started zone. */
function shows(model: SidebarModel): boolean {
  return model.zones.some((entry) => entry.id === 'getting-started');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('an operator who prefers reduced motion', () => {
  it('gets the same floor on the return, not a shortcut past it', () => {
    const { result, rerender } = renderHook(
      ({ model }: { model: SidebarModel }) => useGettingStartedReturn(model),
      { initialProps: { model: SUGGESTIONS } }
    );

    // The yield is still instant — precedence is not a preference.
    rerender({ model: SIGNAL });
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(1_000));
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS - 1_001));
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(shows(result.current.model)).toBe(true);
  });

  it('still has the return deferred by a pointer inside the panel', () => {
    const { result, rerender } = renderHook(
      ({ model }: { model: SidebarModel }) => useGettingStartedReturn(model),
      { initialProps: { model: SUGGESTIONS } }
    );
    rerender({ model: SIGNAL });
    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS + 1_000));

    act(() => result.current.handlers.onPointerEnter());
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(false);

    act(() => result.current.handlers.onPointerLeave());
    expect(shows(result.current.model)).toBe(true);
  });
});
