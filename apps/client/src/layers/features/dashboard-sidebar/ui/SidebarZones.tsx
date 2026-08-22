/**
 * The zones, in the order the model put them in.
 *
 * This component is the whole "renderer" half of the redesign: it maps
 * `model.zones` and nothing else. Zone order is fixed by `buildSidebarModel`
 * (BC-3) and never varies with content, so there is no sorting here to get
 * wrong.
 *
 * @module features/dashboard-sidebar/ui/SidebarZones
 */
import { useCallback, type ReactNode } from 'react';
import {
  setGroupCollapsed,
  setSectionCollapsed,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import {
  persistedSectionId,
  ZONE_LABEL,
  type SidebarModel,
  type SidebarSectionModel,
  type SidebarZoneId,
  type SidebarZoneModel,
} from '../model/build-sidebar-model';
import { useAllClearBeat } from '../model/use-all-clear-beat';
import { useGettingStartedReturn } from '../model/holds/use-getting-started-return';
import { SidebarZone } from './SidebarZone';
import { TodayZone } from './TodayZone';

/**
 * The zone the all-clear beat draws in, once the model has stopped emitting one.
 *
 * A constant rather than a synthesized object, so it never changes identity and
 * the beat cannot be restarted by a re-render. It carries no `liveRegionText`:
 * the count went to zero, and the region clearing is the whole of what a screen
 * reader should get (BC-11).
 */
const ALL_CLEAR_ZONE: SidebarZoneModel = {
  id: 'now',
  label: ZONE_LABEL.now,
  sections: [],
  reason: 'zone:now',
};

/**
 * Whether a section is one the fold-all gesture may touch.
 *
 * `collapsible` alone is not enough: Getting started has no persisted key, so
 * folding it would last exactly until the next render. A hand-made section HAS
 * one — its fold lives on the section itself rather than under a section id —
 * which is why it is named here rather than reached through
 * {@link persistedSectionId}.
 *
 * @param section - Any section the model emitted.
 */
function isFoldable(section: SidebarSectionModel): boolean {
  if (!section.collapsible) return false;
  return section.id.startsWith('group:') || persistedSectionId(section.id) !== null;
}

/** Props for {@link SidebarZones}. */
export interface SidebarZonesProps {
  /** The model to draw. */
  model: SidebarModel;
  /**
   * Which zones to draw. Omitted = all of them, which is the desktop panel.
   *
   * Mobile splits one model across two tabs — Now and Today into Home, Library
   * into its own tab (P4) — and this is how, so both tabs are the same renderer
   * reading the same build rather than a second copy of it. The two beats that
   * belong to a particular zone travel with it: the all-clear plays only where
   * Now would be.
   */
  zoneIds?: readonly SidebarZoneId[];
  /**
   * Content to draw at the top of Now, above its rows, or `null` for none.
   *
   * **The phone's inline approvals arrive here** (P4 AC-5). They are a
   * composition of `features/approvals`, which this feature may not import —
   * `shared ← entities ← features ← widgets` — so the widget that owns the
   * mobile Home tab builds them and hands them down.
   *
   * **A non-null slot can bring Now into existence**, and that is the whole
   * reason it is `ReactNode | null` rather than "render it if you like". Now is
   * absent from the model when nothing needs the operator (BC-1) — and the one
   * state where the operator most needs to hear from this slot is exactly that
   * one: approvals failed to load, so no approval became an attention row, so
   * there is no Now zone to put the failure in. An approval nobody is shown is
   * an agent sitting blocked. So the caller passes `null` when it has nothing
   * to say, and anything else gets a zone.
   */
  nowSlot?: ReactNode | null;
  /**
   * Something above these zones announces Now's count, so no zone drawn here
   * may. See {@link SidebarZoneProps.silenceLiveRegion} — the phone cockpit is
   * the one caller, and its reason is that these panels are `inert` whenever
   * they are put away.
   */
  silenceLiveRegion?: boolean;
}

/**
 * Every zone the model emitted, in its fixed order.
 *
 * It also owns the one cross-section act there is: Alt/Option-click on any
 * Library header folds or unfolds them all (BC-30). That has to live above the
 * sections, because "are any of them open?" is a question no single section can
 * answer.
 *
 * @param props - The model.
 */
export function SidebarZones({
  model,
  zoneIds,
  nowSlot = null,
  silenceLiveRegion = false,
}: SidebarZonesProps) {
  const { update } = useUpdateSidebarPrefs();
  // Getting started leaves the shared slot the frame a real signal wants it and
  // takes a few seconds to come back (BC-52). Everything below draws `drawn`;
  // `model` is still the builder's answer, and the two differ on exactly one
  // zone for exactly as long as the damping lasts.
  const { model: drawn, handlers: slotHandlers } = useGettingStartedReturn(model);
  // Off the BUILDER's model, like `nowSlotTaken` below. Reading it from `drawn`
  // would make a whole-panel gesture a function of whether a zone above it
  // happened to be held back by the Getting-started damping at that instant.
  //
  // **Every zone, not just Library** (D1). Alt-click used to fold Library's four
  // sections and leave Heads up and Today standing, because those two could not
  // fold at all; now that every header does, "fold everything" means everything.
  const foldable = model.zones.flatMap((zone) => zone.sections).filter(isFoldable);
  // "Is this zone mine to draw?" asked once. `undefined` means the whole
  // panel — the desktop case — so nothing about the existing call site changes.
  const draws = useCallback(
    (id: SidebarZoneId) => zoneIds === undefined || zoneIds.includes(id),
    [zoneIds]
  );

  const onToggleAll = useCallback(() => {
    if (foldable.length === 0) return;
    // Fold everything unless everything is already folded, in which case the
    // gesture opens them: one key press, and it always does something.
    const collapsed = foldable.some((section) => !section.collapsed);
    update((prev) => {
      let next = prev;
      for (const section of foldable) {
        // A hand-made section's fold lives on the section itself; every other
        // section's lives under its id in `ui.sidebar.sections`. Both are in
        // this one list now that sections render as peers (D3) — the walk used
        // to have to descend into `subsections` to reach them.
        if (section.id.startsWith('group:')) {
          next = setGroupCollapsed(next, section.id.slice('group:'.length), collapsed);
          continue;
        }
        const stored = persistedSectionId(section.id);
        if (stored !== null) next = setSectionCollapsed(next, stored, collapsed);
      }
      return next;
    });
  }, [foldable, update]);

  // BC-50. Drawn before the map so the beat sits in Heads up's own slot at the top,
  // and suppressed the moment anything real wants that slot back — a zone the
  // model is emitting always wins over an animation about one it is not.
  const beating = useAllClearBeat(model);
  // Asked of the BUILDER's model, not the damped one. Withholding Getting
  // started for a few seconds is not an invitation for an animation to move
  // into the space it just left: the slot is spoken for either way, and the
  // beat stays exactly as rare as BC-50 made it.
  const hasNowZone = model.zones.some((zone) => zone.id === 'now');
  const nowSlotTaken = hasNowZone || model.zones.some((zone) => zone.id === 'getting-started');
  // The slot brings its own zone when Heads up has none — and **Getting started
  // holding the slot is not a reason to withhold it** (DOR-1391). Two states
  // reach here and both are ones a person must see: the loud-failure case
  // (approvals could not be read, so none became a row, so there is no zone to
  // say so in), and the phone's covered queue (every blockage IS drawn, as a
  // card, so the model emitted no rows for them). Gating this on Getting
  // started too made the second one invisible: a blocked agent behind a
  // day-one suggestion list, on the surface the phone exists for.
  //
  // It draws ABOVE the zone map, so the cards sit where Heads up would have
  // been rather than under whatever took its place. It also outranks the beat —
  // an animation about work that finished must not be what the panel says while
  // something is still waiting.
  const orphanedSlot = nowSlot !== null && !hasNowZone && draws('now');

  return (
    // The damping's "not under a hand" half reads the pointer and focus here,
    // one element above every zone — the smallest wrapper that contains
    // everything the returning zone would push down, and therefore the right
    // boundary for a promise about not moving what somebody is aiming at.
    <div className="flex flex-col gap-1" {...slotHandlers}>
      {orphanedSlot && (
        <SidebarZone
          zone={ALL_CLEAR_ZONE}
          onToggleAll={onToggleAll}
          lead={nowSlot}
          silenceLiveRegion={silenceLiveRegion}
        />
      )}
      {beating && !nowSlotTaken && !orphanedSlot && draws('now') && (
        <SidebarZone
          zone={ALL_CLEAR_ZONE}
          onToggleAll={onToggleAll}
          allClear
          silenceLiveRegion={silenceLiveRegion}
        />
      )}
      {drawn.zones
        .filter((zone) => draws(zone.id))
        .map((zone) =>
          // Today is the one zone whose rows react to where the operator's
          // pointer and focus are (BC-17, BC-36), so it gets a wrapper of its own.
          // Every other zone is the plain renderer.
          zone.id === 'today' ? (
            <TodayZone
              key={zone.id}
              zone={zone}
              onToggleAll={onToggleAll}
              silenceLiveRegion={silenceLiveRegion}
            />
          ) : (
            <SidebarZone
              key={zone.id}
              zone={zone}
              onToggleAll={onToggleAll}
              silenceLiveRegion={silenceLiveRegion}
              {...(zone.id === 'now' ? { lead: nowSlot } : {})}
            />
          )
        )}
      {/* There is no empty-Library branch on purpose. `AgentOnboardingCard` used
          to hang off `library === undefined`, and that condition is reachable —
          but only in the wrong moment. `useSidebarState` starts the roster at
          `[]` and "a roster query that has not answered looks exactly like an
          empty fleet" (its own words), so on every cold load the card drew for
          the pre-hydration frames, and it would have stayed for good if the mesh
          query failed. A hydration gap is not day one, and a flash of "Add more
          agents" is the wrong thing to put in one. Day-one guidance is the
          Getting started zone's, at the top of the panel where it is read. */}
    </div>
  );
}
