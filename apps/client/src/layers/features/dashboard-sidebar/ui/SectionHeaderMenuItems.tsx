/**
 * Every sidebar section header's menu, built as data.
 *
 * The builders are pure and the nodes are Radix-free, so one list feeds the
 * right-click menu, the "⋮" menu and — when they land — the command palette
 * and the slash-command table. The rendering half of this file moved to
 * `shared/ui/sidebar-menu-node`, which is now the sidebar's ONLY
 * ContextMenu + DropdownMenu implementation.
 *
 * @module features/dashboard-sidebar/ui/SectionHeaderMenuItems
 */
import {
  ArrowUpDown,
  Bell,
  BellOff,
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  ListFilter,
  Pencil,
  Trash2,
  Users,
  Wand2,
} from 'lucide-react';
import type { SidebarDisplayFilter, SidebarGroup } from '@dorkos/shared/config-schema';
import type { SidebarMenuActionNode, SidebarMenuNode } from '@/layers/shared/ui';
import { SECTION_SORT_OPTIONS, SORT_MENU_LABEL } from '../model/section-sort-options';
import { describeRules } from '../model/evaluate-smart-group';
import { displayFilterNode } from './DisplayFilterMenu';

/**
 * Stable identity of one section-header action.
 *
 * Names, not positions — the same token identifies the action in the
 * right-click menu and in the "…" dropdown, and is what a test asserts on
 * instead of an index. Same convention as {@link RoomMenuActionId} on the row
 * menus (spec `rooms` §14.1).
 */
export type SectionHeaderActionId =
  | 'mark-all-read'
  | 'collapse'
  | 'rename'
  | 'mute'
  | 'edit-rules'
  | 'convert-to-manual'
  | 'delete';

/** One thing you can do to a whole section — the shared action node, with this family's ids. */
export type SectionHeaderAction = Omit<SidebarMenuActionNode, 'id'> & { id: SectionHeaderActionId };

/**
 * A section header's menu as data — the shared sidebar node type, with this
 * family's action vocabulary substituted for the generic one.
 *
 * The narrowing is what keeps {@link SectionHeaderActionId} honest: a builder
 * that invents an id outside the vocabulary fails to compile rather than
 * shipping an action nothing can resolve. Every node here is still assignable
 * to `SidebarMenuNode`, so the shared renderer takes the list unchanged — a
 * header menu and a row menu are the same kind of thing with the same walk over
 * them (spec `rooms` §14.1).
 */
export type SectionHeaderMenuNode =
  | SectionHeaderAction
  | Exclude<SidebarMenuNode, SidebarMenuActionNode>;

/**
 * **No header below makes anything.** Every "New …" these menus used to carry
 * moved into the one New menu on the header block, and a section's hover `+`
 * deep-links into it rather than running a handler of its own (BC-45). What is
 * left is one order: what you can clear, then how this section looks. The
 * blocks are shared functions rather than copied literals because consistency
 * across the headers IS the deliverable (spec `rooms` §14.1) — a builder picks
 * its subset and never invents an order, a label or an icon of its own.
 *
 * Collapse or expand, named for what choosing it will do.
 *
 * @param collapsed - Whether the section is folded right now.
 * @param onToggle - Flip it.
 */
function collapseNode(collapsed: boolean, onToggle: () => void): SectionHeaderAction {
  return {
    kind: 'action',
    id: 'collapse',
    label: collapsed ? 'Expand' : 'Collapse',
    icon: collapsed ? ChevronsUpDown : ChevronsDownUp,
    opensInput: false,
    run: onToggle,
  };
}

/**
 * "Mark all … read", with its separator, and only when there is something to
 * clear. Same rule the room row follows: an item that would do nothing is not
 * offered (`buildRoomRowMenuNodes`).
 */
function markAllReadNodes(
  hasUnread: boolean,
  label: string,
  onMarkAllRead: () => void
): SectionHeaderMenuNode[] {
  if (!hasUnread) return [];
  return [
    {
      kind: 'action',
      id: 'mark-all-read',
      label,
      icon: CheckCheck,
      opensInput: false,
      run: onMarkAllRead,
    },
    { kind: 'separator', id: 'sep-unread' },
  ];
}

