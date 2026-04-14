import type { ReactNode } from 'react';
import { ArrowLeftRight, User, Plus } from 'lucide-react';
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
  onOpenProfile: () => void;
  onNewSession: () => void;
}

/**
 * Context menu for the agent identity chip in the chat input area.
 *
 * Desktop: right-click. Mobile: long-press opens drawer.
 */
export function AgentChipContextMenu({
  children,
  onSwitchAgent,
  onOpenProfile,
  onNewSession,
}: AgentChipContextMenuProps) {
  return (
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild>{children}</ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-48">
        <ResponsiveContextMenuItem onClick={onSwitchAgent}>
          <ArrowLeftRight className="mr-2 size-4" />
          Switch agent
        </ResponsiveContextMenuItem>
        <ResponsiveContextMenuSeparator />
        <ResponsiveContextMenuItem onClick={onOpenProfile}>
          <User className="mr-2 size-4" />
          Agent profile
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
