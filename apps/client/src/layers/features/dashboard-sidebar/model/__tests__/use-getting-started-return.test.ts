// @vitest-environment jsdom
/**
 * Getting started yields instantly and returns slowly (BC-52).
 *
 * The defect these cases are written against: a day-one operator with
 * suggestions still on screen saw the zone vanish and reappear on every turn
 * start and stop, moving Today about four rows each time. The precedence was
 * never in question — a real signal must have the slot — so every test here is
 * about the OTHER edge of the swap.
 *
 * Each "it did not come back" is paired with the same setup one variable later,
 * where it does: a hold that never releases and a hold that never engages look
 * identical from a single negative assertion.
 *
 * @module features/dashboard-sidebar/model/__tests__/use-getting-started-return
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
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

/** Day one, nothing happening: suggestions in the shared slot. */
const SUGGESTIONS: SidebarModel = { zones: [zone('getting-started'), zone('today')] };

/** An agent starts a turn: Heads up takes the slot, and the builder drops the suggestions. */
const SIGNAL: SidebarModel = { zones: [zone('now'), zone('today')] };

/** Whether the panel is currently drawing the Getting-started zone. */
function shows(model: SidebarModel): boolean {
  return model.zones.some((entry) => entry.id === 'getting-started');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Drive the hook from one model to another, the way the builder would. */
function driveFrom(initial: SidebarModel) {
  return renderHook(({ model }: { model: SidebarModel }) => useGettingStartedReturn(model), {
    initialProps: { model: initial },
  });
}

describe('the yield — a real signal takes the slot on the frame it appears', () => {
  it('drops Getting started immediately, handing the builder’s own model through', () => {
    const { result, rerender } = driveFrom(SUGGESTIONS);
    expect(shows(result.current.model)).toBe(true);

    // No `advanceTimersByTime` anywhere in this case, deliberately: if anything
    // in the damping had leaked onto the yield, the assertion below would need
    // one.
    rerender({ model: SIGNAL });
    expect(shows(result.current.model)).toBe(false);

    // **And the identity, which is what makes the instant yield structural
    // rather than a behaviour that has to keep being true.** The hook can only
    // ever SUBTRACT a zone from the model it was handed; it holds no copy of a
    // previous frame, so there is no mechanism by which a zone the builder has
    // stopped emitting could stay on screen. An implementation that damped both
    // directions — the obvious symmetric one, and the one this decision
    // rejects — would have to return a stale object here, and this is the
    // assertion that would catch it.
    expect(result.current.model).toBe(SIGNAL);
  });

  it('leaves the zone alone while the builder still wants it', () => {
    // The same hook, the same frames, one variable flipped: the model keeps
    // asking for Getting started, and nothing takes it away.
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(true);
  });
});

describe('the floor — the return waits, however early the signal clears', () => {
  it('holds the zone back until the floor, not until the signal clears', () => {
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SIGNAL });

    // A one-second turn: exactly the case that produced the flapping.
    act(() => vi.advanceTimersByTime(1_000));
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS - 1_001));
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(shows(result.current.model)).toBe(true);
  });

  it('never brings the zone back at all when the next turn starts inside the floor', () => {
    // The flap this exists to kill: out, in, out again. Damped, the "in" never
    // happens, so there is nothing to flap.
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SIGNAL });

    act(() => vi.advanceTimersByTime(1_000));
    rerender({ model: SUGGESTIONS });
    act(() => vi.advanceTimersByTime(2_000));
    rerender({ model: SIGNAL });
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(1_000));
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(false);

    // …and the deadline is still the one the first yield set, not a new one the
    // second turn started.
    act(() => vi.advanceTimersByTime(1_000));
    expect(shows(result.current.model)).toBe(true);
  });

  it('returns the instant the signal clears when the turn outlasted the floor', () => {
    // The floor is a floor, not a delay. A long turn has already paid it, and
    // an operator who waited a minute must not wait five more seconds.
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SIGNAL });

    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS + 1_000));
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(true);
  });

  it('shows a first appearance immediately, because nothing yielded', () => {
    // Opening the cockpit while a turn is running, then the turn ends. The zone
    // has never been on screen, so this is not a return and day one must not
    // start with five seconds of empty panel.
    const { result, rerender } = driveFrom(SIGNAL);
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(true);
  });
});

describe('the pointer — nothing comes back under a hand (BC-17’s promise)', () => {
  it('defers a due return while the pointer is inside, and lets it in on leave', () => {
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SIGNAL });
    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS + 1_000));

    act(() => result.current.handlers.onPointerEnter());
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(false);

    // And it stays away for as long as they are there — a floor that had merely
    // expired would have let it in by now.
    act(() => vi.advanceTimersByTime(30_000));
    expect(shows(result.current.model)).toBe(false);

    act(() => result.current.handlers.onPointerLeave());
    expect(shows(result.current.model)).toBe(true);
  });

  it('does the same for keyboard focus, which has no pointer to read', () => {
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SIGNAL });
    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS + 1_000));

    act(() => result.current.handlers.onFocus());
    rerender({ model: SUGGESTIONS });
    expect(shows(result.current.model)).toBe(false);

    act(() => result.current.handlers.onBlur());
    expect(shows(result.current.model)).toBe(true);
  });

  it('still owes the rest of the floor when the pointer leaves early', () => {
    // Waiting under the pointer counts as waiting: the clock runs from the
    // yield, so leaving does not restart it — but it does not skip it either.
    const { result, rerender } = driveFrom(SUGGESTIONS);
    rerender({ model: SIGNAL });

    act(() => result.current.handlers.onPointerEnter());
    act(() => vi.advanceTimersByTime(1_000));
    rerender({ model: SUGGESTIONS });
    act(() => result.current.handlers.onPointerLeave());
    expect(shows(result.current.model)).toBe(false);

    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS - 1_000));
    expect(shows(result.current.model)).toBe(true);
  });
});