/** Inputs the Channels header's item list is built from. */
export interface ChannelsHeaderMenuModel {
  /** Whether the section is collapsed, which names the collapse item. */
  collapsed: boolean;
  /** Whether any channel is behind. Nothing to clear means no "Mark all channels read". */
  hasUnread: boolean;
  /** Clear the unread badge on every channel. */
  onMarkAllRead: () => void;
  /** Flip the section's collapse state. */
  onToggleCollapsed: () => void;
}

/**
 * Build the Channels header's items, in order.
 *
 * No "Sort ▸" yet, and that is a gap rather than an omission: channels are
 * ordered by name in `useRoomsByKind` with no per-section setting behind it, so
 * offering the submenu would mean adding a persisted preference and its config
 * migration — a change to what the sidebar stores, not to what its headers
 * offer. Filed as DOR-906 rather than smuggled in here (spec `rooms` §14.1
 * lists it).
 *
 * @param model - The section's state plus the action callbacks.
 */
export function buildChannelsHeaderMenuNodes(
  model: ChannelsHeaderMenuModel
): SectionHeaderMenuNode[] {
  return [
    ...markAllReadNodes(model.hasUnread, 'Mark all channels read', model.onMarkAllRead),
    collapseNode(model.collapsed, model.onToggleCollapsed),
  ];
}

/** Inputs the Direct messages header's item list is built from. */
export interface DirectMessagesHeaderMenuModel {
  /** Whether the section is collapsed, which names the collapse item. */
  collapsed: boolean;
  /** Whether any conversation is behind. */
  hasUnread: boolean;
  /** Clear the unread badge on every conversation. */
  onMarkAllRead: () => void;
  /** Flip the section's collapse state. */
  onToggleCollapsed: () => void;
}

/**
 * Build the Direct messages header's items, in order — the Channels list with
 * the noun changed, deliberately identical in shape and position.
 *
 * @param model - The section's state plus the action callbacks.
 */
export function buildDirectMessagesHeaderMenuNodes(
  model: DirectMessagesHeaderMenuModel
): SectionHeaderMenuNode[] {
  return [
    ...markAllReadNodes(model.hasUnread, 'Mark all read', model.onMarkAllRead),
    collapseNode(model.collapsed, model.onToggleCollapsed),
  ];
}

/** Inputs the Agents header's item list is built from. */
export interface AgentsHeaderMenuModel {
  /** The ungrouped section's sort mode (`ui.sidebar.sections.agents.sortMode`). */
  sortMode: 'name' | 'recent';
  /** The ungrouped section's display filter (`ui.sidebar.sections.agents.displayFilter`). */
  displayFilter: SidebarDisplayFilter;
  /** Write the chosen sort mode back to `ui.sidebar`. */
  onSortModeChange: (mode: 'name' | 'recent') => void;
  /** Write the chosen display filter back to `ui.sidebar`. */
  onDisplayFilterChange: (filter: SidebarDisplayFilter) => void;
}

/**
 * Build the Agents (ungrouped) header's items, in order.
 *
 * **Show comes before Sort by**, matching {@link buildGroupHeaderMenuNodes} —
 * the menu this whole family was aligned to. A group section and the ungrouped
 * section are
 * the same kind of list with the same two settings, so the settings sit in the
 * same order in both; the spec's table lists them the other way round and the
 * audit rule ("where a verb exists, reuse its exact label and position") wins.
 *
 * The section has no collapse item because it has no collapse control: the
 * ungrouped list is what is left over, and hiding it would leave the sidebar
 * with nothing in it.
 *
 * "New agent" and "New group" are not here: the New menu on the header block
 * is the one place either is made, and this section's `+` deep-links into it
 * (BC-45).
 *
 * @param model - The section's settings plus the action callbacks.
 */
export function buildAgentsHeaderMenuNodes(model: AgentsHeaderMenuModel): SectionHeaderMenuNode[] {
  return [
    displayFilterNode(model.displayFilter, (value) =>
      model.onDisplayFilterChange(value as SidebarDisplayFilter)
    ),
    {
      kind: 'radio',
      id: 'sort',
      label: SORT_MENU_LABEL,
      icon: ArrowUpDown,
      value: model.sortMode,
      // No 'manual': the ungrouped section has no hand-orderable sequence —
      // groups are the place for manual curation (`SidebarPrefsSchema`).
      options: SECTION_SORT_OPTIONS.filter((option) => option.value !== 'manual'),
      // The filter above is what makes the narrowing sound: 'manual' is the one
      // value this submenu never offers, so the value coming back is one of the
      // two the section's state accepts.
      onChange: (value) => model.onSortModeChange(value as 'name' | 'recent'),
    },
  ];
}

