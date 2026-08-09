import { useMemo } from 'react';
import { Bot } from 'lucide-react';
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import { SectionHeader, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import { useAgentCreationStore, useRovingFocus } from '@/layers/shared/model';
import {
  useUpdateSidebarPrefs,
  setUngroupedSortMode,
  setUngroupedDisplayFilter,
} from '@/layers/entities/config';
import { AddAgentMenu } from './AddAgentMenu';
import { buildAgentsHeaderMenuNodes } from './SectionHeaderMenuItems';
import { RevealRow } from './RevealRow';
import { Droppable, SortableList, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import type { RenderSidebarItem, SidebarItem } from '../model/sidebar-item';
import { sortSidebarItems } from '../model/sort-sidebar-items';
import { filterSidebarItems } from '../model/filter-sidebar-items';
import type { SmartGroupPreset } from '../model/smart-group-presets';

interface UngroupedSectionProps {
  /**
   * Ungrouped agents as view-model items, pre-filter/pre-sort.
   *
   * Agents only, by construction: a room that is in no group belongs to the
   * Channels or Direct messages section, not to this one — an item lives in
   * exactly one place.
   */
  items: SidebarItem[];
  /**
   * Whether the sidebar is "organized" (has groups or pins). When true, this
   * section shows its "Agents" label (and the "Show" filter menu) to
   * distinguish the ungrouped bucket from the groups above. When false, it
   * renders as a header-less flat list.
   */
  organized: boolean;
  /**
   * Whether every agent in the fleet is in a group, which is why this list is
   * empty. Distinct from an empty fleet, which the onboarding card speaks to.
   */
  allAgentsGrouped: boolean;
  /** The ungrouped section's sort mode (`ui.sidebar.ungroupedSortMode`). */
  sortMode: 'name' | 'recent';
  /** The ungrouped section's display filter (`ui.sidebar.ungroupedDisplayFilter`). */
  filter: SidebarDisplayFilter;
  /** Render one agent row. */
  renderItem: RenderSidebarItem;
  /** Open the inline group-create flow (feeds the "+" menu's "New group" entry). */
  onNewGroup: () => void;
  /**
   * Smart-group preset chips (DOR-338) — empty below the disclosure
   * threshold (spec §5), so the "+" menu shows no new chrome for small
   * fleets.
   */
  smartGroupPresets: SmartGroupPreset[];
  /** Create a smart group immediately from a preset (one click, no dialog). */
  onCreatePresetSmartGroup: (preset: SmartGroupPreset) => void;
  /** Open the custom-rules dialog for a from-scratch smart group. */
  onOpenSmartGroupDialog: () => void;
}

/**
 * The "Agents" (ungrouped) section, plus the roster's add-agent affordance. It
 * shows an "Agents" label only when the sidebar is organized; otherwise the flat
 * list matches the pre-groups look. The "+" menu (create agent, import, browse,
 * new group) lives here so the add affordance is always present. Filtered and
 * sorted the same way a group section is — filtering first, then sort, with an
 * honest reveal row for whatever the filter hides (spec agent-list-settings §3).
 *
 * Empty because every agent is in a group says exactly that, rather than leaving
 * a labelled section with nothing under it and no reason why.
 */
export function UngroupedSection({
  items,
  organized,
  allAgentsGrouped,
  sortMode,
  filter,
  renderItem,
  onNewGroup,
  smartGroupPresets,
  onCreatePresetSmartGroup,
  onOpenSmartGroupDialog,
}: UngroupedSectionProps) {
  const { update } = useUpdateSidebarPrefs();
  const roving = useRovingFocus();
  const filtered = useMemo(
    () => filterSidebarItems(items, { filter, groupMuted: false }),
    [items, filter]
  );
  const sortedVisible = useMemo(
    () => sortSidebarItems(filtered.visible, sortMode),
    [filtered.visible, sortMode]
  );

  return (
    <SidebarGroup className="px-0" {...roving}>
      {organized ? (
        <SectionHeader
          label="Agents"
          icon={Bot}
          hasSectionAction
          nodes={buildAgentsHeaderMenuNodes({
            sortMode,
            displayFilter: filter,
            onNewAgent: () => useAgentCreationStore.getState().open(),
            onNewGroup,
            onSortModeChange: (mode) => update((prev) => setUngroupedSortMode(prev, mode)),
            onDisplayFilterChange: (next) =>
              update((prev) => setUngroupedDisplayFilter(prev, next)),
          })}
        />
      ) : (
        // Reserve the header row so the top-right "+" never overlaps the first row.
        <div className="h-8" aria-hidden />
      )}
      <AddAgentMenu
        onNewGroup={onNewGroup}
        smartGroupPresets={smartGroupPresets}
        onCreatePresetSmartGroup={onCreatePresetSmartGroup}
        onOpenSmartGroupDialog={onOpenSmartGroupDialog}
      />
      <Droppable
        id="container::ungrouped"
        data={{ type: 'container', container: { kind: 'ungrouped' } }}
      >
        <SortableList items={sortedVisible.map((item) => sidebarRowDndId('ungrouped', item.ref))}>
          <SidebarMenu>{sortedVisible.map((item) => renderItem(item, 'ungrouped'))}</SidebarMenu>
        </SortableList>
        {allAgentsGrouped && (
          <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs">
            Your agents are all in groups above.
          </p>
        )}
        <SidebarMenu>
          <RevealRow
            kind="hidden"
            items={filtered.filteredOut}
            renderItem={renderItem}
            keyPrefix="ungrouped"
          />
          <RevealRow
            kind="inactive"
            items={filtered.inactive}
            renderItem={renderItem}
            keyPrefix="ungrouped"
          />
        </SidebarMenu>
      </Droppable>
    </SidebarGroup>
  );
}
