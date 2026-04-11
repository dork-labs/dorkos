import type { ReactNode } from 'react';
import { Pin, PinOff, ListTree, Settings, Plus } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/layers/shared/ui';

interface AgentContextMenuProps {
  children: ReactNode;
  agentPath: string;
  isPinned: boolean;
  onTogglePin: () => void;
  onManage: () => void;
  onEditSettings: () => void;
  onNewSession: () => void;
}

/**
 * Right-click / long-press context menu for agent rows.
 *
 * Wraps children in a Radix ContextMenu trigger. Desktop: right-click.
 * Mobile: long-press (native Radix pointer event handling).
 *
 * Menu items:
 * 1. Pin agent / Unpin agent (toggles based on isPinned)
 * 2. ---separator---
 * 3. Manage agent (navigates to Session Sidebar)
 * 4. Edit settings (opens AgentDialog)
 * 5. ---separator---
 * 6. New session
 */
export function AgentContextMenu({
  children,
  isPinned,
  onTogglePin,
  onManage,
  onEditSettings,
  onNewSession,
}: AgentContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onTogglePin}>
          {isPinned ? (
            <>
              <PinOff className="mr-2 size-4" />
              Unpin agent
            </>
          ) : (
            <>
              <Pin className="mr-2 size-4" />
              Pin agent
            </>
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onManage}>
          <ListTree className="mr-2 size-4" />
          Manage agent
        </ContextMenuItem>
        <ContextMenuItem onClick={onEditSettings}>
          <Settings className="mr-2 size-4" />
          Edit settings
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onNewSession}>
          <Plus className="mr-2 size-4" />
          New session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
