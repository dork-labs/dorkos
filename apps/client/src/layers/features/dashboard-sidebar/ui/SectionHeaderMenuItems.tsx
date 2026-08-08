import type { ElementType, ReactNode } from 'react';
import {
  ArrowUpDown,
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/layers/shared/ui';
import { SECTION_SORT_OPTIONS, SORT_MENU_LABEL } from '../model/sort-sidebar-items';
import {
  DISPLAY_FILTER_OPTIONS,
  DISPLAY_FILTER_MENU_LABEL,
  DISPLAY_FILTER_MENU_ICON,
} from './DisplayFilterMenu';

/** Which Radix menu the shared item list renders into. */
export type SectionHeaderMenuVariant = 'context' | 'dropdown';

/**
 * Stable identity of one section-header action.
 *
 * Names, not positions — the same token identifies the action in the
 * right-click menu and in the "…" dropdown, and is what a test asserts on
 * instead of an index. Same convention as {@link RoomMenuActionId} on the row
 * menus (spec `rooms` §14.1).
 */
export type SectionHeaderActionId =
  | 'new-channel'
  | 'new-message'
  | 'new-agent'
  | 'new-group'
  | 'new-session'
  | 'mark-all-read'
  | 'collapse';

/** Identity of one radio submenu. */
export type SectionHeaderSubmenuId = 'display' | 'sort';

/** One thing you can do to a whole section. */
export interface SectionHeaderAction {
  kind: 'action';
  id: SectionHeaderActionId;
  /**
   * The bare verb phrase, with NO trailing ellipsis. The renderer appends it
   * from {@link opensInput}, so the `…` convention is applied in one place
   * rather than hand-typed per item — and a renderer with no such convention (a
   * palette row, a slash command) gets a clean label.
   */
  label: string;
  icon: LucideIcon;
  /**
   * The action needs more from the person before it can complete — it opens a
   * dialog, a picker or an inline editor. That is what earns the `…`, and it is
   * also what arms the menu's close-focus guard (DOR-329).
   */
  opensInput: boolean;
  /** Perform it. */
  run: () => void;
}

/** A radio submenu over one of the section's own settings. */
export interface SectionHeaderSubmenu {
  kind: 'submenu';
  id: SectionHeaderSubmenuId;
  label: string;
  icon: LucideIcon;
  /** The setting's current value — exactly one option carries the dot. */
  value: string;
  options: { value: string; label: string }[];
  /** Write the newly-chosen value back to the section's own state. */
  onChange: (value: string) => void;
}

/**
 * A section header's menu as data.
 *
 * Carries nothing Radix-shaped, which is what lets the right-click
 * `ContextMenu` and the "…" `DropdownMenu` consume ONE list — the invariant
 * spec `rooms` §14.1 states, and the reason a header's two menus cannot drift
 * apart. Modelled on {@link RoomRowMenuNode}, so a row menu and a header menu
 * are the same kind of thing with the same walk over them.
 */
export type SectionHeaderMenuNode =
  | SectionHeaderAction
  | SectionHeaderSubmenu
  | { kind: 'separator'; id: string };

/**
 * Every header below follows one order: what you can make, then what you can
 * clear, then how this section looks. The blocks are shared functions rather
 * than copied literals because consistency across the headers IS the
 * deliverable (spec `rooms` §14.1) — a builder picks its subset and never
 * invents an order, a label or an icon of its own.
 *
 * The rule after the create block.
 */
const SEP_CREATE = { kind: 'separator', id: 'sep-create' } as const;

/** Collapse or expand, named for what choosing it will do. */
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
  /** Open the channel-create dialog. */
  onNewChannel: () => void;
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
    {
      kind: 'action',
      id: 'new-channel',
      label: 'New channel',
      icon: Plus,
      opensInput: true,
      run: model.onNewChannel,
    },
    SEP_CREATE,
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
  /** Open the agent picker that starts a conversation. */
  onNewMessage: () => void;
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
    {
      kind: 'action',
      id: 'new-message',
      label: 'New message',
      icon: Plus,
      opensInput: true,
      run: model.onNewMessage,
    },
    SEP_CREATE,
    ...markAllReadNodes(model.hasUnread, 'Mark all read', model.onMarkAllRead),
    collapseNode(model.collapsed, model.onToggleCollapsed),
  ];
}

/** Inputs the Threads header's item list is built from. */
export interface ThreadsHeaderMenuModel {
  /** Whether the section is collapsed, which names the collapse item. */
  collapsed: boolean;
  /** Flip the section's collapse state. */
  onToggleCollapsed: () => void;
}

/**
 * Build the Threads header's items.
 *
 * One verb, because a thread is something that happens to you rather than
 * something you make: there is nothing to create here, and a thread's unread
 * count is measured against its room's cursor, so "mark all read" would belong
 * to the room and not to this list.
 *
 * @param model - The section's collapse state and its toggle.
 */
export function buildThreadsHeaderMenuNodes(
  model: ThreadsHeaderMenuModel
): SectionHeaderMenuNode[] {
  return [collapseNode(model.collapsed, model.onToggleCollapsed)];
}

/** Inputs the "Jump back in" header's item list is built from. */
export interface JumpBackInHeaderMenuModel {
  /** Whether the section is collapsed, which names the collapse item. */
  collapsed: boolean;
  /** Start a new session. */
  onNewSession: () => void;
  /** Flip the section's collapse state. */
  onToggleCollapsed: () => void;
}

