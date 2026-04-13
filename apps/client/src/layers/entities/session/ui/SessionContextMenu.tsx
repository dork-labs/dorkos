import type { ReactNode } from 'react';
import { Pencil, GitFork } from 'lucide-react';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuTrigger,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
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
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild>{children}</ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-44">
        {onRename && (
          <ResponsiveContextMenuItem onClick={onRename}>
            <Pencil className="mr-2 size-4" />
            Rename
          </ResponsiveContextMenuItem>
        )}
        {onRename && onFork && <ResponsiveContextMenuSeparator />}
        {onFork && (
          <ResponsiveContextMenuItem onClick={onFork}>
            <GitFork className="mr-2 size-4" />
            Fork session
          </ResponsiveContextMenuItem>
        )}
      </ResponsiveContextMenuContent>
    </ResponsiveContextMenu>
  );
}
