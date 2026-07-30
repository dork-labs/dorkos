import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { Button } from '@/layers/shared/ui';
import type { EntryAction } from '../lib/entry-actions';

/** What the message row can ask the toolbar to do. */
export interface EntryActionBarHandle {
  /** Move focus onto the first action. */
  focusFirst: () => void;
}

interface EntryActionBarProps {
  /** What this message offers, in order. Never rendered when empty. */
  actions: EntryAction[];
  /** Hand focus back to the message — the way out, bound to Escape. */
  onExit: () => void;
  /** The toolbar's own look, supplied by the row so anchoring stays with layout. */
  className?: string;
}

/**
 * The action toolbar for one message.
 *
 * Icon-only, because it sits over the message it acts on and words there would
 * cover what you are reading. Each button carries the action's full label as its
 * accessible name and its tooltip, so the name a screen reader speaks and the
 * name a pointer reveals are the same string — the one from the action set,
 * which the right-click menu and the touch drawer also render.
 *
 * **Roving tabindex, so a message costs one Tab however many ACTIONS it has.**
 * Every button is `tabIndex={-1}`; the MESSAGE is the tab stop, and the actions
 * are reached from it with an arrow key or Enter, moved between with arrows, and
 * left with Escape. Tab from anywhere in the toolbar goes on to the next message,
 * because there is nothing tabbable in here to catch it. What a message says can
 * still add stops of its own — a link renders as a button — which is the same in
 * session chat and not this surface's to change.
 *
 * The alternative — making the buttons tabbable only while the row has focus —
 * reads like it would work and does nothing: focusing the row makes its buttons
 * tabbable in the same tick, so the very next Tab lands on the first one anyway
 * and a room of fifty messages still costs a hundred and fifty presses. The tab
 * order has to be closed for the count to change, which is what `-1` is doing.
 */
export const EntryActionBar = forwardRef<EntryActionBarHandle, EntryActionBarProps>(
  function EntryActionBar({ actions, onExit, className }, ref) {
    const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

    useImperativeHandle(ref, () => ({
      focusFirst: () => buttonsRef.current[0]?.focus(),
    }));

    /** Move focus to the action `delta` places along, wrapping at both ends. */
    const step = (from: number, delta: number) => {
      const count = actions.length;
      if (count === 0) return;
      buttonsRef.current[(from + delta + count) % count]?.focus();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          step(index, 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          step(index, -1);
          break;
        case 'Home':
          event.preventDefault();
          step(0, 0);
          break;
        case 'End':
          event.preventDefault();
          step(actions.length - 1, 0);
          break;
        case 'Escape':
          // Stopped as well as prevented: Escape in a room otherwise carries on
          // up to the composer's own double-press draft wipe.
          event.preventDefault();
          event.stopPropagation();
          onExit();
          break;
        default:
          break;
      }
    };

    if (actions.length === 0) return null;

    return (
      <div
        role="toolbar"
        aria-label="Message actions"
        aria-orientation="horizontal"
        data-testid="entry-actions"
        className={className}
      >
        {actions.map((action, index) => (
          <Button
            key={action.id}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            type="button"
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-label={action.label}
            title={action.label}
            onClick={action.run}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <action.icon aria-hidden className="size-3.5" />
          </Button>
        ))}
      </div>
    );
  }
);
