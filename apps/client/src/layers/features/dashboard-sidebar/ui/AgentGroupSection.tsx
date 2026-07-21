import { useMemo, type ReactNode } from 'react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { SidebarGroup as SidebarGroupWrapper, SidebarMenu } from '@/layers/shared/ui';
import { useAgentsAggregateStatus, type AttentionState } from '@/layers/entities/session';
import { GroupHeader } from './GroupHeader';
import { RevealRow } from './RevealRow';
import { Droppable, Sortable, SortableList, agentRowDndId } from './dnd/SidebarDndPrimitives';
import { sortAgentPaths, type SortAgentsContext } from '../model/sort-agents';
import { filterSectionAgents } from '../model/filter-agents';

interface AgentGroupSectionProps {
  /** The group to render. */
  group: SidebarGroup;
  /** Member paths filtered to the known roster, in the group's stored order. */
  memberPaths: string[];
  /** Display-name + activity lookups for the group's sort mode. */
  sortCtx: SortAgentsContext;
  /** Attention state per agent path (from `useAgentAttentionMap`, computed once for the whole sidebar). */
  attention: Record<string, AttentionState>;
  /** Individually-muted agent paths (`ui.sidebar.muted`), independent of this group's own mute flag. */
  mutedPaths: ReadonlySet<string>;
  /** Render one agent row. */
  renderRow: (path: string, keyPrefix: string) => ReactNode;
}

/**
 * One user-defined group: its {@link GroupHeader} plus member rows, filtered by
 * the group's `displayFilter` and sorted by its `sortMode`. The header is
 * draggable (reorder groups) and the body is a drop zone (drag agents in,
 * including onto an empty group). When collapsed, rows are hidden and the
 * header shows an activity dot if any member is working. An empty group shows
 * a quiet hint and is never auto-deleted; a non-empty group whose filter hides
 * every member shows only its reveal row(s) — never a false "empty" hint.
 */
export function AgentGroupSection({
  group,
  memberPaths,
  sortCtx,
  attention,
  mutedPaths,
  renderRow,
}: AgentGroupSectionProps) {
  const filtered = useMemo(
    () =>
      filterSectionAgents(memberPaths, {
        filter: group.displayFilter,
        attention,
        mutedPaths,
        groupMuted: group.muted,
      }),
    [memberPaths, group.displayFilter, group.muted, attention, mutedPaths]
  );
  // Sorting applies after filtering — only the visible bucket needs an order.
  const sortedVisible = useMemo(
    () => sortAgentPaths(filtered.visible, group.sortMode, sortCtx),
    [filtered.visible, group.sortMode, sortCtx]
  );

  // Single aggregated subscription across ALL member paths (incl. unknown ones,
  // which simply never match) — powers the collapsed-group activity dot.
  const hasActivity = useAgentsAggregateStatus(group.agentPaths, { mutedPaths });

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
              showActivityDot={group.collapsed && !group.muted && hasActivity}
            />
          </div>
        )}
      </Sortable>
      {!group.collapsed && (
        <Droppable
          id={`container::group::${group.id}`}
          data={{ type: 'container', container: { kind: 'group', groupId: group.id } }}
        >
          {memberPaths.length === 0 ? (
            <p className="text-muted-foreground/50 px-3 py-1.5 text-xs italic">Drag agents here</p>
          ) : (
            <>
              {sortedVisible.length > 0 && (
                <SortableList items={sortedVisible.map((p) => agentRowDndId(group.id, p))}>
                  <SidebarMenu>
                    {sortedVisible.map((path) => renderRow(path, group.id))}
                  </SidebarMenu>
                </SortableList>
              )}
              <SidebarMenu>
                <RevealRow
                  kind="hidden"
                  agents={filtered.filteredOut}
                  renderRow={renderRow}
                  keyPrefix={group.id}
                />
                <RevealRow
                  kind="inactive"
                  agents={filtered.inactive}
                  renderRow={renderRow}
                  keyPrefix={group.id}
                />
              </SidebarMenu>
            </>
          )}
        </Droppable>
      )}
    </SidebarGroupWrapper>
  );
}
