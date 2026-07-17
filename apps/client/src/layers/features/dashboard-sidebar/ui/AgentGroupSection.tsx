import { useMemo, type ReactNode } from 'react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { SidebarGroup as SidebarGroupWrapper, SidebarMenu } from '@/layers/shared/ui';
import { useAgentsAggregateStatus } from '@/layers/entities/session';
import { GroupHeader } from './GroupHeader';
import { Droppable, Sortable, SortableList, agentRowDndId } from './SidebarDndPrimitives';
import { sortAgentPaths, type SortAgentsContext } from '../model/sort-agents';

interface AgentGroupSectionProps {
  /** The group to render. */
  group: SidebarGroup;
  /** Member paths filtered to the known roster, in the group's stored order. */
  memberPaths: string[];
  /** Display-name + activity lookups for the group's sort mode. */
  sortCtx: SortAgentsContext;
  /** Render one agent row. */
  renderRow: (path: string, keyPrefix: string) => ReactNode;
}

/**
 * One user-defined group: its {@link GroupHeader} plus member rows sorted by the
 * group's `sortMode`. The header is draggable (reorder groups) and the body is a
 * drop zone (drag agents in, including onto an empty group). When collapsed, rows
 * are hidden and the header shows an activity dot if any member is working. An
 * empty group shows a quiet hint and is never auto-deleted.
 */
export function AgentGroupSection({
  group,
  memberPaths,
  sortCtx,
  renderRow,
}: AgentGroupSectionProps) {
  const sortedPaths = useMemo(
    () => sortAgentPaths(memberPaths, group.sortMode, sortCtx),
    [memberPaths, group.sortMode, sortCtx]
  );

  // Single aggregated subscription across ALL member paths (incl. unknown ones,
  // which simply never match) — powers the collapsed-group activity dot.
  const hasActivity = useAgentsAggregateStatus(group.agentPaths);

  return (
    <SidebarGroupWrapper>
      <Sortable id={`group-header::${group.id}`} data={{ type: 'group', groupId: group.id }}>
        {(b) => (
          <div
            ref={b.setNodeRef}
            style={b.style}
            {...b.handleProps}
            className={cn(
              'focus-visible:ring-sidebar-ring rounded-md outline-hidden focus-visible:ring-2',
              b.isDragging && 'opacity-40',
              b.isOver && 'ring-sidebar-ring ring-2'
            )}
          >
            <GroupHeader
              group={group}
              memberCount={memberPaths.length}
              showActivityDot={group.collapsed && hasActivity}
            />
          </div>
        )}
      </Sortable>
      {!group.collapsed && (
        <Droppable
          id={`container::group::${group.id}`}
          data={{ type: 'container', container: { kind: 'group', groupId: group.id } }}
        >
          {sortedPaths.length > 0 ? (
            <SortableList items={sortedPaths.map((p) => agentRowDndId(group.id, p))}>
              <SidebarMenu>{sortedPaths.map((path) => renderRow(path, group.id))}</SidebarMenu>
            </SortableList>
          ) : (
            <p className="text-muted-foreground/50 px-3 py-1.5 text-xs italic">Drag agents here</p>
          )}
        </Droppable>
      )}
    </SidebarGroupWrapper>
  );
}
