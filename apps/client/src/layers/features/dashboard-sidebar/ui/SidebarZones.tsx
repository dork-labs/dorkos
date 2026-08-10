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
import { librarySectionId, type SidebarModel } from '../model/build-sidebar-model';
import { AgentOnboardingCard } from './AgentOnboardingCard';
import { SidebarZone } from './SidebarZone';

/** Props for {@link SidebarZones}. */
export interface SidebarZonesProps {
  /** The model to draw. */
  model: SidebarModel;
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
export function SidebarZones({ model }: SidebarZonesProps) {
  const { update } = useUpdateSidebarPrefs();
  const library = model.zones.find((zone) => zone.id === 'library');

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

  return (
    <div className="flex flex-col gap-1">
      {model.zones.map((zone) => (
        <SidebarZone key={zone.id} zone={zone} onToggleAll={onToggleAll} />
      ))}
      {/* "Is there anything at all yet?" — a presence check on the model, not a
          membership rule. Library is absent only when there is no agent, no room
          and no pin to put in it, which is the one moment the invitation belongs
          on screen. P2.2's Getting started zone takes this over. */}
      {library === undefined && (
        <AgentOnboardingCard onAddAgent={() => useAgentCreationStore.getState().open()} />
      )}
    </div>
  );
}
