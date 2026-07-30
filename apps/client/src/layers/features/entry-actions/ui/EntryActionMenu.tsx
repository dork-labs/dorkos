import type { ReactNode } from 'react';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuTrigger,
} from '@/layers/shared/ui';
import type { EntryAction } from '../lib/entry-actions';

interface EntryActionMenuProps {
  /** The same actions the toolbar draws, in the same order. */
  actions: EntryAction[];
  /** The message row this menu belongs to. */
  children: ReactNode;
}

/**
 * The pointer-summoned half of a message's action surface: right-click on a
 * desktop, long-press on a touch screen.
 *
 * Both come from `ResponsiveContextMenu`, which is the same component the
 * session rows and the file tree already use — so a right-click means the same
 * thing everywhere in the cockpit, and a long-press opens the same kind of
 * bottom drawer. One dialect, not two.
 *
 * It renders the action set unchanged. A menu that offered something the
 * toolbar did not would make "what can I do to this message?" a question with
 * two answers depending on how you asked.
 */
export function EntryActionMenu({ actions, children }: EntryActionMenuProps) {
  // No menu at all rather than an empty one — the trigger still has to render,
  // because it IS the message. Matches `SessionContextMenu`.
  if (actions.length === 0) return <>{children}</>;

  return (
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild>{children}</ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-52">
        {actions.map((action) => (
          <ResponsiveContextMenuItem key={action.id} onClick={action.run}>
            <action.icon aria-hidden className="mr-2 size-4" />
            {action.label}
          </ResponsiveContextMenuItem>
        ))}
      </ResponsiveContextMenuContent>
    </ResponsiveContextMenu>
  );
}
