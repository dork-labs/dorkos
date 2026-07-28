import { useMemo } from 'react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { SidebarGroup as SidebarGroupWrapper, SidebarMenu } from '@/layers/shared/ui';
import { useAgentsAggregateStatus } from '@/layers/entities/session';
import { GroupHeader } from './GroupHeader';
import { RevealRow } from './RevealRow';
import type { RuntimeOption } from './SmartGroupRuleDialog';
import { Droppable, Sortable, SortableList, agentRowDndId } from './dnd/SidebarDndPrimitives';
import type { RenderSidebarItem, SidebarItem } from '../model/sidebar-item';
import { sortSidebarItems, type SidebarSortMode } from '../model/sort-sidebar-items';
import { filterSidebarItems } from '../model/filter-sidebar-items';
import { storedAgentPaths } from '../model/sidebar-membership';

interface SidebarGroupSectionProps {
  /** The group to render. */
  group: SidebarGroup;
  /**
   * The group's members as view-model items, in the group's stored order —
   * manual: its `items`, resolved against the current fleet and room list;
   * smart (DOR-338): `evaluateSmartGroup`'s result, re-derived live as agent
   * state changes.
   */
  items: SidebarItem[];
  /**
   * Agent paths that are individually muted — read only by the collapsed-group
   * activity dot, which subscribes to live agent session status. A room has none
   * of that, so it neither contributes to the dot nor needs excluding from it.
   */
  mutedPaths: ReadonlySet<string>;
  /** Render one member row. */
  renderItem: RenderSidebarItem;
  /** Runtimes present in the fleet, for a smart group's "Edit rules" form. */
  runtimeOptions: RuntimeOption[];
  /** Distinct namespaces present in the fleet, for a smart group's "Edit rules" form. */
  namespaceOptions: string[];
}

/**
 * One user-defined group: its {@link GroupHeader} plus member rows — agents,
 * channels and direct messages together (sidebar-groups, DOR-580) — filtered by
 * the group's `displayFilter` and sorted by its `sortMode`. Both read the item
 * view model, so a room needs no rendering rule of its own; the body dispatches
 * on the item's kind and neither row component is forked.
 *
 * The header is draggable (reorder groups, including smart ones) and the body is
 * a drop zone for manual groups; smart groups reject drops (handled upstream in
 * `use-sidebar-dnd`'s `classifySidebarDrop`, surfaced as a hint) and their
 * member rows render without a drag handle. A room's row carries no drag handle
 * either — a room reaches a group today by an agent writing `ui.sidebar`, and by
 * hand once S3 lands. When collapsed, rows are hidden and the header shows an
 * activity dot if any member agent is working. An empty manual group shows a
 * "drag agents here" hint; an empty smart group shows "no agents match these
 * rules" — information, not disappearance. A non-empty group whose filter hides
 * every member shows only its reveal row(s) — never a false "empty" hint.
 */
export function SidebarGroupSection({
  group,
  items,
  mutedPaths,
  renderItem,
  runtimeOptions,
  namespaceOptions,
}: SidebarGroupSectionProps) {
  const isSmart = group.kind === 'smart';
  // Schema-level refine already rejects a *new* smart group with sortMode
  // 'manual', but the render path falls back defensively (spec §1) for any
  // data that predates the constraint.
  const sortMode: SidebarSortMode =
    isSmart && group.sortMode === 'manual' ? 'recent' : group.sortMode;

  const filtered = useMemo(
    () => filterSidebarItems(items, { filter: group.displayFilter, groupMuted: group.muted }),
    [items, group.displayFilter, group.muted]
  );
  // Sorting applies after filtering — only the visible bucket needs an order.
  const sortedVisible = useMemo(
    () => sortSidebarItems(filtered.visible, sortMode),
    [filtered.visible, sortMode]
  );
  // Rooms are not a drag source until S3, so only agent rows are registered with
  // the sortable context — a `SortableList` id with no matching `Sortable` makes
  // dnd-kit measure a node that is not there.
  const sortableIds = useMemo(
    () =>
      sortedVisible.flatMap((item) =>
        item.ref.kind === 'agent' ? [agentRowDndId(group.id, item.ref.path)] : []
      ),
    [sortedVisible, group.id]
  );

  // The group's stored agent members. Rooms carry no agent attention state, so
  // they contribute nothing to the aggregate below and are dropped here.
  const memberAgentPaths = useMemo(() => storedAgentPaths(group), [group]);
  // What "Convert to manual group" materializes into `items` for a smart group.
  // Always agent-only: every smart-group rule is an agent attribute.
  const derivedMemberPaths = useMemo(
    () => items.flatMap((item) => (item.ref.kind === 'agent' ? [item.ref.path] : [])),
    [items]
  );
  // Single aggregated subscription across ALL member paths — powers the
  // collapsed-group activity dot. Smart groups read the DERIVED members
  // (their own `items` is the convert-to-manual materialization target,
  // not live membership); manual groups read their stored members (incl.
  // unknown paths, which simply never match) as before.
  const hasActivity = useAgentsAggregateStatus(isSmart ? derivedMemberPaths : memberAgentPaths, {
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
              memberCount={items.length}
              showActivityDot={group.collapsed && !group.muted && hasActivity}
              derivedMemberPaths={isSmart ? derivedMemberPaths : undefined}
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
          {items.length === 0 ? (
            <p className="text-muted-foreground/50 px-3 py-1.5 text-xs italic">
              {/* "Agents", not "agents and channels": until S3 an agent is the
                  only thing you can actually drag in here, and the hint names
                  the gesture that works today. */}
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
                    {sortedVisible.map((item) => renderItem(item, group.id, { draggable: false }))}
                  </SidebarMenu>
                ) : (
                  <SortableList items={sortableIds}>
                    <SidebarMenu>
                      {sortedVisible.map((item) => renderItem(item, group.id))}
                    </SidebarMenu>
                  </SortableList>
                ))}
              <SidebarMenu>
                <RevealRow
                  kind="hidden"
                  items={filtered.filteredOut}
                  renderItem={(item, keyPrefix) =>
                    renderItem(item, keyPrefix, { draggable: !isSmart })
                  }
                  keyPrefix={group.id}
                />
                <RevealRow
                  kind="inactive"
                  items={filtered.inactive}
                  renderItem={(item, keyPrefix) =>
                    renderItem(item, keyPrefix, { draggable: !isSmart })
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
