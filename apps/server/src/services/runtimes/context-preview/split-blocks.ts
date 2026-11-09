/**
 * Split the builders' assembled text back into the blocks they wrote.
 *
 * The builders join blocks with a blank line, but a block's own body may hold
 * blank lines (a persona routinely does), so splitting on the separator would
 * cut one block into several. A tagged block runs from its opening tag to its
 * closing one; an untagged block (the Blocked-area lines, the task frame) runs
 * to its end marker when it has one, else to the next blank line.
 *
 * A linear `indexOf` scan, never a backtracking regex over the whole text:
 * the text includes agent- and person-written files.
 *
 * @module services/runtimes/context-preview/split-blocks
 */

/** Untagged blocks that carry their own end marker and blank lines inside. */
const FRAMES: readonly { start: string; end: string }[] = [
  { start: '=== TASK SCHEDULER CONTEXT ===', end: '=== END TASK CONTEXT ===' },
];

const OPEN_TAG = /^<([a-z_]+)(?:\s[^>\n]*)?>/;

/**
 * The blocks, in order, each trimmed.
 *
 * @param text - What a runtime's builders assembled.
 */
export function splitBlocks(text: string): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    const rest = text.slice(i, i + 200);
    const tag = OPEN_TAG.exec(rest)?.[1];
    let end: number;
    const frame = FRAMES.find((f) => text.startsWith(f.start, i));
    if (tag) {
      const close = text.indexOf(`\n</${tag}>`, i);
      end = close === -1 ? text.length : close + `\n</${tag}>`.length;
    } else if (frame) {
      const close = text.indexOf(frame.end, i);
      end = close === -1 ? text.length : close + frame.end.length;
    } else {
      const gap = text.indexOf('\n\n', i);
      end = gap === -1 ? text.length : gap;
    }
    const segment = text.slice(i, end).trim();
    if (segment) segments.push(segment);
    i = end;
  }
  return segments;
}
