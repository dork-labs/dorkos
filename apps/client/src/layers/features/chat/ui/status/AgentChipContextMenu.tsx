import type { ReactNode } from 'react';
import { ArrowLeftRight, Plus, UserRound } from 'lucide-react';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuTrigger,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
} from '@/layers/shared/ui';

interface AgentChipContextMenuProps {
  children: ReactNode;
  onSwitchAgent: () => void;
  /** View this agent's profile — the same act the chip's own click performs. */
  onViewProfile: () => void;
  onNewSession: () => void;
}

/**
 * Context menu for the agent identity chip in the chat input area.
 *
 * Desktop: right-click. Mobile: long-press opens drawer.
 *
 * "View profile" is here as well as on the chip's own click because a
 * right-click menu that omits what the control already does reads as a menu of
 * OTHER things, and a person who reached for the menu has to guess. One verb,
 * one destination — the same one every other face in the cockpit opens.
 */
export function AgentChipContextMenu({
  children,
  onSwitchAgent,
  onViewProfile,
  onNewSession,
}: AgentChipContextMenuProps) {
  return (
    <ResponsiveContextMenu>
      {/* `min-w-0` is load-bearing, not cosmetic. Radix wraps the trigger in a
          `display: block` span of its own, and a block with the default
          `min-width: auto` sizes to its min-content — so the chip's name kept its
          full width while the flex row squeezed the box around it, and the name
          painted over the directory beside it (DOR-461). The truncation inside
          `AgentIdentity` only engages once every box above it may shrink. */}
      <ResponsiveContextMenuTrigger className="min-w-0">{children}</ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-48">
        <ResponsiveContextMenuItem onClick={onSwitchAgent}>
          <ArrowLeftRight className="mr-2 size-4" />
          Switch agent
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={onViewProfile}>
          <UserRound className="mr-2 size-4" />
          View profile
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={onNewSession}>
          <Plus className="mr-2 size-4" />
          New session
        </ResponsiveContextMenuItem>
      </ResponsiveContextMenuContent>
    </ResponsiveContextMenu>
  );
}
