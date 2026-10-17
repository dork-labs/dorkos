import type { ReactNode } from 'react';
import { CopyPlus, History, Link, Pin, PinOff, RotateCcw, X, XCircle } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/layers/shared/ui';
import { formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import { useRecentlyClosed } from '../model/recently-closed';
import { useTabIdentity } from '../model/use-tab-identity';

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
  /**
   * Bring back a closed tab: the newest, or entry `index` of Recently closed.
   * Absent where there is nothing to reopen from (the Dev Playground).
   */
  reopenClosed?: (index?: number) => void;
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
  /**
   * Called as the menu closes, in place of its own focus restore — the strip
   * puts focus on whichever tab is on screen after the action.
   */
  onClosed?: () => void;
  /** The tab. Must be a single element that takes a ref (the trigger is `asChild`). */
  children: ReactNode;
}

/** One Recently closed entry, named the way its tab was. */
function RecentlyClosedItem({ href, onSelect }: { href: string; onSelect: () => void }) {
  const identity = useTabIdentity(href);
  return (
    <ContextMenuItem onSelect={onSelect}>
      <span className="truncate">{identity.primary}</span>
      {identity.secondary && (
        <span className="text-muted-foreground ml-1.5 truncate">{identity.secondary}</span>
      )}
    </ContextMenuItem>
  );
}

/**
 * The right-click menu on a tab: Pin or Unpin, Duplicate, Copy link, Close
 * others, Close, and the way back — Reopen closed tab and Recently closed.
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
  onClosed,
  children,
}: AppTabContextMenuProps) {
  const recentlyClosed = useRecentlyClosed();
  const { reopenClosed } = actions;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-56"
        onCloseAutoFocus={
          onClosed
            ? (event) => {
                event.preventDefault();
                onClosed();
              }
            : undefined
        }
      >
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
        {reopenClosed && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={recentlyClosed.length === 0} onSelect={() => reopenClosed()}>
              <RotateCcw className="mr-2 size-4" />
              Reopen closed tab
              <kbd className="text-muted-foreground ml-auto pl-4 text-xs">
                {formatShortcutKey(SHORTCUTS.REOPEN_CLOSED_TAB)}
              </kbd>
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={recentlyClosed.length === 0}>
                <History className="mr-2 size-4" />
                Recently closed
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-96 w-64 overflow-y-auto">
                {recentlyClosed.map((entry, index) => (
                  <RecentlyClosedItem
                    key={`${entry.tab.id}-${entry.closedAt}`}
                    href={entry.tab.href}
                    onSelect={() => reopenClosed(index)}
                  />
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
