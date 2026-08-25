/**
 * Splitting a search excerpt into plain runs and matched runs.
 *
 * **`SearchHit.excerpt` is TEXT, not HTML**, and this module exists so nothing
 * ever has to be tempted to treat it otherwise. FTS5's `snippet()` wraps each
 * match in the literal characters `<mark>` and `</mark>` and leaves everything
 * around them exactly as it was typed — which is arbitrary text, `<script>`
 * included, because people paste error messages and markup into chat all day.
 * The schema's own TSDoc states the rule: a renderer escapes the text and
 * re-applies the marks, never assigns it to `innerHTML`.
 *
 * So the marks are parsed OUT here into a list of runs, and the component turns
 * each run into a React child. React escapes every string it renders, which
 * makes the safety a property of the pipeline rather than of anybody's
 * discipline: there is no code path from an excerpt to `innerHTML` to get wrong.
 *
 * @module features/command-palette/model/search-excerpt
 */

/** The literal characters `snippet()` opens a match with. */
const MARK_OPEN = '<mark>';

/** The literal characters `snippet()` closes a match with. */
const MARK_CLOSE = '</mark>';

/** One run of an excerpt: a stretch of text that either matched or did not. */
export interface ExcerptRun {
  /** The text itself, exactly as it will be rendered. Never escaped or encoded. */
  text: string;
  /** Whether this run is one of the words the search matched. */
  matched: boolean;
}

/**
 * Split an excerpt into its plain and matched runs, in order.
 *
 * The scan alternates: outside a mark it looks for the next `<mark>`, inside
 * one it looks for the next `</mark>`. Nothing else in the string is treated as
 * markup, so `<script>` and `<img onerror=…>` come back as ordinary text in an
 * ordinary run and are rendered as the characters somebody typed.
 *
 * **Unbalanced input degrades to text rather than to a guess.** A `<mark>` with
 * no closer leaves its tail marked; a stray `</mark>` outside a mark is not a
 * closer and stays in the text. Both can only arise from somebody literally
 * typing those characters into a message, in which case the excerpt is
 * ambiguous at the source and no reader can recover it — highlighting slightly
 * wrong is the harmless end of that, and there is no branch here that could
 * turn it into markup.
 *
 * @param excerpt - `SearchHit.excerpt`, as the route returned it.
 * @returns The runs, in order, with empty ones dropped. An empty excerpt gives
 *   an empty list.
 */
export function splitExcerpt(excerpt: string): ExcerptRun[] {
  const runs: ExcerptRun[] = [];
  let rest = excerpt;
  let matched = false;

  while (rest.length > 0) {
    const marker = matched ? MARK_CLOSE : MARK_OPEN;
    const at = rest.indexOf(marker);
    if (at === -1) {
      runs.push({ text: rest, matched });
      break;
    }
    if (at > 0) runs.push({ text: rest.slice(0, at), matched });
    rest = rest.slice(at + marker.length);
    matched = !matched;
  }

  return runs;
}
