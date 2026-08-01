/**
 * What one message's article says about itself, before a reader steps into it.
 *
 * @module widgets/room-view/lib/entry-summary
 */

/** How much of a message its description carries before it is cut short. */
const SUMMARY_MAX = 120;

/** What a fenced code block is called once its contents are dropped. */
const CODE_BLOCK = 'code block';

/**
 * A message in one line, for the article's accessible description — or `null`
 * when the message already IS one line.
 *
 * **The description is not the message.** The APG asks a feed's articles to
 * describe themselves so a reader crossing the feed can decide what to stop on,
 * and this row used to answer that by pointing at its whole rendered body — so
 * landing on a message that happened to carry a pasted diff meant hearing the
 * diff, line by line, before being told anything about it. The words are still
 * there to be read; what changes is that arriving is no longer the same act as
 * reading.
 *
 * A fenced block becomes the two words "code block" rather than its contents,
 * which is the whole point: it is the shape of the message that helps somebody
 * decide, not eighty lines of it. Markdown's other punctuation is dropped
 * because it is punctuation — a screen reader spelling out `**` and `##` is
 * reading the source, not the sentence.
 *
 * **`null` for a message that needs no summarising**, which is most of them.
 * A short line of prose is its own best description, and writing a second copy
 * of it into the page to point at would put every message in a room into the
 * document twice — once to read and once to describe — for no gain to anybody.
 * The row points at the words themselves in that case, which is what the APG's
 * own example does; this exists for the messages that example never had.
 *
 * @param text - The message body, as markdown.
 * @returns One line, at most {@link SUMMARY_MAX} characters, or `null` when the
 *   message reads as its own summary.
 */
export function entrySummary(text: string): string | null {
  // A short line with no fence in it is already a summary of itself. Checked on
  // the SOURCE rather than on the flattened form: a body under the limit can
  // only flatten shorter, and a fence is the one thing whose length says
  // nothing about how much there is to hear.
  if (text.length <= SUMMARY_MAX && !text.includes('```')) return null;
  const summary = summarize(text);
  // Nothing survived the flatten — a bare image, a rule, a run of underscores.
  // `null` sends the row back to describing itself with its own content, which
  // is the one answer that is never empty. An empty summary would have pointed
  // `aria-describedby` at an empty element, which is a description of nothing:
  // strictly worse than the body it replaced.
  return summary.length === 0 ? null : summary;
}

/**
 * Flatten a message to one line of plain words.
 *
 * @param text - The message body, as markdown.
 */
function summarize(text: string): string {
  const flattened = text
    // Fences first, so nothing inside one is mistaken for prose. An unclosed
    // fence runs to the end, which is what a streaming message looks like.
    .replace(/```[\s\S]*?(?:```|$)/g, ` ${CODE_BLOCK} `)
    // Inline code keeps its words and loses its backticks.
    .replace(/`([^`]*)`/g, '$1')
    // A link or an image is worth its text, never its URL.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Line-leading markup: headings, quotes, list bullets.
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, '')
    // A table's own scaffolding. Its CELLS are words and stay; the pipes and the
    // `|---|:--:|` alignment rule are drawing, and read aloud they are a fence
    // of vertical bars between every value. A separator row is nothing but
    // drawing, so it goes entirely.
    .replace(/^\s{0,3}\|?[\s:|-]*\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    // Emphasis marks, which are punctuation a screen reader would spell out.
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (flattened.length <= SUMMARY_MAX) return flattened;
  const cut = cutToLength(flattened, SUMMARY_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  // Cut on a word where there is one within reach: a description is spoken, and
  // a chopped word is heard as a mistake.
  return `${(lastSpace > SUMMARY_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The first `max` UTF-16 units of `text`, never splitting a character a person
 * would call one.
 *
 * `slice` counts UTF-16 code units, so cutting at a fixed offset lands inside a
 * surrogate pair or in the middle of a ZWJ sequence — which is how "👩‍👩‍👧" becomes
 * a lone woman plus a replacement character, or an unpaired surrogate that a
 * screen reader spells out. `Intl.Segmenter` knows where the boundaries a reader
 * perceives actually are; where it is missing, code points are still a better
 * floor than code units, because they at least keep surrogate pairs whole.
 *
 * @param text - The flattened summary.
 * @param max - How many UTF-16 units to keep at most.
 */
function cutToLength(text: string, max: number): string {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let out = '';
    for (const { segment } of segmenter.segment(text)) {
      if (out.length + segment.length > max) break;
      out += segment;
    }
    return out;
  }
  let out = '';
  for (const point of text) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out;
}
