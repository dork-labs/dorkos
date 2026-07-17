import type { ElementType, ReactNode } from 'react';
import {
  Pin,
  PinOff,
  User,
  Plus,
  FolderInput,
  FolderPlus,
  FolderMinus,
  type LucideIcon,
} from 'lucide-react';
import {
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/layers/shared/ui';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  pinPath,
  unpinPath,
  moveToGroup,
} from '@/layers/entities/config';

/** Which Radix menu the shared item list renders into. */
type AgentRowMenuVariant = 'context' | 'dropdown';

/**
 * Single source of truth for an agent row's menu, expressed as data so the
 * ContextMenu (right-click) and DropdownMenu ("…") variants render the exact
 * same items — no hand-copied second list to drift.
 */
type RowMenuNode =
  | { type: 'item'; key: string; label: string; icon: LucideIcon; onSelect: () => void }
  | { type: 'checkItem'; key: string; label: string; checked: boolean; onSelect: () => void }
  | { type: 'separator'; key: string }
  | { type: 'sub'; key: string; label: string; icon: LucideIcon; items: RowMenuNode[] };

/** Inputs the pure item list is built from (fabricated directly in unit tests). */
export interface RowMenuModel {
  isPinned: boolean;
  currentGroupId: string | null;
  groups: { id: string; name: string }[];
  onTogglePin: () => void;
  onOpenProfile: () => void;
  onNewSession: () => void;
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroup: () => void;
}

/**
 * Build the ordered agent-row menu items from a model. Pure — exported so the
 * item definitions can be asserted directly and shared by both menu variants.
 *
 * @param model - Pin/group state plus the action callbacks.
 * @internal Exported for testing and cross-variant rendering.
 */
export function buildRowMenuNodes(model: RowMenuModel): RowMenuNode[] {
  const groupTargets: RowMenuNode[] = model.groups.map((g) => ({
    type: 'checkItem',
    key: `group-${g.id}`,
    label: g.name,
    checked: g.id === model.currentGroupId,
    onSelect: () => model.onMoveToGroup(g.id),
  }));

  const moveItems: RowMenuNode[] = [
    ...groupTargets,
    ...(model.currentGroupId !== null
      ? [
          {
            type: 'item' as const,
            key: 'remove-from-group',
            label: 'Remove from group',
            icon: FolderMinus,
            onSelect: () => model.onMoveToGroup(null),
          },
        ]
      : []),
    { type: 'separator', key: 'move-sep' },
    {
      type: 'item',
      key: 'new-group',
      label: 'New group…',
      icon: FolderPlus,
      onSelect: model.onNewGroup,
    },
  ];

  return [
    {
      type: 'item',
      key: 'pin',
      label: model.isPinned ? 'Unpin agent' : 'Pin agent',
      icon: model.isPinned ? PinOff : Pin,
      onSelect: model.onTogglePin,
    },
    {
      type: 'sub',
      key: 'move-to-group',
      label: 'Move to group',
      icon: FolderInput,
      items: moveItems,
    },
    { type: 'separator', key: 'sep-1' },
    {
      type: 'item',
      key: 'profile',
      label: 'Agent profile',
      icon: User,
      onSelect: model.onOpenProfile,
    },
    { type: 'separator', key: 'sep-2' },
    {
      type: 'item',
      key: 'new-session',
      label: 'New session',
      icon: Plus,
      onSelect: model.onNewSession,
    },
  ];
}

/**
 * Slot primitives one menu family provides. Both variants render through the
 * SAME {@link renderNodes} walk — only the primitives differ — so the two menus
 * cannot structurally drift.
 */
interface RowMenuSlots {
  Item: ElementType;
  CheckboxItem: ElementType;
  Separator: ElementType;
  Sub: ElementType;
  SubTrigger: ElementType;
  SubContent: ElementType;
}

const VARIANT_SLOTS: Record<AgentRowMenuVariant, RowMenuSlots> = {
  context: {
    Item: ContextMenuItem,
    CheckboxItem: ContextMenuCheckboxItem,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
};

/** Render the shared nodes through one generic walk using the given slots. */
function renderNodes(nodes: RowMenuNode[], slots: RowMenuSlots): ReactNode {
  const { Item, CheckboxItem, Separator, Sub, SubTrigger, SubContent } = slots;
  return nodes.map((node) => {
    switch (node.type) {
      case 'separator':
        return <Separator key={node.key} />;
      case 'item': {
        const Icon = node.icon;
        return (
          <Item key={node.key} onClick={node.onSelect}>
            <Icon className="mr-2 size-4" />
            {node.label}
          </Item>
        );
      }
      case 'checkItem':
        return (
          <CheckboxItem key={node.key} checked={node.checked} onClick={node.onSelect}>
            {node.label}
          </CheckboxItem>
        );
      case 'sub': {
        const Icon = node.icon;
        return (
          <Sub key={node.key}>
            <SubTrigger>
              <Icon className="mr-2 size-4" />
              {node.label}
            </SubTrigger>
            <SubContent className="w-48">{renderNodes(node.items, slots)}</SubContent>
          </Sub>
        );
      }
    }
  });
}

interface AgentRowMenuItemsProps {
  /** Agent projectPath the menu acts on. */
  path: string;
  /** Which Radix menu family to render into. */
  variant: AgentRowMenuVariant;
  /** Open the agent's profile in the right-panel hub. */
  onOpenProfile: () => void;
  /** Start a new session for this agent. */
  onNewSession: () => void;
  /** Open the inline group-create flow, moving this agent into the new group on commit. */
  onRequestNewGroup: (agentPath: string) => void;
}

/**
 * The agent-row menu, rendered from ONE item definition into both the right-click
 * ContextMenu and the "…" DropdownMenu. Pin/Unpin and Move-to-group read and
 * mutate `ui.sidebar` directly (optimistic), so callers only supply the row
 * actions the sidebar owns.
 */
export function AgentRowMenuItems({
  path,
  variant,
  onOpenProfile,
  onNewSession,
  onRequestNewGroup,
}: AgentRowMenuItemsProps) {
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();

  const isPinned = prefs.pinned.includes(path);
  const currentGroupId = prefs.groups.find((g) => g.agentPaths.includes(path))?.id ?? null;

  const nodes = buildRowMenuNodes({
    isPinned,
    currentGroupId,
    groups: prefs.groups.map((g) => ({ id: g.id, name: g.name })),
    onTogglePin: () => update((prev) => (isPinned ? unpinPath(prev, path) : pinPath(prev, path))),
    onOpenProfile,
    onNewSession,
    onMoveToGroup: (groupId) => update((prev) => moveToGroup(prev, path, groupId)),
    onNewGroup: () => onRequestNewGroup(path),
  });

  return <>{renderNodes(nodes, VARIANT_SLOTS[variant])}</>;
}
