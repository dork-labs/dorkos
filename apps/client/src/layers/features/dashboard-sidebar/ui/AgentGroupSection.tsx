import { useMemo, type ReactNode } from 'react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { SidebarGroup as SidebarGroupWrapper, SidebarMenu } from '@/layers/shared/ui';
import { useAgentsAggregateStatus, type AttentionState } from '@/layers/entities/session';
import { GroupHeader } from './GroupHeader';
import { RevealRow } from './RevealRow';
import type { RuntimeOption } from './SmartGroupRuleDialog';
import { Droppable, Sortable, SortableList, agentRowDndId } from './dnd/SidebarDndPrimitives';
import { sortAgentPaths, type SortAgentsContext, type AgentSortMode } from '../model/sort-agents';
import { filterSectionAgents } from '../model/filter-agents';

interface AgentGroupSectionProps {
  /** The group to render. */
  group: SidebarGroup;
  /**
   * Member paths, in the group's stored order — manual: `agentPaths`
   * filtered to the known roster; smart (DOR-338): `evaluateSmartGroup`'s
   * result against the current fleet, re-derived live as agent state
   * changes.
   */
  memberPaths: string[];
  /** Display-name + activity lookups for the group's sort mode. */
  sortCtx: SortAgentsContext;
  /** Attention state per agent path (from `useAgentAttentionMap`, computed once for the whole sidebar). */
  attention: Record<string, AttentionState>;
  /** Individually-muted agent paths (`ui.sidebar.muted`), independent of this group's own mute flag. */
  mutedPaths: ReadonlySet<string>;
  /**
   * Render one agent row. The third argument disables the drag handle — used
   * for smart-group member rows, which are rule-owned and not draggable-out
   * (DOR-338 spec §3).
   */
  renderRow: (path: string, keyPrefix: string, options?: { draggable?: boolean }) => ReactNode;
  /** Runtimes present in the fleet, for a smart group's "Edit rules" form. */
  runtimeOptions: RuntimeOption[];
  /** Distinct namespaces present in the fleet, for a smart group's "Edit rules" form. */
  namespaceOptions: string[];
}

/**
 * One user-defined group: its {@link GroupHeader} plus member rows, filtered by
 * the group's `displayFilter` and sorted by its `sortMode`. The header is
 * draggable (reorder groups, including smart ones) and the body is a drop
 * zone for manual groups; smart groups reject drops (handled upstream in
 * `use-sidebar-dnd`'s `classifySidebarDrop`, surfaced as a hint) and their
 * member rows render without a drag handle. When collapsed, rows are hidden
 * and the header shows an activity dot if any member is working. An empty
 * manual group shows a "drag agents here" hint; an empty smart group shows
 * "no agents match these rules" — information, not disappearance. A
 * non-empty group whose filter hides every member shows only its reveal
 * row(s) — never a false "empty" hint.
 */
export function AgentGroupSection({
  group,
  memberPaths,
  sortCtx,
  attention,
  mutedPaths,
  renderRow,
  runtimeOptions,
  namespaceOptions,
}: AgentGroupSectionProps) {
  const isSmart = group.kind === 'smart';
  // Schema-level refine already rejects a *new* smart group with sortMode
  // 'manual', but the render path falls back defensively (spec §1) for any
  // data that predates the constraint.
  const sortMode: AgentSortMode =
    isSmart && group.sortMode === 'manual' ? 'recent' : group.sortMode;

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
    () => sortAgentPaths(filtered.visible, sortMode, sortCtx),
    [filtered.visible, sortMode, sortCtx]
  );

  // Single aggregated subscription across ALL member paths — powers the
  // collapsed-group activity dot. Smart groups read the DERIVED memberPaths
  // (their own `agentPaths` is the convert-to-manual materialization target,
  // not live membership); manual groups read `agentPaths` (incl. unknown
  // ones, which simply never match) as before.
  const hasActivity = useAgentsAggregateStatus(isSmart ? memberPaths : group.agentPaths, {
    mutedPaths,
  });

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
              derivedMemberPaths={isSmart ? memberPaths : undefined}
              runtimeOptions={runtimeOptions}
              namespaceOptions={namespaceOptions}
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
            <p className="text-muted-foreground/50 px-3 py-1.5 text-xs italic">
              {isSmart ? 'No agents match these rules' : 'Drag agents here'}
            </p>
          ) : (
            <>
              {sortedVisible.length > 0 &&
                (isSmart ? (
                  // Smart-group member rows are rule-owned, not draggable-out —
                  // no SortableList registration (order comes from `sortMode`,
                  // never a drag gesture).
                  <SidebarMenu>
                    {sortedVisible.map((path) => renderRow(path, group.id, { draggable: false }))}
                  </SidebarMenu>
                ) : (
                  <SortableList items={sortedVisible.map((p) => agentRowDndId(group.id, p))}>
                    <SidebarMenu>
                      {sortedVisible.map((path) => renderRow(path, group.id))}
                    </SidebarMenu>
                  </SortableList>
                ))}
              <SidebarMenu>
                <RevealRow
                  kind="hidden"
                  agents={filtered.filteredOut}
                  renderRow={(path, keyPrefix) =>
                    renderRow(path, keyPrefix, { draggable: !isSmart })
                  }
                  keyPrefix={group.id}
                />
                <RevealRow
                  kind="inactive"
                  agents={filtered.inactive}
                  renderRow={(path, keyPrefix) =>
                    renderRow(path, keyPrefix, { draggable: !isSmart })
                  }
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
