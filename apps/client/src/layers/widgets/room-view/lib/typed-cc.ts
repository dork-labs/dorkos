/**
 * Which cc mentions the writer already introduced with the word "cc".
 *
 * @module widgets/room-view/lib/typed-cc
 */
import type { AddressableSpan } from '@dorkos/shared/mention-addressing';

/** The word "cc" ending the text before a mention, whitespace ignored, any case. */
const ENDS_WITH_CC = /(?:^|[^\p{L}\p{N}_])cc$/iu;

/**
 * Author ids whose cc span follows the typed word "cc".
 *
 * A cc pill says "cc" itself, so after a typed "cc" it would read "cc cc Orrin".
 * Only the word immediately before the mention counts: in "cc @orrin @lumen"
 * Orrin follows the word and Lumen follows a pill, so Lumen keeps its own cc.
 *
 * @param text - The entry's raw text, which the span offsets index into.
 * @param spans - The entry's mention spans, cc marks included.
 */
export function typedCcAuthors(
  text: string,
  spans: readonly (AddressableSpan & { cc?: boolean })[]
): Set<string> {
  const typed = new Set<string>();
  for (const span of spans) {
    if (!span.cc) continue;
    if (ENDS_WITH_CC.test(text.slice(0, span.offset).trimEnd())) typed.add(span.authorId);
  }
  return typed;
}
