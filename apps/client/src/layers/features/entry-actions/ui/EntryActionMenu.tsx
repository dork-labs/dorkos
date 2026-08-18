import { useState, type ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile, type LongPressState } from '@/layers/shared/model';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuTrigger,
  useResponsiveContextMenu,
} from '@/layers/shared/ui';
import { emojiLabel } from '../lib/emoji-catalog';
import type { EntryAction } from '../lib/entry-actions';
import { EntryReactionGrid } from './EntryReactionPicker';

/** The quick-reaction half of the surface, when this message offers one. */
export interface EntryActionMenuReactions {
  /** This reader's three most-used emoji, most-used first. */
  quick: readonly string[];
  /** Which emoji this reader has already put on this message. */
  mine: readonly string[];
  /** Put one on, or take it back. */
  onToggle: (emoji: string) => void;
  /** True when reacting cannot land — a room whose stream has died. */
  disabled?: boolean;
}

interface EntryActionMenuProps {
  /** The same actions the toolbar draws, in the same order. */
  actions: EntryAction[];
  /** The quick row the touch drawer opens with. Omitted where it does not belong. */
  reactions?: EntryActionMenuReactions;
  /** Told how the long press is going, so the message can give under the finger. */
  onPressStateChange?: (state: LongPressState) => void;
  /** The message row this menu belongs to. */
  children: ReactNode;
}

/**
 * The reaction row across the top of the touch drawer.
 *
 * The drawer's own first row rather than a list item, because reacting is a
 * one-tap act and a list of six emoji rows would bury the three that matter. The
 * 🙂+ opens the same searchable grid the pointer's popover shows — inline here,
 * because a popover over a drawer is two overlays deep on the surface with the
 * least room for them.
 */
function DrawerReactionRow({ quick, mine, onToggle, disabled }: EntryActionMenuReactions) {
  const { close } = useResponsiveContextMenu();
  const [picking, setPicking] = useState(false);

  /** React and get out of the way — the pill IS the confirmation. */
  const pick = (emoji: string) => {
    onToggle(emoji);
    close();
  };

  return (
    <div className="border-border border-b px-4 py-3" data-testid="drawer-reactions">
      <div className="flex items-center gap-2">
        {quick.map((emoji) => (
          <button
            key={emoji}
            type="button"
            disabled={disabled}
            onClick={() => pick(emoji)}
            data-entry-action="react"
            data-emoji={emoji}
            aria-pressed={mine.includes(emoji)}
            aria-label={`React with ${emojiLabel(emoji)}`}
            className={cn(
              'focus-ring flex size-11 items-center justify-center rounded-full border text-lg',
              'motion-safe:transition-transform motion-safe:active:scale-95',
              'disabled:pointer-events-none disabled:opacity-50',
              mine.includes(emoji)
                ? 'border-brand/70 bg-brand/12'
                : 'border-border bg-muted/60 active:bg-accent'
            )}
          >
            <span aria-hidden>{emoji}</span>
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setPicking((open) => !open)}
          aria-expanded={picking}
          aria-label="Pick a reaction"
          className={cn(
            'focus-ring border-border bg-muted/60 active:bg-accent flex size-11 items-center justify-center rounded-full border text-base',
            'motion-safe:transition-transform motion-safe:active:scale-95',
            'disabled:pointer-events-none disabled:opacity-50'
          )}
        >
          <span aria-hidden>🙂+</span>
        </button>
      </div>
      {picking && (
        <div className="pt-3">
          <EntryReactionGrid mine={mine} frequents={quick} onPick={pick} disabled={disabled} />
        </div>
      )}
    </div>
  );
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
 * two answers depending on how you asked. **Reactions are the one thing drawn
 * differently rather than differently offered**: the same emoji the capsule
 * holds, across the top of the drawer as a row of taps rather than as six list
 * rows — and only on touch, because a pointer already has the capsule.
 *
 * The two menu-opening slots (`react-more`, `run-with`) are not list items
 * here, for one reason each: the picker has the drawer's own reaction row
 * instead, and a menu that opens a second menu is a shape neither the
 * right-click menu nor the touch drawer has anywhere to put.
 */
export function EntryActionMenu({
  actions,
  reactions,
  onPressStateChange,
  children,
}: EntryActionMenuProps) {
  const isMobile = useIsMobile();

  // No menu at all rather than an empty one — the trigger still has to render,
  // because it IS the message. Matches `SessionContextMenu`.
  if (actions.length === 0) return <>{children}</>;

  return (
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild onPressStateChange={onPressStateChange}>
        {children}
      </ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent className="w-52">
        {isMobile && reactions && <DrawerReactionRow {...reactions} />}
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
