/**
 * A small line diff for the reply a cap lift returns (DOR-3703, M4): what
 * the SKILL file says now against what was last attested, `-` and `+` lines
 * around the unchanged ones that are left out.
 *
 * @module services/tasks/agent-mode/file-cap/line-diff
 */

/** The most lines on either side the diff compares; past it, both sides are shown whole. */
const MAX_LINES = 400;

/** The most lines, and characters, the diff hands back; the rest is counted, not shown. */
export const MAX_DIFF_LINES = 200;
export const MAX_DIFF_CHARS = 8_000;

/** The diff cut to {@link MAX_DIFF_LINES} lines and {@link MAX_DIFF_CHARS} characters. */
function bounded(lines: string[]): string {
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (shown.length >= MAX_DIFF_LINES || chars + line.length > MAX_DIFF_CHARS) break;
    shown.push(line);
    chars += line.length + 1;
  }
  const rest = lines.length - shown.length;
  return rest > 0 ? [...shown, `… and ${rest} more changed lines`].join('\n') : shown.join('\n');
}

/**
 * The lines removed and added between two texts, in order, by their longest
 * common run of lines. Unchanged lines are left out.
 *
 * @param before - The attested text, or `null` when it was not kept.
 * @param after - The text as it is now.
 */
export function lineDiff(before: string | null, after: string): string {
  const next = after.split('\n');
  if (before === null) return bounded(next.map((line) => `+ ${line}`));
  const prev = before.split('\n');
  if (prev.length > MAX_LINES || next.length > MAX_LINES) {
    return bounded([...prev.map((line) => `- ${line}`), ...next.map((line) => `+ ${line}`)]);
  }
  // lcs[i][j]: the longest common run of prev[i..] and next[j..].
  const lcs = Array.from({ length: prev.length + 1 }, () =>
    new Array<number>(next.length + 1).fill(0)
  );
  for (let i = prev.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        prev[i] === next[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < prev.length && j < next.length) {
    if (prev[i] === next[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${prev[i++]}`);
    } else {
      out.push(`+ ${next[j++]}`);
    }
  }
  while (i < prev.length) out.push(`- ${prev[i++]}`);
  while (j < next.length) out.push(`+ ${next[j++]}`);
  return bounded(out);
}
