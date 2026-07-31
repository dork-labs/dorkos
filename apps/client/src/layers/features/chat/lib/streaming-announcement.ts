/**
 * What a screen reader hears while an answer is still being written.
 *
 * A transcript is a feed, and a feed is not a live region: crossing it announces
 * whichever article you land on, and nothing announces itself. That is right for
 * history and wrong for the turn happening now — so the streaming tail is
 * mirrored into a small `role="log"` region instead, and this module decides
 * what goes into it.
 *
 * The rule that matters is that it says only what is NEW. Streaming replaces the
 * message's text on every token, and a live region wrapped straight around it
 * would re-read the whole answer from the top each time — the exact
 * double-speak the feed pattern exists to avoid. So the region is fed the
 * un-announced SUFFIX, cut at a sentence boundary so it is heard as a sentence
 * rather than a scatter of half-words.
 *
 * @module features/chat/lib/streaming-announcement
 */

/** Where the un-announced suffix may be cut so it ends as a sentence. */
const SENTENCE_END = /[.!?…:](?=\s|$)|\n/g;

/** What to say next, and what has now been said. */
export interface StreamingAnnouncement {
  /** The words to put in the live region, or `''` to say nothing yet. */
  chunk: string;
  /**
   * The text that has been announced once this chunk is spoken — kept whole
   * rather than as a length, because a length cannot tell a message that GREW
   * from one that was REWRITTEN. Markdown reflows as it streams (a list
   * re-indents, a code fence closes) and a rewrite is routinely the same length
   * or longer, so a length-only guard would happily slice the middle out of a
   * sentence nobody ever heard the start of.
   */
  announced: string;
}

/**
 * The next thing worth saying out loud about a message still being written.
 *
 * @param text - The message's full text as it currently stands.
 * @param announced - What has already been announced, verbatim.
 * @param final - True when the words on screen have settled, so the remaining
 *   tail is said even though no sentence boundary closes it. Only ever the
 *   REMAINDER: a reader who was listening has already heard all but the last few
 *   words, and reading the answer again from the top is the thing this whole
 *   module exists to prevent.
 */
export function nextAnnouncement(
  text: string,
  announced: string,
  final: boolean
): StreamingAnnouncement {
  // Text that does not CONTINUE what was announced is a different message, or
  // the same one rewritten under us. Either way the suffix is meaningless —
  // start it over rather than speaking the second half of a sentence whose
  // first half was never said.
  const from = text.startsWith(announced) ? announced.length : 0;
  const kept = text.slice(0, from);
  const pending = text.slice(from);
  if (pending.trim() === '') return { chunk: '', announced: kept };

  if (final) return { chunk: pending.trim(), announced: text };

  SENTENCE_END.lastIndex = 0;
  let cut = -1;
  for (let match = SENTENCE_END.exec(pending); match !== null; match = SENTENCE_END.exec(pending)) {
    cut = match.index + match[0].length;
  }
  if (cut === -1) return { chunk: '', announced: kept };

  return { chunk: pending.slice(0, cut).trim(), announced: text.slice(0, from + cut) };
}
