import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ListFilter } from 'lucide-react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { useRovingFocus } from '@/layers/shared/model';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  SectionHeader,
  SidebarGroup as SidebarGroupWrapper,
  SidebarMenu,
  statusDotClass,
} from '@/layers/shared/ui';
import { useAgentsAggregateStatus } from '@/layers/entities/session';
import {
  useUpdateSidebarPrefs,
  renameGroup,
  deleteGroup,
  setGroupSortMode,
  setGroupCollapsed,
  setGroupDisplayFilter,
  setGroupMuted,
  setGroupRules,
  convertSmartGroupToManual,
} from '@/layers/entities/config';
import { RevealRow } from './RevealRow';
import { buildGroupHeaderMenuNodes } from './SectionHeaderMenuItems';
import type { RuntimeOption } from './SmartGroupRuleDialog';
import { SmartGroupRuleDialog } from './SmartGroupRuleDialog';
import { Droppable, Sortable, SortableList, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import type { RenderSidebarItem, SidebarItem } from '../model/sidebar-item';
import { sortSidebarItems, type SidebarSortMode } from '../model/sort-sidebar-items';
import { filterSidebarItems } from '../model/filter-sidebar-items';
import { storedAgentPaths } from '../model/sidebar-membership';

/** Maximum group-name length (matches `SidebarGroupSchema.name`). */
const MAX_NAME = 40;

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
 * One user-defined group — a `SectionHeader` plus member rows (agents, channels
 * and direct messages together, sidebar-groups DOR-580), filtered by the
 * group's `displayFilter` and sorted by its `sortMode`. Both read the item view
 * model, so a room needs no rendering rule of its own; the body dispatches on
 * the item's kind and neither row component is forked.
 *
 * **A group IS a section, which is why it wears the section header.** The two
 * used to be separate components with separate menus and separate hover
 * treatments; the only thing genuinely different about a group is what its menu
 * offers and the fact that its name can be edited in place — and both of those
 * are things this component hands the shared header, rather than a second
 * header. The inline rename editor, the delete confirmation and the
 * smart-group rule dialog live here, as slot content and siblings, exactly
 * because they are this section's business and not every section's.
 *
 * Muting the group is a lens over its members (DOR-339): it never writes member
 * references into `ui.sidebar.muted`, so unmuting restores whatever individual
 * mute state each member already had. Smart groups (DOR-338) add a rule glyph,
 * a plain-language summary in the menu, an "Edit rules" action that reopens the
 * rule form, and "Convert to manual group" — the escape hatch that freezes the
 * currently-matching members into a hand-tunable manual group.
 *
 * The header is draggable (reorder groups, including smart ones) and the body is
 * a drop zone for manual groups; smart groups reject drops (handled upstream in
 * `use-sidebar-dnd`'s `classifySidebarDrop`, surfaced as a hint) and their
 * member rows render without a drag handle. When collapsed, rows are hidden and
 * the header shows an activity dot if any member agent is working. An empty
 * manual group shows a "drag agents here" hint; an empty smart group shows "no
 * agents match these rules" — information, not disappearance. A non-empty group
 * whose filter hides every member shows only its reveal row(s) — never a false
 * "empty" hint.
 */
export function SidebarGroupSection({
  group,
  items,
  mutedPaths,
  renderItem,
  runtimeOptions,
  namespaceOptions,
}: SidebarGroupSectionProps) {
  const { update } = useUpdateSidebarPrefs();
  const isSmart = group.kind === 'smart';
  // Schema-level refine already rejects a *new* smart group with sortMode
  // 'manual', but the render path falls back defensively (spec §1) for any
  // data that predates the constraint.
  const sortMode: SidebarSortMode =
    isSmart && group.sortMode === 'manual' ? 'recent' : group.sortMode;

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editRulesOpen, setEditRulesOpen] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    if (isRenaming) {
      committedRef.current = false;
      requestAnimationFrame(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      });
    }
  }, [isRenaming]);

  const toggleCollapse = () =>
    update((prev) => setGroupCollapsed(prev, group.id, !group.collapsed));

  const startRename = () => {
    setRenameValue(group.name);
    setIsRenaming(true);
  };

  const commitRename = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setIsRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME || trimmed === group.name) return;
    update((prev) => renameGroup(prev, group.id, trimmed));
  };

  const cancelRename = () => {
    committedRef.current = true;
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  const requestDelete = () => {
    if (items.length === 0) {
      update((prev) => deleteGroup(prev, group.id));
    } else {
      setDeleteOpen(true);
    }
  };

  const confirmDelete = () => {
    update((prev) => deleteGroup(prev, group.id));
    setDeleteOpen(false);
  };

  const filtered = useMemo(
    () => filterSidebarItems(items, { filter: group.displayFilter, groupMuted: group.muted }),
    [items, group.displayFilter, group.muted]
  );
  // Sorting applies after filtering — only the visible bucket needs an order.
  const sortedVisible = useMemo(
    () => sortSidebarItems(filtered.visible, sortMode),
    [filtered.visible, sortMode]
  );
  // Every visible member registers, agents and rooms alike (rooms-in-groups,
  // DOR-581) — each one is wrapped in a matching `Sortable` by `renderItem`, so
  // dnd-kit never measures a node that is not there.
  const sortableIds = useMemo(
    () => sortedVisible.map((item) => sidebarRowDndId(group.id, item.ref)),
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
  const showActivityDot = group.collapsed && !group.muted && hasActivity;

  const roving = useRovingFocus({
    onCollapse: () => !group.collapsed && toggleCollapse(),
    onExpand: () => group.collapsed && toggleCollapse(),
  });

  const menuNodes = buildGroupHeaderMenuNodes({
    group,
    onRename: startRename,
    onToggleCollapsed: toggleCollapse,
    onDisplayFilterChange: (filter) =>
      update((prev) =>
        setGroupDisplayFilter(prev, group.id, filter as SidebarGroup['displayFilter'])
      ),
    onSortModeChange: (mode) =>
      update((prev) => setGroupSortMode(prev, group.id, mode as SidebarGroup['sortMode'])),
    onToggleMuted: () => update((prev) => setGroupMuted(prev, group.id, !group.muted)),
    onEditRules: () => setEditRulesOpen(true),
    onConvertToManual: () =>
      update((prev) =>
        convertSmartGroupToManual(
          prev,
          group.id,
          // `evaluateSmartGroup` stays agent-only (every rule is an agent
          // attribute), so its caller is where paths become member references.
          derivedMemberPaths.map((path) => ({ kind: 'agent', path }))
        )
      ),
    onDelete: requestDelete,
  });

  return (
    <SidebarGroupWrapper className="px-0" {...roving}>
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
            <SectionHeader
              // A group sits one level inside the roster, so its header is an
              // <h4> under the section's <h3> — a screen reader's heading list
              // is the fastest map of this sidebar there is (R2).
              level={4}
              label={group.name}
              icon={isSmart ? ListFilter : undefined}
              collapsed={group.collapsed}
              onToggle={toggleCollapse}
              controlsId={`sidebar-group-${group.id}`}
              actionsLabel={`${group.name} group actions`}
              menuWidth="w-44"
              nodes={menuNodes}
              adornment={
                isSmart ? (
                  <ListFilter
                    aria-label="Smart group — membership is rule-based"
                    className="size-3 shrink-0"
                  />
                ) : undefined
              }
              trailing={
                showActivityDot ? (
                  <span
                    aria-label="Active work in this group"
                    // The success token, and not `bg-primary`. Brand orange
                    // means interaction in this cockpit, so a group header
                    // reporting live work in it was wearing the colour of a
                    // control — and saying the same thing the agent rows
                    // underneath say in green. One fact, one colour, and the
                    // pulse because the fact is about right now.
                    className={cn('size-1.5 shrink-0 rounded-full', statusDotClass('working'))}
                  />
                ) : undefined
              }
              editor={
                isRenaming ? (
                  <input
                    ref={renameRef}
                    value={renameValue}
                    maxLength={MAX_NAME}
                    aria-label="Group name"
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    onContextMenu={(e) => e.stopPropagation()}
                    className={cn(
                      'bg-background text-foreground',
                      'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
                    )}
                  />
                ) : undefined
              }
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
            <p className="text-sidebar-foreground/50 px-3 py-1.5 text-xs italic">
              {isSmart
                ? 'No agents match these rules'
                : 'Drag agents, channels, or conversations here'}
            </p>
          ) : (
            <>
              {sortedVisible.length > 0 &&
                (isSmart ? (
                  // Smart-group member rows are rule-owned, not draggable-out —
                  // no SortableList registration (order comes from `sortMode`,
                  // never a drag gesture).
                  <SidebarMenu id={`sidebar-group-${group.id}`}>
                    {sortedVisible.map((item) => renderItem(item, group.id, { draggable: false }))}
                  </SidebarMenu>
                ) : (
                  <SortableList items={sortableIds}>
                    <SidebarMenu id={`sidebar-group-${group.id}`}>
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

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group &ldquo;{group.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {items.length} {items.length === 1 ? 'agent moves' : 'agents move'} back to
              Agents. Nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete group</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isSmart && (
        <SmartGroupRuleDialog
          open={editRulesOpen}
          onOpenChange={setEditRulesOpen}
          mode="edit"
          initialName={group.name}
          initialRules={group.rules}
          runtimeOptions={runtimeOptions}
          namespaceOptions={namespaceOptions}
          onSubmit={({ rules }) => update((prev) => setGroupRules(prev, group.id, rules))}
        />
      )}
    </SidebarGroupWrapper>
  );
}
