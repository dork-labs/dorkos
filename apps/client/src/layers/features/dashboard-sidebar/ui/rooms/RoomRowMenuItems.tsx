import {
  Archive,
  Bell,
  BellOff,
  CheckCheck,
  FolderInput,
  FolderMinus,
  FolderPlus,
  LogOut,
  Pencil,
  Text,
  PanelRight,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import type { SidebarMenuActionNode, SidebarMenuNode } from '@/layers/shared/ui';

/**
 * Stable identity of one room action.
 *
 * These are names, not positions: the same token identifies the action in the
 * right-click menu, the "…" dropdown, and — when they land — the command
 * palette (spec `rooms` §13.2) and the room slash commands (§15). Where §15
 * already names a verb, the id is that verb (`add`, `topic`, `rename`,
 * `archive`) so a command resolves to a node without a translation table in
 * between.
 *
 * **`/remove` is the one §15 verb with no node of its own, and that is
 * deliberate.** Removing a member is a per-member action, not a room-level one:
 * there is no "remove" you can perform on a room without first saying whom. It
 * resolves to `members`, the panel that owns removal — which keeps §15.3's
 * invariant intact, because the invariant is that every command has a menu
 * equivalent, not that every command has its own node. A command that needs an
 * argument the menu would have to ask for anyway lands on the surface that asks.
 */
export type RoomMenuActionId =
  | 'mark-read'
  | 'mute'
  | 'move-to-group'
  | 'remove-from-group'
  | 'new-group'
  | 'add'
  | 'members'
  | 'agent-profile'
  | 'rename'
  | 'topic'
  | 'leave'
  | 'archive';

/**
 * One thing you can do to a room — the shared sidebar action node, narrowed to
 * this menu's own id vocabulary.
 */
export interface RoomMenuAction {
  kind: 'action';
  id: RoomMenuActionId;
  /**
   * The bare verb phrase, with NO trailing ellipsis. A renderer that uses the
   * `…` convention appends it from {@link opensInput}, so the convention is
   * applied in one place rather than hand-typed per item — and a renderer with
   * no such convention (a palette row, a slash command) gets a clean label.
   */
  label: string;
  icon: LucideIcon;
  /**
   * The action needs more from the person before it can complete — it opens an
   * editor, a picker or a panel. This is what earns the `…`; a confirmation
   * alert does not, which is why `archive` is `false`.
   */
  opensInput: boolean;
  /** Takes something away. Renderers style it apart and confirm before running it. */
  destructive: boolean;
  /** Perform it. */
  run: () => void;
}

/**
 * The room row's menu as data — the shared sidebar node type, with this menu's
 * own action vocabulary substituted for the generic one.
 *
 * Deliberately carries nothing Radix-shaped: an id, a label, an icon and the
 * two flags a renderer needs to decide how to present it. That is what lets the
 * ContextMenu, the "⋮" DropdownMenu and (later) the palette and the
 * slash-command table all consume ONE list, which is the invariant spec §15.3
 * states — every room command has a menu equivalent and every menu item has a
 * command.
 *
 * The narrowing is what keeps {@link RoomMenuActionId} honest: a builder that
 * invents an id outside the vocabulary fails to compile rather than shipping an
 * action no command can resolve. Every node here is still assignable to
 * `SidebarMenuNode`, so the shared renderer takes the list unchanged.
 */
export type RoomRowMenuNode = RoomMenuAction | Exclude<SidebarMenuNode, SidebarMenuActionNode>;

/** Inputs the pure item list is built from (fabricated directly in unit tests). */
export interface RoomRowMenuModel {
  /**
   * What kind of room this row is. It decides which verbs are even meaningful:
   * only a channel has a topic, because only a channel is about a subject
   * rather than about who is in it (spec §14.4).
   */
  kind: RoomKind;
  /** Whether the reader is behind. Nothing to clear means no "Mark as read". */
  hasUnread: boolean;
  /**
   * Whether this room is muted in its own right — its entry in the shared
   * `ui.sidebar.muted` list, which holds agents and rooms alike. There is no
   * second, room-only mute list, so "muted" means one thing across the sidebar.
   */
  isMuted: boolean;
  /** The group this room currently sits in, or `null` when it is in none. */
  currentGroupId: string | null;
  /**
   * The groups this room can be moved into — MANUAL groups only.
   *
   * A smart group derives its membership from rules about agents, and its stored
   * `items` is only the convert-to-manual materialization target. A room filed
   * into one would be hidden from Channels (it counts as grouped) and drawn by
   * nobody (the smart group renders its derived members instead) — it would
   * simply vanish. The drag layer already refuses that drop; the menu refuses it
   * by not offering it.
   */
  groups: { id: string; name: string }[];
  /**
   * The directory of the one agent a one-to-one conversation is with, or `null`
   * for a channel, a group conversation, or a DM whose roster has not resolved.
   * Only a 1:1 names an unambiguous agent, so only a 1:1 offers its profile.
   */
  soleAgentPath: string | null;
  /**
   * Whether this viewer's own author id is known yet — what naming yourself
   * as the member to remove takes. `false` only while the team roster is
   * still loading, which is a beat on a cold sidebar; the item is withheld
   * rather than offered and refused, the same way `soleAgentPath` withholds
   * "Agent profile" instead of showing it disabled.
   */
  canLeave: boolean;
  /** Clear the unread badge without opening the room. */
  onMarkRead: () => void;
  /** Toggle this room's own mute state. */
  onToggleMute: () => void;
  /** Move the room into a group, or out of every group with `null`. */
  onMoveToGroup: (groupId: string | null) => void;
  /** Open the inline group-create flow, moving this room into the new group on commit. */
  onNewGroup: () => void;
  /** Open the members panel with the picker focused. */
  onAddAgents: () => void;
  /** Open the members panel on its roster. */
  onOpenMembers: () => void;
  /** Open an agent's profile in the right-panel hub. */
  onOpenAgentProfile: (agentPath: string) => void;
  /** Start the inline rename editor on this row. */
  onRename: () => void;
  /** Open the topic editor. */
  onEditTopic: () => void;
  /**
   * Ask to leave, which confirms first. The server refuses this while two
   * agents still share the room and nobody is left to witness them
   * (`OWNER_MUST_BE_PRESENT`, the three-way rule) — take one out first, or
   * archive instead.
   */
  onLeave: () => void;
  /** Ask to archive, which confirms first. */
  onArchive: () => void;
}

/**
 * The contents of "Move to group ▸": one tickable target per manual group, the
 * way out when the room is already in one, and the door to a brand-new group.
 *
 * Mirrors the agent row's submenu exactly (`buildRowMenuNodes`) rather than
 * inventing a room-shaped variant, because the two menus name the same
 * operation on the same stored list — `ui.sidebar.groups[].items`.
 *
 * "New group…" is offered even with no groups yet: an empty submenu holding only
 * a separator would be a dead end, and creating the first group from the row you
 * want in it is the fastest path there is.
 */
function buildMoveToGroupItems(model: RoomRowMenuModel): RoomRowMenuNode[] {
  const items: RoomRowMenuNode[] = model.groups.map((group) => ({
    kind: 'choice',
    id: `group-${group.id}`,
    label: group.name,
    checked: group.id === model.currentGroupId,
    run: () => model.onMoveToGroup(group.id),
  }));

  if (model.currentGroupId !== null) {
    items.push({
      kind: 'action',
      id: 'remove-from-group',
      label: 'Remove from group',
      icon: FolderMinus,
      opensInput: false,
      destructive: false,
      run: () => model.onMoveToGroup(null),
    });
  }

  items.push(
    { kind: 'separator', id: 'sep-new-group' },
    {
      kind: 'action',
      id: 'new-group',
      label: 'New group',
      icon: FolderPlus,
      // Earns the ellipsis: it mounts the inline name editor rather than
      // creating anything on the spot.
      opensInput: true,
      destructive: false,
      run: model.onNewGroup,
    }
  );

  return items;
}

/**
 * Build the ordered room-row menu items from a model. Pure — exported so the
 * item definitions can be asserted directly and shared by every renderer.
 *
 * The order mirrors the agent row's: state first, then the things that open
 * something, then the two destructive ones together at the bottom — **Leave**,
 * then **Archive**.
 *
 * **Leave and Archive are not the same verb wearing two names.** Leaving takes
 * you off the roster and nothing else: the room keeps running for whoever and
 * whatever is still on it, and the server refuses it outright
 * (`OWNER_MUST_BE_PRESENT`) while it would strand two agents alone together —
 * take one out first, or archive instead. Archiving is the room-wide "put this
 * away": nothing on it is triggered any more, for anybody, and it is what an
 * owner who created a room and wants it gone reaches for — reversible, unlike
 * a delete this product has never offered (spec `rooms` §12.4).
 *
 * There is no **Pin**, and that omission is still deliberate: rooms sort by
 * recent activity and there are few of them, so pin earns its place when the
 * list is long enough to lose something in.
 *
 * **Mute is one concept, not a room-only copy of one.** It writes the room's
 * reference into the same `ui.sidebar.muted` list an agent writes its path into,
 * which is why the wording here ("Mute channel" / "Mute conversation") differs
 * from the agent row's only in the noun.
 *
 * @param model - The room's state plus the action callbacks.
 * @internal Exported for testing and cross-renderer use.
 */
export function buildRoomRowMenuNodes(model: RoomRowMenuModel): RoomRowMenuNode[] {
  const isChannel = model.kind === 'channel';
  /** The noun every room-level label ends in, so one room is called one thing. */
  const noun = isChannel ? 'channel' : 'conversation';
  const nodes: RoomRowMenuNode[] = [];

  if (model.hasUnread) {
    nodes.push(
      {
        kind: 'action',
        id: 'mark-read',
        label: 'Mark as read',
        icon: CheckCheck,
        opensInput: false,
        destructive: false,
        run: model.onMarkRead,
      },
      { kind: 'separator', id: 'sep-unread' }
    );
  }

  nodes.push(
    {
      kind: 'action',
      id: 'mute',
      label: model.isMuted ? `Unmute ${noun}` : `Mute ${noun}`,
      icon: model.isMuted ? Bell : BellOff,
      opensInput: false,
      destructive: false,
      run: model.onToggleMute,
    },
    {
      kind: 'submenu',
      id: 'move-to-group',
      label: 'Move to group',
      icon: FolderInput,
      items: buildMoveToGroupItems(model),
    },
    { kind: 'separator', id: 'sep-organize' }
  );

  nodes.push(
    {
      kind: 'action',
      id: 'add',
      label: 'Add agents',
      icon: UserPlus,
      opensInput: true,
      destructive: false,
      run: model.onAddAgents,
    },
    {
      kind: 'action',
      id: 'members',
      label: 'Members',
      icon: Users,
      opensInput: true,
      destructive: false,
      run: model.onOpenMembers,
    }
  );

  // The bridge between the two sidebar sections: from the conversation you have
  // with an agent to the agent itself. A group conversation and a channel name
  // no single agent, so there is nothing unambiguous to jump to.
  const soleAgentPath = model.soleAgentPath;
  if (soleAgentPath !== null) {
    nodes.push({
      kind: 'action',
      id: 'agent-profile',
      // "Agent hub" for the reason `AgentRowMenuItems` carries: this opens the
      // right-panel workbench, and the profile drawer now owns the other word.
      label: 'Agent hub',
      icon: PanelRight,
      opensInput: false,
      destructive: false,
      run: () => model.onOpenAgentProfile(soleAgentPath),
    });
  }

  nodes.push({ kind: 'separator', id: 'sep-settings' });

  nodes.push({
    kind: 'action',
    id: 'rename',
    label: 'Rename',
    icon: Pencil,
    opensInput: true,
    destructive: false,
    run: model.onRename,
  });

  if (isChannel) {
    nodes.push({
      kind: 'action',
      id: 'topic',
      label: 'Edit topic',
      icon: Text,
      opensInput: true,
      destructive: false,
      run: model.onEditTopic,
    });
  }

  nodes.push({ kind: 'separator', id: 'sep-destructive' });

  // Withheld rather than shown disabled: see `RoomRowMenuModel.canLeave`.
  if (model.canLeave) {
    nodes.push({
      kind: 'action',
      id: 'leave',
      label: `Leave ${noun}`,
      icon: LogOut,
      // A confirmation alert, not an editor — same reasoning as Archive below.
      opensInput: false,
      destructive: true,
      run: model.onLeave,
    });
  }

  nodes.push({
    kind: 'action',
    id: 'archive',
    // Named like "Delete group" is: the verb plus the noun it acts on, so the
    // item still reads correctly out of context.
    label: isChannel ? 'Archive channel' : 'Archive conversation',
    icon: Archive,
    // A confirmation alert does not earn an ellipsis — the command IS complete
    // when chosen; the alert only asks whether you meant it.
    opensInput: false,
    destructive: true,
    run: model.onArchive,
  });

  return nodes;
}
