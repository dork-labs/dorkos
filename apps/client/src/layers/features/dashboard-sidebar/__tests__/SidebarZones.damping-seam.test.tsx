// @vitest-environment jsdom
/**
 * The wiring between BC-52's rule and the panel it governs.
 *
 * `use-getting-started-return.test.ts` proves the RULE: given a model, when may
 * the zone come back. It drives the hook directly, so it stays green whether or
 * not anything ever calls the hook, and green whether or not the hold's handlers
 * are attached to a real element. Deleting `{...slotHandlers}` from
 * `SidebarZones` left the whole client suite passing — the rule was covered and
 * the seam was not.
 *
 * So this file mounts the real `SidebarZones`, hands it real models, and fires
 * real DOM pointer events at the element the handlers are spread onto. Nothing
 * here reaches into the hook: the assertions are about which zones are in the
 * document, which is the only thing an operator can see.
 *
 * `pointerOver`/`pointerOut` rather than `pointerEnter`/`pointerLeave`, because
 * React synthesizes enter and leave from the two that bubble — dispatching the
 * non-bubbling pair directly is a test that passes against no handler at all.
 * The `relatedTarget` on the way out is load-bearing for the same reason: React
 * reads it to tell "left the element" from "moved around inside it".
 *
 * @module features/dashboard-sidebar/__tests__/SidebarZones.damping-seam
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

// A settled panel, so these cases are about what they are named after rather
// than about the boot gate. The gate's own behaviour is covered in
// `model/boot/__tests__` (spec `sidebar-simplification` D6).
vi.mock('../model/boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));

vi.mock('@/layers/entities/config', () => ({
  useUpdateSidebarPrefs: () => ({ update: vi.fn() }),
  setSectionCollapsed: (prefs: unknown) => prefs,
  setGroupCollapsed: (prefs: unknown) => prefs,
}));

import {
  ZONE_LABEL,
  type SidebarModel,
  type SidebarZoneId,
  type SidebarZoneModel,
} from '../model/build-sidebar-model';
import { GETTING_STARTED_RETURN_FLOOR_MS } from '../model/holds/use-getting-started-return';
import { SidebarZones } from '../ui/SidebarZones';

/** A zone reduced to what this file reads: whether it is on screen. */
function zone(id: SidebarZoneId): SidebarZoneModel {
  return { id, label: ZONE_LABEL[id], sections: [], reason: `zone:${id}` };
}

/** Day one, nothing happening. */
const SUGGESTIONS: SidebarModel = { zones: [zone('getting-started'), zone('library')] };
/** An agent starts a turn — the builder drops the suggestions. */
const SIGNAL: SidebarModel = { zones: [zone('now'), zone('library')] };

/** Whether the panel is drawing the Getting-started zone right now. */
function showing(): boolean {
  return document.querySelector('[data-sidebar-zone="getting-started"]') !== null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Mount the real panel, and hand back the element the hold's handlers sit on. */
function mount(model: SidebarModel) {
  const view = render(<SidebarZones model={model} />);
  // The wrapper `SidebarZones` spreads its handlers onto. Taken from the
  // rendered tree rather than by a test-only attribute, so the seam cannot be
  // satisfied by a marker nobody wired anything to.
  const wrapper = view.container.firstElementChild as HTMLElement;
  return { ...view, wrapper };
}

describe('the damping is actually wired to the panel (BC-52)', () => {
  it('withholds the zone through the floor and lets it back after', () => {
    const { rerender } = mount(SUGGESTIONS);
    expect(showing()).toBe(true);

    rerender(<SidebarZones model={SIGNAL} />);
    expect(showing()).toBe(false);

    act(() => vi.advanceTimersByTime(1_000));
    rerender(<SidebarZones model={SUGGESTIONS} />);
    expect(showing()).toBe(false);

    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS - 1_001));
    expect(showing()).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(showing()).toBe(true);
  });

  it('defers a due return while a pointer rests in the zone stack, and releases on the way out', () => {
    const { wrapper, rerender } = mount(SUGGESTIONS);

    rerender(<SidebarZones model={SIGNAL} />);
    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS + 1_000));

    // The operator's pointer arrives in the panel. The floor has already
    // expired, so anything keeping the zone away from here on is this event.
    fireEvent.pointerOver(wrapper);
    rerender(<SidebarZones model={SUGGESTIONS} />);
    expect(showing()).toBe(false);

    // And it stays away for as long as they are there — a seam that dropped the
    // handlers would have let it in on the frame above.
    act(() => vi.advanceTimersByTime(30_000));
    expect(showing()).toBe(false);

    fireEvent.pointerOut(wrapper, { relatedTarget: document.body });
    expect(showing()).toBe(true);
  });

  it('defers it for keyboard focus too, which arrives by a different event', () => {
    const { wrapper, rerender } = mount(SUGGESTIONS);

    rerender(<SidebarZones model={SIGNAL} />);
    act(() => vi.advanceTimersByTime(GETTING_STARTED_RETURN_FLOOR_MS + 1_000));

    fireEvent.focus(wrapper);
    rerender(<SidebarZones model={SUGGESTIONS} />);
    expect(showing()).toBe(false);

    fireEvent.blur(wrapper);
    expect(showing()).toBe(true);
  });
});

describe('SidebarZones — the lead slot when Heads up has no zone (DOR-1391)', () => {
  /** What the phone's lead slot hands down: cards for blockages it draws. */
  const CARDS = <div data-testid="lead-cards">Allow or deny</div>;

  it('draws the slot even while Getting started holds the zone above it', () => {
    // The 🔴: with every blockage covered by a card, Heads up emits no zone —
    // and a model that still had suggestions would put Getting started there.
    // Gating the slot on "is the slot taken" made the cards render nowhere at
    // all, which is a blocked agent invisible on the surface the phone exists
    // for. The slot is gated on Heads up's own absence instead.
    render(<SidebarZones model={SUGGESTIONS} nowSlot={CARDS} />);

    expect(document.querySelector('[data-testid="lead-cards"]')).not.toBeNull();
    // Drawn ABOVE, so the cards sit where Heads up would have been.
    const zones = Array.from(document.querySelectorAll('[data-sidebar-zone]')).map((el) =>
      el.getAttribute('data-sidebar-zone')
    );
    expect(zones[0]).toBe('now');
    expect(zones).toContain('getting-started');
  });

  it('does not draw a second Heads up when the model emitted one', () => {
    // The discriminating half: with a real Heads up zone the slot rides inside
    // it as a lead, and there is exactly one zone carrying the cards.
    render(<SidebarZones model={SIGNAL} nowSlot={CARDS} />);

    expect(document.querySelectorAll('[data-sidebar-zone="now"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="lead-cards"]')).not.toBeNull();
  });

  it('draws nothing extra when the slot has nothing to say', () => {
    render(<SidebarZones model={SUGGESTIONS} nowSlot={null} />);

    expect(document.querySelector('[data-sidebar-zone="now"]')).toBeNull();
    expect(document.querySelector('[data-testid="lead-cards"]')).toBeNull();
  });
});
