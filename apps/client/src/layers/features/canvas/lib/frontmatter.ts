/**
 * Host-side YAML frontmatter handling for the markdown canvas.
 *
 * Blintz's editor is commonmark + gfm + latex with no frontmatter plugin, so a
 * `---`-delimited YAML preamble is not just dropped on a round-trip — it is
 * actively rewritten (the opening `---` becomes a thematic break and the closing
 * `---` turns the line above it into a setext heading). This is proven by
 * Blintz's own `round-trip.test.ts` (tier 3). To edit a frontmatter-bearing file
 * without corrupting its metadata, DorkOS peels the frontmatter off before
 * handing the body to the editor and re-glues the original bytes verbatim on
 * save. The editor never sees the frontmatter, so it can never mangle it.
 *
 * @module features/canvas/lib/frontmatter
 */

/** A markdown document split into its verbatim frontmatter block and its body. */
export interface SplitMarkdown {
  /**
   * The frontmatter block exactly as it appeared, including both `---` fences
   * and the newline after the closing fence — or `''` when the document has no
   * frontmatter. Re-prepending this to the body reconstructs the original bytes.
   */
  frontmatter: string;
  /** The markdown body handed to the editor (everything after the frontmatter). */
  body: string;
}

/**
 * Matches a leading YAML frontmatter block: an opening `---` fence on the first
 * line, optional content, a closing `---` fence on its own line, and the
 * trailing newline (or end of input). Anchored to the start; tolerant of CRLF.
 * The content group is optional so an empty `---\n---\n` block is recognized; a
 * bare `---` with no closing fence (a thematic break) does not match.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Split a leading YAML frontmatter block off a markdown document.
 *
 * Only a frontmatter block at the very start of the document is recognized; the
 * `---` fences must be the first line and a later line on their own. When no
 * frontmatter is present the whole document is returned as the body and
 * `frontmatter` is `''`.
 *
 * @param markdown - The full markdown document.
 * @returns The verbatim frontmatter block (or `''`) and the remaining body.
 */
export function splitFrontmatter(markdown: string): SplitMarkdown {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return { frontmatter: '', body: markdown };
  const frontmatter = match[0];
  return { frontmatter, body: markdown.slice(frontmatter.length) };
}

/**
 * Reattach a frontmatter block (from {@link splitFrontmatter}) to an edited body.
 *
 * The frontmatter string already carries its trailing newline, so this is a
 * plain concatenation. An empty frontmatter returns the body unchanged.
 *
 * @param frontmatter - The verbatim frontmatter block, or `''`.
 * @param body - The (possibly edited) markdown body.
 * @returns The reconstructed document.
 */
export function joinFrontmatter(frontmatter: string, body: string): string {
  return frontmatter ? frontmatter + body : body;
}
