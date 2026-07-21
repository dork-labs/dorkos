import { useMemo, type ReactNode } from 'react';
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu } from '@/layers/shared/ui';
import type { AttentionState } from '@/layers/entities/session';
import { AddAgentMenu } from './AddAgentMenu';
import { UngroupedSectionMenu } from './UngroupedSectionMenu';
import { RevealRow } from './RevealRow';
import { Droppable, SortableList, agentRowDndId } from './dnd/SidebarDndPrimitives';
import { sortAgentPaths, type SortAgentsContext } from '../model/sort-agents';
import { filterSectionAgents } from '../model/filter-agents';

interface UngroupedSectionProps {
  /** Ungrouped agent paths (known roster), pre-filter/pre-sort order. */
  paths: string[];
  /**
   * Whether the sidebar is "organized" (has groups or pins). When true, this
   * section shows its "Agents" label (and the "Show" filter menu) to
   * distinguish the ungrouped bucket from the groups above. When false, it
   * renders as a header-less flat list.
   */
  organized: boolean;
  /** The ungrouped section's sort mode (`ui.sidebar.ungroupedSortMode`). */
  sortMode: 'name' | 'recent';
  /** The ungrouped section's display filter (`ui.sidebar.ungroupedDisplayFilter`). */
  filter: SidebarDisplayFilter;
  /** Display-name + activity lookups for sorting. */
  sortCtx: SortAgentsContext;
  /** Attention state per agent path (from `useAgentAttentionMap`, computed once for the whole sidebar). */
  attention: Record<string, AttentionState>;
  /** Individually-muted agent paths (`ui.sidebar.muted`). */
  mutedPaths: ReadonlySet<string>;
  /** Render one agent row. */
  renderRow: (path: string, keyPrefix: string) => ReactNode;
  /** Open the inline group-create flow (feeds the "+" menu's "New group" entry). */
  onNewGroup: () => void;
}

/**
 * The "Agents" (ungrouped) section, plus the roster's add-agent affordance. It
 * shows an "Agents" label only when the sidebar is organized; otherwise the flat
 * list matches the pre-groups look. The "+" menu (create agent, import, browse,
 * new group) lives here so the add affordance is always present. Filtered and
 * sorted the same way a group section is — filtering first, then sort, with an
 * honest reveal row for whatever the filter hides (spec agent-list-settings §3).
 */
export function UngroupedSection({
  paths,
  organized,
  sortMode,
  filter,
  sortCtx,
  attention,
  mutedPaths,
  renderRow,
  onNewGroup,
}: UngroupedSectionProps) {
  const filtered = useMemo(
    () => filterSectionAgents(paths, { filter, attention, mutedPaths, groupMuted: false }),
    [paths, filter, attention, mutedPaths]
  );
  const sortedVisible = useMemo(
    () => sortAgentPaths(filtered.visible, sortMode, sortCtx),
    [filtered.visible, sortMode, sortCtx]
  );

  return (
    <SidebarGroup>
      {organized ? (
        <div className="group/us relative flex h-8 items-center">
          <SidebarGroupLabel className="text-sidebar-foreground/70 text-xs font-medium tracking-wider uppercase">
            Agents
          </SidebarGroupLabel>
          <UngroupedSectionMenu />
        </div>
      ) : (
        // Reserve the header row so the top-right "+" never overlaps the first row.
        <div className="h-8" aria-hidden />
      )}
      <AddAgentMenu onNewGroup={onNewGroup} />
      <Droppable
        id="container::ungrouped"
        data={{ type: 'container', container: { kind: 'ungrouped' } }}
      >
        <SortableList items={sortedVisible.map((p) => agentRowDndId('ungrouped', p))}>
          <SidebarMenu>{sortedVisible.map((path) => renderRow(path, 'ungrouped'))}</SidebarMenu>
        </SortableList>
        <SidebarMenu>
          <RevealRow
            kind="hidden"
            agents={filtered.filteredOut}
            renderRow={renderRow}
            keyPrefix="ungrouped"
          />
          <RevealRow
            kind="inactive"
            agents={filtered.inactive}
            renderRow={renderRow}
            keyPrefix="ungrouped"
          />
        </SidebarMenu>
      </Droppable>
    </SidebarGroup>
  );
}
