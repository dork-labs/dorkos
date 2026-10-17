/**
 * The words the comments panel says about a thread's place in the text and
 * about a mention that woke nobody (DOR-2983). Pure, so a test can read them.
 *
 * @module features/docs/lib/comment-copy
 */
import type { DocCommentUnreached } from '@dorkos/shared/doc-comments';

/** How a thread sits in the text now, as the editor placed it. */
export type ThreadPlacement = 'exact' | 'moved' | 'ambiguous' | 'orphaned';

/**
 * The note a thread card shows about its place, or `null` when it needs none.
 *
 * @param placement - How the editor placed it.
 */
export function placementNote(placement: ThreadPlacement): string | null {
  switch (placement) {
    case 'ambiguous':
      return 'These words appear more than once. Check the highlight.';
    case 'orphaned':
      return 'The words this was on were removed.';
    default:
      return null;
  }
}

/**
 * One sentence for a mentioned agent the comment did not wake.
 *
 * @param unreached - Who, and why.
 */
export function unreachedNote({ name, reason }: DocCommentUnreached): string {
  return reason === 'unavailable'
    ? `${name} couldn’t take it right now. Try again later.`
    : `${name} wasn’t woken. The reply limit was reached.`;
}
