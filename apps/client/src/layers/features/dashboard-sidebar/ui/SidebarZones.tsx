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
import { useCallback } from 'react';
import { useAgentCreationStore } from '@/layers/shared/model';
import {
  setGroupCollapsed,
  setSectionCollapsed,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import {
  librarySectionId,
  ZONE_LABEL,
  type SidebarModel,
  type SidebarZoneId,
  type SidebarZoneModel,
} from '../model/build-sidebar-model';
import { useAllClearBeat } from '../model/use-all-clear-beat';
import { AgentOnboardingCard } from './AgentOnboardingCard';
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
   * Now would be, and the day-one invitation only where Library would be.
   */
  zoneIds?: readonly SidebarZoneId[];
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
export function SidebarZones({ model, zoneIds }: SidebarZonesProps) {
  const { update } = useUpdateSidebarPrefs();
  const library = model.zones.find((zone) => zone.id === 'library');
  // "Is this zone mine to draw?" asked once. `undefined` means the whole
  // panel — the desktop case — so nothing about the existing call site changes.
  const draws = useCallback(
    (id: SidebarZoneId) => zoneIds === undefined || zoneIds.includes(id),
    [zoneIds]
  );

  const onToggleAll = useCallback(() => {
    const sections = library?.sections ?? [];
    if (sections.length === 0) return;
    // Fold everything unless everything is already folded, in which case the
    // gesture opens them: one key press, and it always does something.
    const collapsed = sections.some((section) => !section.collapsed);
    update((prev) => {
      let next = prev;
      for (const section of sections) {
        const stored = librarySectionId(section.id);
        if (stored !== null) next = setSectionCollapsed(next, stored, collapsed);
        for (const sub of section.subsections ?? []) {
          if (!sub.id.startsWith('group:')) continue;
          next = setGroupCollapsed(next, sub.id.slice('group:'.length), collapsed);
        }
      }
      return next;
    });
  }, [library, update]);

  // BC-50. Drawn before the map so the beat sits in Heads up's own slot at the top,
  // and suppressed the moment anything real wants that slot back — a zone the
  // model is emitting always wins over an animation about one it is not.
  const beating = useAllClearBeat(model);
  const nowSlotTaken = model.zones.some(
    (zone) => zone.id === 'now' || zone.id === 'getting-started'
  );

  return (
    <div className="flex flex-col gap-1">
      {beating && !nowSlotTaken && draws('now') && (
        <SidebarZone zone={ALL_CLEAR_ZONE} onToggleAll={onToggleAll} allClear />
      )}
      {model.zones
        .filter((zone) => draws(zone.id))
        .map((zone) =>
          // Today is the one zone whose rows react to where the operator's
          // pointer and focus are (BC-17, BC-36), so it gets a wrapper of its own.
          // Every other zone is the plain renderer.
          zone.id === 'today' ? (
            <TodayZone key={zone.id} zone={zone} onToggleAll={onToggleAll} />
          ) : (
            <SidebarZone key={zone.id} zone={zone} onToggleAll={onToggleAll} />
          )
        )}
      {/* "Is there anything at all yet?" — a presence check on the model, not a
          membership rule. Library is absent only when there is no agent, no room
          and no pin to put in it, which is the one moment the invitation belongs
          on screen. P2.2's Getting started zone takes this over. */}
      {library === undefined && draws('library') && (
        <AgentOnboardingCard onAddAgent={() => useAgentCreationStore.getState().open()} />
      )}
    </div>
  );
}
