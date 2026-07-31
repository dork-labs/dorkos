/**
 * The roving-tabindex mechanics both halves of a message's action surface use.
 *
 * A message carries two groups of buttons — the capsule above it and the
 * reaction pills below — and neither may cost a Tab. The rule that makes that
 * true is the same for both: every button is `tabIndex={-1}`, the MESSAGE is the
 * tab stop, arrows move within a group, and Escape hands focus back. Written
 * once here so the two groups cannot drift into two keyboard dialects.
 *
 * @module features/entry-actions/model/use-roving-buttons
 */
import { useCallback, useImperativeHandle, useRef, type KeyboardEvent, type Ref } from 'react';

/** What a message row can ask one of its button groups to do. */
export interface RovingGroupHandle {
  /** Move focus onto the first button in the group. */
  focusFirst: () => void;
}

/** What the group's renderer needs to wire each button up. */
export interface RovingButtons {
  /** A ref callback registering the button at `index`. */
  register: (index: number) => (node: HTMLButtonElement | null) => void;
  /** The group's arrow / Home / End / Escape handling for the button at `index`. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>, index: number) => void;
}

/**
 * Wire a group of buttons into one roving tab stop.
 *
 * Arrows move along the group and wrap at both ends, Home and End jump to the
 * edges, and Escape leaves — prevented AND stopped, because Escape in a room
 * otherwise carries on up to the composer's own double-press draft wipe.
 *
 * @param count - How many buttons the group holds this render.
 * @param onExit - Where Escape goes; the message row focuses itself.
 * @param handleRef - Optional handle the row uses to step INTO the group.
 * @returns The registrar and key handler the renderer applies to each button.
 */
export function useRovingButtons(
  count: number,
  onExit: () => void,
  handleRef?: Ref<RovingGroupHandle>
): RovingButtons {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

  useImperativeHandle(handleRef, () => ({
    focusFirst: () => buttonsRef.current[0]?.focus(),
  }));

  const register = useCallback(
    (index: number) => (node: HTMLButtonElement | null) => {
      buttonsRef.current[index] = node;
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, index: number) => {
      /** Move focus `delta` places along, wrapping at both ends. */
      const step = (from: number, delta: number) => {
        if (count === 0) return;
        buttonsRef.current[(from + delta + count) % count]?.focus();
      };

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
        // Home and End belong to the GROUP; Ctrl+Home and Ctrl+End belong to
        // the feed around it, which is how a reader leaves a room's history
        // altogether. Taking the modified press here would swallow the feed's
        // only way out at whichever button happened to have focus.
        case 'Home':
          if (event.ctrlKey || event.metaKey) break;
          event.preventDefault();
          step(0, 0);
          break;
        case 'End':
          if (event.ctrlKey || event.metaKey) break;
          event.preventDefault();
          step(count - 1, 0);
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          onExit();
          break;
        default:
          break;
      }
    },
    [count, onExit]
  );

  return { register, handleKeyDown };
}
