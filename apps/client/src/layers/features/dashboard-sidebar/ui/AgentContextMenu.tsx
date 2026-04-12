import type { ReactNode } from 'react';
import { Pin, PinOff, User, Plus } from 'lucide-react';
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
  onOpenProfile: () => void;
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
 * 3. Agent profile (opens Agent Hub in right panel)
 * 4. ---separator---
 * 5. New session
 */
export function AgentContextMenu({
  children,
  isPinned,
  onTogglePin,
  onOpenProfile,
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
        <ContextMenuItem onClick={onOpenProfile}>
          <User className="mr-2 size-4" />
          Agent profile
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
