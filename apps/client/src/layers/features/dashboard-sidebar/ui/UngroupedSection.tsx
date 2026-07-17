import type { ReactNode } from 'react';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu } from '@/layers/shared/ui';
import { AddAgentMenu } from './AddAgentMenu';
import { Droppable, SortableList, agentRowDndId } from './SidebarDndPrimitives';

interface UngroupedSectionProps {
  /** Ungrouped agent paths (known roster, already sorted by the ungrouped sort mode). */
  paths: string[];
  /**
   * Whether the sidebar is "organized" (has groups or pins). When true, this
   * section shows its "Agents" label to distinguish the ungrouped bucket from
   * the groups above. When false, it renders as a header-less flat list.
   */
  organized: boolean;
  /** Render one agent row. */
  renderRow: (path: string, keyPrefix: string) => ReactNode;
  /** Open the inline group-create flow (feeds the "+" menu's "New group" entry). */
  onNewGroup: () => void;
}

/**
 * The "Agents" (ungrouped) section, plus the roster's add-agent affordance. It
 * shows an "Agents" label only when the sidebar is organized; otherwise the flat
 * list matches the pre-groups look. The "+" menu (create agent, import, browse,
 * new group) lives here so the add affordance is always present.
 */
export function UngroupedSection({
  paths,
  organized,
  renderRow,
  onNewGroup,
}: UngroupedSectionProps) {
  return (
    <SidebarGroup>
      {organized ? (
        <SidebarGroupLabel className="text-sidebar-foreground/70 text-xs font-medium tracking-wider uppercase">
          Agents
        </SidebarGroupLabel>
      ) : (
        // Reserve the header row so the top-right "+" never overlaps the first row.
        <div className="h-8" aria-hidden />
      )}
      <AddAgentMenu onNewGroup={onNewGroup} />
      <Droppable
        id="container::ungrouped"
        data={{ type: 'container', container: { kind: 'ungrouped' } }}
      >
        <SortableList items={paths.map((p) => agentRowDndId('ungrouped', p))}>
          <SidebarMenu>{paths.map((path) => renderRow(path, 'ungrouped'))}</SidebarMenu>
        </SortableList>
      </Droppable>
    </SidebarGroup>
  );
}
