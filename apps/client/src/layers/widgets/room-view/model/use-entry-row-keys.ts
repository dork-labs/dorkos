/**
 * Stepping off a message into one of the two button groups it holds.
 *
 * The row is the single tab stop (see `EntryActionBar`), so every way into its
 * buttons is a key pressed on the message itself — which makes "which key
 * reaches which group" one rule, kept here rather than inline in the row's
 * markup.
 *
 * @module widgets/room-view/model/use-entry-row-keys
 */
import type { KeyboardEvent, RefObject } from 'react';
import type { EntryActionBarHandle, RovingGroupHandle } from '@/layers/features/entry-actions';

interface EntryRowKeyOptions {
  /** The capsule above the message — ArrowRight and Enter land here. */
  barRef: RefObject<EntryActionBarHandle | null>;
  /** The pills below the message — ArrowDown lands here, when there are any. */
  pillsRef: RefObject<RovingGroupHandle | null>;
  /** False when the message has no pills, and therefore no group below it. */
  hasReactions: boolean;
}

/**
 * From the message itself, an arrow or Enter moves into its buttons.
 *
 * A message has two groups and the key says which: ArrowRight and Enter reach
 * the capsule above it, ArrowDown reaches the pills below it. A message with
 * no pills has no down group, and then **ArrowDown is left alone** — it
 * scrolls, which is what an arrow key on a page of text is for.
 *
 * That is the difference from how the row shipped, and it is deliberate
 * (DOR-757, N-f). ArrowUp and ArrowDown used to be swallowed into the capsule
 * by every message, so a keyboard reader who focused a message longer than the
 * window could not scroll through it without leaving the message first. The
 * capsule keeps two ways in that nothing else wants, and the arrows go back to
 * the reader.
 *
 * A hook rather than a plain factory, because the two group handles reach it as
 * refs: a ref handed to an ordinary function during render is a value that
 * function could read before it exists, and the rule that says so is right —
 * this one is only ever read from a key press, which is what a hook boundary
 * lets the compiler see.
 *
 * @param options - The two groups' handles, and whether the lower one exists.
 */
export function useEntryRowKeys({
  barRef,
  pillsRef,
  hasReactions,
}: EntryRowKeyOptions): (event: KeyboardEvent<HTMLDivElement>) => void {
  return (event) => {
    if (event.target !== event.currentTarget) return;
    const { key } = event;
    if (key === 'ArrowDown' && hasReactions) {
      event.preventDefault();
      pillsRef.current?.focusFirst();
      return;
    }
    if (key !== 'ArrowRight' && key !== 'Enter') return;
    event.preventDefault();
    barRef.current?.focusFirst();
  };
}
