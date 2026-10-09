import type { ReactNode } from 'react';
import { CopyPlus, Link, Pin, PinOff, X, XCircle } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/layers/shared/ui';

/** What the tab menu can do. Each takes the id of the tab it was opened on. */
export interface AppTabMenuActions {
  /** Pin the tab, or unpin it when it is pinned. */
  togglePin: (id: string) => void;
  /** Open a copy of the tab right after it. */
  duplicate: (id: string) => void;
  /** Put a link to the tab's page on the clipboard. */
  copyLink: (id: string) => void;
  /** Close every other unpinned tab. */
  closeOthers: (id: string) => void;
  /** Close the tab. */
  close: (id: string) => void;
}

interface AppTabContextMenuProps {
  /** The tab the menu belongs to. */
  tabId: string;
  /** Whether that tab is pinned — picks Pin or Unpin. */
  pinned: boolean;
  /** Whether "Close others" has anything to close. */
  hasOthersToClose: boolean;
  /** Whether the tab itself may close (false for the last tab). */
  canClose: boolean;
  /** What the items do. */
  actions: AppTabMenuActions;
  /** The tab. Must be a single element that takes a ref (the trigger is `asChild`). */
  children: ReactNode;
}

/**
 * The right-click menu on a tab: Pin or Unpin, Duplicate, Copy link, Close
 * others, Close.
 *
 * A plain context menu rather than the responsive one: the strip only exists in
 * the desktop app, where a narrow window is still a mouse and a keyboard, and a
 * drawer sliding up from the bottom of a desktop window would be the wrong
 * shape. The keyboard reaches it with Shift+F10 or the context-menu key, which
 * the strip turns into the same `contextmenu` event a right-click makes.
 *
 * "Close" is here even though the spec's list ends at "Close others": a pinned
 * tab has no close control of its own, and without this item the mouse could
 * only close one by unpinning it first.
 */
export function AppTabContextMenu({
  tabId,
  pinned,
  hasOthersToClose,
  canClose,
  actions,
  children,
}: AppTabContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => actions.togglePin(tabId)}>
          {pinned ? <PinOff className="mr-2 size-4" /> : <Pin className="mr-2 size-4" />}
          {pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.duplicate(tabId)}>
          <CopyPlus className="mr-2 size-4" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyLink(tabId)}>
          <Link className="mr-2 size-4" />
          Copy link
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasOthersToClose} onSelect={() => actions.closeOthers(tabId)}>
          <XCircle className="mr-2 size-4" />
          Close others
        </ContextMenuItem>
        <ContextMenuItem disabled={!canClose} onSelect={() => actions.close(tabId)}>
          <X className="mr-2 size-4" />
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
