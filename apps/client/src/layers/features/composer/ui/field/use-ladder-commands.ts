/**
 * Wiring the composer's keyboard ladder into Lexical's command system.
 *
 * **Why priority and not ordering luck.** React 19 attaches synthetic listeners
 * at the root container; Lexical registers native listeners on the
 * contenteditable itself. A native Lexical handler therefore runs in the target
 * phase, before React's delegated `onKeyDown` ever fires at the root. Left
 * alone, Lexical inserts a paragraph on Enter before `use-input-keyboard` runs
 * and the message never sends. Registering at `COMMAND_PRIORITY_CRITICAL` — the
 * highest — is what puts the ladder ahead of Lexical's own rich-text handlers.
 *
 * **`false` is load-bearing.** A handler returns Lexical's `true` for "consumed,
 * stop" and `false` for "I did not act, carry on". The `false` return is the
 * whole of locked decision 2: it is how Enter continues a list.
 *
 * @module features/composer/ui/field/use-ladder-commands
 */
import { useEffect } from 'react';
import { $isListItemNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from 'lexical';
import type { EditingSurface } from '../editing-surface';
import { countTrailingBackslashes } from '../use-input-keyboard';

/** What the command layer needs to run the ladder. */
export interface UseLadderCommandsOptions {
  /** The ladder, already built by `ComposerInput`. */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** This field's editing surface, or `null` until it exists. */
  surface: EditingSurface | null;
  isPaletteOpen?: boolean;
  paletteHasResults?: boolean;
}

/**
 * Run the ladder against a native keyboard event.
 *
 * The ladder marks a key it consumed with `preventDefault()` and deliberately
 * does NOT `stopPropagation` — an enclosing thread panel reads
 * `defaultPrevented` to decide whether the key was already spoken for. Lexical
 * hands us the ORIGINAL `KeyboardEvent`, so `preventDefault` lands on the same
 * object it does on the textarea path and the bubbling behaviour is unchanged.
 *
 * @param event - Lexical's keyboard event.
 * @param onKeyDown - The ladder.
 * @returns Whether the ladder consumed the key.
 */
function runLadder(event: KeyboardEvent, onKeyDown: (event: React.KeyboardEvent) => void): boolean {
  let consumed = false;
  const shim = {
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    keyCode: event.keyCode,
    nativeEvent: event,
    get defaultPrevented() {
      return consumed;
    },
    preventDefault() {
      consumed = true;
      event.preventDefault();
    },
  };

  onKeyDown(shim as unknown as React.KeyboardEvent);
  return consumed;
}

/**
 * Whether the caret sits inside a list item.
 *
 * The anchor node itself is checked, not only its ancestors, and that is the
 * whole of it: in a NON-empty item the anchor is the text node and the item is
 * one of its parents, but in an EMPTY item there is no text node and the anchor
 * IS the `ListItemNode`. `getParents()` never includes the node it was called
 * on, so an ancestors-only check answered `false` on exactly the item Enter is
 * supposed to exit from — and the exit rung was unreachable.
 */
function $isCaretInListItem(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const anchor = selection.anchor.getNode();
  return $isListItemNode(anchor) || anchor.getParents().some($isListItemNode);
}

/**
 * Whether Enter belongs to the list rather than to the ladder.
 *
 * These are rows six and seven of the Enter table, and they sit exactly where
 * they do for a reason: BELOW the palette rung, because a `/` palette open
 * inside a list item is still a palette and Enter still picks the row; and
 * ABOVE the send rungs, which is what "Enter never sends from inside a list"
 * means. Each guard below names the row that owns the key instead.
 *
 * Rows six and seven collapse to one answer here on purpose. Whether the item
 * is empty decides whether Lexical continues the list or exits it, and that is
 * `ListPlugin`'s decision, not ours — we only decline the key.
 *
 * @param event - The keydown under consideration.
 * @param options - The palette state and this field's surface.
 * @returns `true` when the ladder must not be consulted.
 */
function deferToList(
  event: KeyboardEvent,
  { surface, isPaletteOpen, paletteHasResults }: UseLadderCommandsOptions
): boolean {
  if (surface === null) return false;
  // Row 1 — an IME composition owns the key.
  if (event.isComposing || surface.isComposing()) return false;
  // Rows 2 and 3 — Alt+Enter and Shift+Enter are already line breaks.
  if (event.altKey || event.shiftKey) return false;
  // Row 5 — an open palette with rows to pick.
  if (isPaletteOpen && paletteHasResults) return false;
  // Row 4 — the backslash continuation, read through the shared rule so there
  // is one copy of the odd/even arithmetic in the codebase.
  const before = surface.textBeforeCaret();
  if (before !== null && countTrailingBackslashes(before) % 2 === 1) return false;

  return $isCaretInListItem();
}

/**
 * Register the ladder ahead of Lexical's own handlers.
 *
 * | Lexical command | What the ladder does |
 * | --- | --- |
 * | `KEY_ESCAPE_COMMAND` | The whole Escape ladder. `true` on every rung that acts. |
 * | `KEY_ENTER_COMMAND` | The Enter table, with the two list rows in front. |
 * | `KEY_ARROW_UP_COMMAND` | Queue navigation when the caret is at the start. |
 * | `KEY_ARROW_DOWN_COMMAND` | Queue navigation when the caret is at the end. |
 * | `KEY_TAB_COMMAND` | Palette pick when a palette is open with results. |
 *
 * One `mergeRegister`, so one cleanup unregisters all five.
 *
 * @param options - The ladder, the surface, and the palette state.
 */
export function useLadderCommands(options: UseLadderCommandsOptions): void {
  const [editor] = useLexicalComposerContext();
  const { onKeyDown, surface, isPaletteOpen, paletteHasResults } = options;

  useEffect(() => {
    const ladder = (event: KeyboardEvent | null): boolean =>
      event === null ? false : runLadder(event, onKeyDown);

    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null) return false;
          if (deferToList(event, { onKeyDown, surface, isPaletteOpen, paletteHasResults })) {
            return false;
          }
          return runLadder(event, onKeyDown);
        },
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(KEY_ESCAPE_COMMAND, ladder, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, ladder, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, ladder, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_TAB_COMMAND, ladder, COMMAND_PRIORITY_CRITICAL)
    );
  }, [editor, onKeyDown, surface, isPaletteOpen, paletteHasResults]);
}
