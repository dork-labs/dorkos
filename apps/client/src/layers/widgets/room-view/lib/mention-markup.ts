/**
 * Turn a room entry's raw body into markup Streamdown can draw a
 * {@link MentionPill} over, by splicing the server's resolved
 * `mentionSpans` into it as literal `<mention author_id="...">` tags.
 *
 * Pairs with Streamdown's own `allowedTags` / `literalTagContent` mention-pill
 * pattern: `MENTION_TAG` names the tag to allow, `MENTION_AUTHOR_ATTR` the
 * attribute it carries, and both must be threaded to the same `Streamdown` call
 * that renders this function's output — see `RoomMessage`.
 *
 * @module widgets/room-view/lib/mention-markup
 */
import type { MentionSpan } from '@dorkos/shared/room-schemas';

/** The tag name spliced in for a resolved mention. */
export const MENTION_TAG = 'mention';

/** The attribute the mentioned author's id rides in. */
export const MENTION_AUTHOR_ATTR = 'author_id';

/**
 * Streamdown's `allowedTags`, module-scoped so every `RoomMessage` render
 * passes the SAME reference. Streamdown re-derives its escaped markdown
 * whenever this prop's identity changes (`useMemo([...], [allowedTags])`
 * internally), and a fresh object literal on every render would do that on
 * every reaction toggle, every re-render this row has nothing to do with.
 */
export const MENTION_ALLOWED_TAGS: Record<string, string[]> = {
  [MENTION_TAG]: [MENTION_AUTHOR_ATTR],
};

/** Streamdown's `literalTagContent`, stable for the same reason as {@link MENTION_ALLOWED_TAGS}. */
export const MENTION_LITERAL_TAG_CONTENT: string[] = [MENTION_TAG];

/**
 * Insert one `<mention author_id="...">@handle</mention>` tag per span.
 *
 * `offset` and `length` index `text` in UTF-16 code units — the same units a
 * JS string is indexed and sliced by — so `text.slice(offset, offset +
 * length)` is exactly the matched `@handle`, and that slice becomes the tag's
 * (literal) content unchanged. Spans are spliced from LAST to FIRST so
 * inserting one never shifts an offset an earlier splice still has to read.
 *
 * Spans arrive sorted and non-overlapping by construction (the server emits
 * one per `@handle`, left to right in the text it scanned), but this does not
 * trust that: a room's whole history renders through this function, and a
 * span that broke the invariant must degrade the ONE mention it describes,
 * never the message around it. So the input is sorted defensively, and a span
 * that still overlaps the one before it (or falls outside `text`) is dropped
 * rather than spliced — it renders as the plain `@handle` text it would have
 * been without a span at all.
 *
 * @param text - The entry's raw `body.text`.
 * @param mentionSpans - Where each resolved `@mention` sits in `text`, or
 *   `undefined`/empty for a body with none.
 */
export function withMentionTags(
  text: string,
  mentionSpans: readonly MentionSpan[] | undefined
): string {
  if (!mentionSpans || mentionSpans.length === 0) return text;

  const safe = safeOrderedSpans(text, mentionSpans);
  if (safe.length === 0) return text;

  let result = text;
  for (let i = safe.length - 1; i >= 0; i--) {
    const { offset, length, authorId } = safe[i]!;
    const before = result.slice(0, offset);
    const handle = result.slice(offset, offset + length);
    const after = result.slice(offset + length);
    // `authorId` is not escaped into the attribute — it is trusted, not
    // sanitized. It comes from the SERVER's own `mentionSpans` (a ULID,
    // `AuthorRefSchema.id`), never from anything a room member typed, so it
    // cannot contain a `"` to break out of the attribute. Splicing user text
    // in here would need escaping; this does not, because it never does.
    result = `${before}<${MENTION_TAG} ${MENTION_AUTHOR_ATTR}="${authorId}">${handle}</${MENTION_TAG}>${after}`;
  }
  return result;
}

/**
 * Sort `spans` by offset and drop whichever ones do not fit: one that lands
 * outside `text`, and one that overlaps the span before it once both are in
 * order. Adjacent spans (the next one starting exactly where the last ended)
 * are kept — touching is not overlapping.
 *
 * @param text - The raw body the spans index into.
 * @param spans - The entry's `mentionSpans`, in whatever order they arrived.
 */
function safeOrderedSpans(text: string, spans: readonly MentionSpan[]): readonly MentionSpan[] {
  const ordered = [...spans].sort((a, b) => a.offset - b.offset);
  const safe: MentionSpan[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.offset < cursor) continue;
    if (span.offset + span.length > text.length) continue;
    safe.push(span);
    cursor = span.offset + span.length;
  }
  return safe;
}
