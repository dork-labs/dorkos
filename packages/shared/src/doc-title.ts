/**
 * A doc's title, worked out the same way wherever it is read (DOR-2982): the
 * server's doc index reads it from the file, the client from what it just
 * saved, so the two can tell whether a save changed it.
 *
 * Only the first {@link DOC_TITLE_BYTES} bytes count: frontmatter `title:`,
 * else the first `# ` heading outside a code block, else the file name
 * without `.md`.
 *
 * Browser-safe: no Node imports.
 *
 * @module shared/doc-title
 */

/** How much of a doc is read for its title, in bytes. */
export const DOC_TITLE_BYTES = 4096;

/**
 * A doc's file name without its `.md` (in any case).
 *
 * @param fileName - The file name, e.g. `Meeting Notes.md`.
 */
export function docFileStem(fileName: string): string {
  return fileName.toLowerCase().endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

/**
 * A one-line frontmatter value: without the quotes YAML allows around it, or
 * without a trailing ` # comment` when unquoted. A block scalar (`|`, `>`)
 * starts on the next lines, which this does not read, so it gives `''`.
 */
function frontmatterValue(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  if (quoted) return quoted[2]!.trim();
  if (/^[|>][+-]?\d*$/.test(trimmed)) return '';
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * A doc's title from the start of its text.
 *
 * @param head - The first bytes of the doc, decoded. A last line cut short
 *   by the read must already be dropped.
 * @param fileName - The doc's file name, the title when the text gives none.
 */
export function docTitleFromHead(head: string, fileName: string): string {
  const lines = head.replace(/^\uFEFF/, '').split(/\r?\n/);
  let line = 0;
  if (lines[0] === '---') {
    for (line = 1; line < lines.length; line += 1) {
      const text = lines[line]!;
      if (text === '---' || text === '...') break;
      const title = /^title:(.*)$/.exec(text);
      if (title) {
        const value = frontmatterValue(title[1]!);
        if (value !== '') return value;
      }
    }
    line += 1;
  }
  let fence: string | null = null;
  for (; line < lines.length; line += 1) {
    const text = lines[line]!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (heading && heading[1]!.trim() !== '') return heading[1]!.trim();
  }
  return docFileStem(fileName);
}

/**
 * A doc's title from its first bytes, read the way the doc index reads them:
 * at most `limit` bytes, and when that many were there, the last line is
 * dropped because the read may have cut it.
 *
 * @param bytes - The doc's bytes from its start (more than `limit` is fine).
 * @param fileName - The doc's file name, the title when the text gives none.
 * @param limit - How many bytes count; {@link DOC_TITLE_BYTES} by default.
 */
export function docTitleFromBytes(
  bytes: Uint8Array,
  fileName: string,
  limit: number = DOC_TITLE_BYTES
): string {
  let head = new TextDecoder().decode(bytes.subarray(0, limit));
  if (bytes.length >= limit) head = head.slice(0, Math.max(0, head.lastIndexOf('\n')));
  return docTitleFromHead(head, fileName);
}

/**
 * A doc's title from its whole text, as the doc index would read it from the
 * file once this text is saved.
 *
 * @param text - The doc's markdown.
 * @param fileName - The doc's file name.
 */
export function docTitleFromText(text: string, fileName: string): string {
  return docTitleFromBytes(new TextEncoder().encode(text), fileName);
}
