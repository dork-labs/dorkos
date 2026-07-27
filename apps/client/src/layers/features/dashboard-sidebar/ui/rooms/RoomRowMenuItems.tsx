import type { ElementType, ReactNode } from 'react';
import {
  Archive,
  CheckCheck,
  Pencil,
  Text,
  User,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/layers/shared/ui';

/** Which Radix menu the shared item list renders into. */
type RoomRowMenuVariant = 'context' | 'dropdown';

/**
 * Stable identity of one room action.
 *
 * These are names, not positions: the same token identifies the action in the
 * right-click menu, the "…" dropdown, and — when they land — the command
 * palette (spec `rooms` §13.2) and the room slash commands (§15). Where §15
 * already names a verb, the id is that verb (`add`, `topic`, `rename`,
 * `archive`) so a command resolves to a node without a translation table in
 * between.
 */
export type RoomMenuActionId =
  | 'mark-read'
  | 'add'
  | 'members'
  | 'agent-profile'
  | 'rename'
  | 'topic'
  | 'archive';

/** One thing you can do to a room. */
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
 * The room row's menu as data.
 *
 * Deliberately carries nothing Radix-shaped: an id, a label, an icon and the
 * two flags a renderer needs to decide how to present it. That is what lets the
 * ContextMenu, the "…" DropdownMenu and (later) the palette and the slash-command
 * table all consume ONE list, which is the invariant spec §15.3 states — every
 * room command has a menu equivalent and every menu item has a command.
 *
 * S3 (DOR-581) adds two entries: Mute/Unmute is one more `action`, and
 * "Move to group ▸" adds a `submenu` variant. The walk below switches on `kind`,
 * so a new variant is a new case rather than a change to the existing ones.
 */
export type RoomRowMenuNode = RoomMenuAction | { kind: 'separator'; id: string };

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
   * The directory of the one agent a one-to-one conversation is with, or `null`
   * for a channel, a group conversation, or a DM whose roster has not resolved.
   * Only a 1:1 names an unambiguous agent, so only a 1:1 offers its profile.
   */
  soleAgentPath: string | null;
  /** Clear the unread badge without opening the room. */
  onMarkRead: () => void;
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
  /** Ask to archive, which confirms first. */
  onArchive: () => void;
}

/**
 * Build the ordered room-row menu items from a model. Pure — exported so the
 * item definitions can be asserted directly and shared by every renderer.
 *
 * The order mirrors the agent row's: state first, then the things that open
 * something, then the destructive one on its own at the bottom.
 *
 * Three omissions are deliberate rather than pending. There is no **Leave**:
 * with a single human author, leaving a room you created makes it invisible
 * with no route back, and Archive is the honest verb for that intent. There is
 * no **Pin**: rooms sort by recent activity and there are few of them, so pin
 * earns its place when the list is long enough to lose something in. And there
 * is no **Mute** yet — it waits for the unified sidebar reference (DOR-581),
 * because muting must be one concept across agents and rooms rather than a
 * second, room-only mute list.
 *
 * @param model - The room's state plus the action callbacks.
 * @internal Exported for testing and cross-renderer use.
 */
export function buildRoomRowMenuNodes(model: RoomRowMenuModel): RoomRowMenuNode[] {
  const isChannel = model.kind === 'channel';
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
      label: 'Agent profile',
      icon: User,
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

  nodes.push(
    { kind: 'separator', id: 'sep-archive' },
    {
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
    }
  );

  return nodes;
}

/**
 * Slot primitives one menu family provides. Both variants render through the
 * SAME {@link renderNodes} walk — only the primitives differ — so the two menus
 * cannot structurally drift.
 */
interface RoomMenuSlots {
  Item: ElementType;
  Separator: ElementType;
}

const VARIANT_SLOTS: Record<RoomRowMenuVariant, RoomMenuSlots> = {
  context: { Item: ContextMenuItem, Separator: ContextMenuSeparator },
  dropdown: { Item: DropdownMenuItem, Separator: DropdownMenuSeparator },
};

/** Render the shared nodes through one generic walk using the given slots. */
function renderNodes(nodes: RoomRowMenuNode[], slots: RoomMenuSlots): ReactNode {
  const { Item, Separator } = slots;
  return nodes.map((node) => {
    if (node.kind === 'separator') return <Separator key={node.id} />;
    const Icon = node.icon;
    return (
      <Item key={node.id} variant={node.destructive ? 'destructive' : undefined} onClick={node.run}>
        <Icon className="mr-2 size-4" />
        {node.opensInput ? `${node.label}…` : node.label}
      </Item>
    );
  });
}

interface RoomRowMenuItemsProps extends RoomRowMenuModel {
  /** Which Radix menu family to render into. */
  variant: RoomRowMenuVariant;
}

/**
 * The room-row menu, rendered from ONE item definition into both the right-click
 * ContextMenu and the "…" DropdownMenu.
 */
export function RoomRowMenuItems({ variant, ...model }: RoomRowMenuItemsProps) {
  return <>{renderNodes(buildRoomRowMenuNodes(model), VARIANT_SLOTS[variant])}</>;
}