/** Inputs a group header's item list is built from. */
export interface GroupHeaderMenuModel {
  /** The group this header belongs to. */
  group: SidebarGroup;
  /** Start the inline rename editor on the header. */
  onRename: () => void;
  /** Flip the group's collapse state. */
  onToggleCollapsed: () => void;
  /** Write the chosen display filter back to the group. */
  onDisplayFilterChange: (filter: string) => void;
  /** Write the chosen sort mode back to the group. */
  onSortModeChange: (mode: string) => void;
  /** Flip the group's mute lens. */
  onToggleMuted: () => void;
  /** Open the rule form, prefilled (smart groups only). */
  onEditRules: () => void;
  /** Freeze the currently-matching members into a hand-tunable manual group. */
  onConvertToManual: () => void;
  /** Ask to delete — which confirms first for a group that has members. */
  onDelete: () => void;
}

/**
 * Build a group header's items, in order.
 *
 * A group is a section, so this list is the section-header list with the nouns
 * changed: what you can make (nothing — a group is already made), then what you
 * can clear, then how this section looks, then the destructive one on its own
 * at the bottom. **Show comes before Sort by**, and the built-in Agents header
 * matches it rather than the other way round.
 *
 * Muting a group is a lens over its members (DOR-339): it never writes member
 * references into `ui.sidebar.muted`, so unmuting restores whatever individual
 * mute state each member already had.
 *
 * Smart groups (DOR-338) add a plain-language rule summary at the top — the
 * honesty contract, since their membership is not something you can hand-edit —
 * plus "Edit rules" and "Convert to manual group", the escape hatch that freezes
 * the currently-matching members.
 *
 * @param model - The group plus the action callbacks.
 */
export function buildGroupHeaderMenuNodes(model: GroupHeaderMenuModel): SectionHeaderMenuNode[] {
  const { group } = model;
  const isSmart = group.kind === 'smart';
  // Smart groups reject 'manual' sort at the schema level — derived membership
  // has no hand-orderable sequence, so the option never appears.
  const sortOptions = isSmart
    ? SECTION_SORT_OPTIONS.filter((o) => o.value !== 'manual')
    : SECTION_SORT_OPTIONS;

  return [
    ...(isSmart
      ? [
          {
            kind: 'note' as const,
            id: 'rules',
            icon: ListFilter,
            text: describeRules(group.rules ?? {}),
          },
        ]
      : []),
    {
      kind: 'action',
      id: 'rename',
      label: 'Rename',
      icon: Pencil,
      opensInput: true,
      run: model.onRename,
    },
    collapseNode(group.collapsed, model.onToggleCollapsed),
    displayFilterNode(group.displayFilter, model.onDisplayFilterChange),
    {
      kind: 'radio',
      id: 'sort',
      label: SORT_MENU_LABEL,
      icon: ArrowUpDown,
      value: group.sortMode,
      options: sortOptions,
      onChange: model.onSortModeChange,
    },
    {
      kind: 'action',
      id: 'mute',
      label: group.muted ? 'Unmute group' : 'Mute group',
      icon: group.muted ? Bell : BellOff,
      opensInput: false,
      run: model.onToggleMuted,
    },
    ...(isSmart
      ? ([
          {
            kind: 'action',
            id: 'edit-rules',
            label: 'Edit rules',
            icon: Wand2,
            opensInput: false,
            run: model.onEditRules,
          },
          {
            kind: 'action',
            id: 'convert-to-manual',
            label: 'Convert to manual group',
            icon: Users,
            opensInput: false,
            run: model.onConvertToManual,
          },
        ] satisfies SectionHeaderMenuNode[])
      : []),
    { kind: 'separator', id: 'sep-delete' },
    {
      kind: 'action',
      id: 'delete',
      label: 'Delete group',
      icon: Trash2,
      opensInput: false,
      destructive: true,
      run: model.onDelete,
    },
  ];
}
