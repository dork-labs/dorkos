import type { ReactNode } from 'react';
import { Pencil, GitFork } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/layers/shared/ui';

interface SessionContextMenuProps {
  children: ReactNode;
  onRename?: () => void;
  onFork?: () => void;
}

/**
 * Right-click / long-press context menu for session rows.
 *
 * Menu items are conditionally rendered based on which callbacks are provided.
 * When neither callback is provided, the trigger renders without a menu wrapper
 * to avoid empty context menus.
 */
export function SessionContextMenu({ children, onRename, onFork }: SessionContextMenuProps) {
  if (!onRename && !onFork) return <>{children}</>;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {onRename && (
          <ContextMenuItem onClick={onRename}>
            <Pencil className="mr-2 size-4" />
            Rename
          </ContextMenuItem>
        )}
        {onRename && onFork && <ContextMenuSeparator />}
        {onFork && (
          <ContextMenuItem onClick={onFork}>
            <GitFork className="mr-2 size-4" />
            Fork session
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