/**
 * Build the "Jump back in" header's items, in order.
 *
 * **One create action, and it stays "New session" even though the section now
 * lists rooms too.** Channels and Direct messages each carry their own "+" a few
 * rows below, so "New channel" and "New message" here would be third and fourth
 * doors to flows that already have two; a new session is the only thing this
 * list can start that has no button of its own nearby.
 *
 * "New session" carries no ellipsis on purpose: it opens the session straight
 * away rather than asking anything first, and the agent row's own "New session"
 * has always been spelled that way (`buildRowMenuNodes`).
 *
 * @param model - The section's state plus the action callbacks.
 */
export function buildJumpBackInHeaderMenuNodes(
  model: JumpBackInHeaderMenuModel
): SectionHeaderMenuNode[] {
  return [
    {
      kind: 'action',
      id: 'new-session',
      label: 'New session',
      icon: Plus,
      opensInput: false,
      run: model.onNewSession,
    },
    SEP_CREATE,
    collapseNode(model.collapsed, model.onToggleCollapsed),
  ];
}

/** Inputs the Agents header's item list is built from. */
export interface AgentsHeaderMenuModel {
  /** The ungrouped section's sort mode (`ui.sidebar.ungroupedSortMode`). */
  sortMode: 'name' | 'recent';
  /** The ungrouped section's display filter (`ui.sidebar.ungroupedDisplayFilter`). */
  displayFilter: SidebarDisplayFilter;
  /** Open the create-agent dialog. */
  onNewAgent: () => void;
  /** Open the inline group-create editor. */
  onNewGroup: () => void;
  /** Write the chosen sort mode back to `ui.sidebar`. */
  onSortModeChange: (mode: 'name' | 'recent') => void;
  /** Write the chosen display filter back to `ui.sidebar`. */
  onDisplayFilterChange: (filter: SidebarDisplayFilter) => void;
}

/**
 * Build the Agents (ungrouped) header's items, in order.
 *
 * **Show comes before Sort by**, matching {@link GroupHeader} — the menu this
 * whole family was aligned to. A group section and the ungrouped section are
 * the same kind of list with the same two settings, so the settings sit in the
 * same order in both; the spec's table lists them the other way round and the
 * audit rule ("where a verb exists, reuse its exact label and position") wins.
 *
 * The section has no collapse item because it has no collapse control: the
 * ungrouped list is what is left over, and hiding it would leave the sidebar
 * with nothing in it.
 *
 * @param model - The section's settings plus the action callbacks.
 */
export function buildAgentsHeaderMenuNodes(model: AgentsHeaderMenuModel): SectionHeaderMenuNode[] {
  return [
    {
      kind: 'action',
      id: 'new-agent',
      label: 'New agent',
      icon: Plus,
      opensInput: true,
      run: model.onNewAgent,
    },
    {
      kind: 'action',
      id: 'new-group',
      label: 'New group',
      icon: FolderPlus,
      opensInput: true,
      run: model.onNewGroup,
    },
    SEP_CREATE,
    {
      kind: 'submenu',
      id: 'display',
      label: DISPLAY_FILTER_MENU_LABEL,
      icon: DISPLAY_FILTER_MENU_ICON,
      value: model.displayFilter,
      options: [...DISPLAY_FILTER_OPTIONS],
      onChange: (value) => model.onDisplayFilterChange(value as SidebarDisplayFilter),
    },
    {
      kind: 'submenu',
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

/**
 * Slot primitives one menu family provides. Both variants render through the
 * SAME {@link renderNodes} walk — only the primitives differ — so the two menus
 * cannot structurally drift.
 */
interface SectionHeaderMenuSlots {
  Item: ElementType;
  Separator: ElementType;
  Sub: ElementType;
  SubTrigger: ElementType;
  SubContent: ElementType;
  RadioGroup: ElementType;
  RadioItem: ElementType;
}

const VARIANT_SLOTS: Record<SectionHeaderMenuVariant, SectionHeaderMenuSlots> = {
  context: {
    Item: ContextMenuItem,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
    RadioGroup: ContextMenuRadioGroup,
    RadioItem: ContextMenuRadioItem,
  },
  dropdown: {
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
    RadioGroup: DropdownMenuRadioGroup,
    RadioItem: DropdownMenuRadioItem,
  },
};

/** Render the shared nodes through one generic walk using the given slots. */
function renderNodes(nodes: SectionHeaderMenuNode[], slots: SectionHeaderMenuSlots): ReactNode {
  const { Item, Separator, Sub, SubTrigger, SubContent, RadioGroup, RadioItem } = slots;
  return nodes.map((node) => {
    if (node.kind === 'separator') return <Separator key={node.id} />;
    const Icon = node.icon;
    if (node.kind === 'submenu') {
      return (
        <Sub key={node.id}>
          <SubTrigger>
            <Icon className="mr-2 size-4" />
            {node.label}
          </SubTrigger>
          <SubContent className="w-44">
            <RadioGroup value={node.value} onValueChange={node.onChange}>
              {node.options.map((option) => (
                <RadioItem key={option.value} value={option.value}>
                  {option.label}
                </RadioItem>
              ))}
            </RadioGroup>
          </SubContent>
        </Sub>
      );
    }
    return (
      <Item key={node.id} onClick={node.run}>
        <Icon className="mr-2 size-4" />
        {node.opensInput ? `${node.label}…` : node.label}
      </Item>
    );
  });
}

interface SectionHeaderMenuItemsProps {
  /** The section's item list, from one of the builders above. */
  nodes: SectionHeaderMenuNode[];
  /** Which Radix menu family to render into. */
  variant: SectionHeaderMenuVariant;
}

/**
 * A section header's menu, rendered from ONE item definition into both the
 * right-click ContextMenu and the "…" DropdownMenu.
 */
export function SectionHeaderMenuItems({ nodes, variant }: SectionHeaderMenuItemsProps) {
  return <>{renderNodes(nodes, VARIANT_SLOTS[variant])}</>;
}
