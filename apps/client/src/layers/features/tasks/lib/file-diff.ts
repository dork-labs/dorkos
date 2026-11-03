/**
 * The lines a task's SKILL file gained and lost since it was last approved,
 * for the review a person reads before approving it (DOR-3703, M4).
 *
 * @module features/tasks/lib/file-diff
 */

/** One line of the diff. */
export interface DiffLine {
  /** Whether it was kept, removed or added. */
  kind: 'same' | 'removed' | 'added';
  /** The line's text. */
  text: string;
}

/** The most lines on either side compared line by line; past it, both sides are shown whole. */
const MAX_LINES = 400;

/**
 * The diff of two texts by their longest common run of lines.
 *
 * @param before - The file as last approved, or `null` when it was not kept.
 * @param after - The file as it is now.
 */
export function fileDiff(before: string | null, after: string): DiffLine[] {
  const next = after.split('\n');
  if (before === null) return next.map((text) => ({ kind: 'added', text }));
  const prev = before.split('\n');
  if (prev.length > MAX_LINES || next.length > MAX_LINES) {
    return [
      ...prev.map((text) => ({ kind: 'removed' as const, text })),
      ...next.map((text) => ({ kind: 'added' as const, text })),
    ];
  }
  const lcs = Array.from({ length: prev.length + 1 }, () =>
    new Array<number>(next.length + 1).fill(0)
  );
  for (let i = prev.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        prev[i] === next[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < prev.length && j < next.length) {
    if (prev[i] === next[j]) {
      out.push({ kind: 'same', text: prev[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: prev[i++]! });
    } else {
      out.push({ kind: 'added', text: next[j++]! });
    }
  }
  while (i < prev.length) out.push({ kind: 'removed', text: prev[i++]! });
  while (j < next.length) out.push({ kind: 'added', text: next[j++]! });
  return out;
}

/**
 * How many separate changes a diff holds: each unbroken run of removed and
 * added lines is one, so a rewritten line counts once.
 *
 * @param lines - The diff.
 */
export function diffChangeCount(lines: readonly DiffLine[]): number {
  return lines.filter(
    (line, i) => line.kind !== 'same' && (lines[i - 1]?.kind ?? 'same') === 'same'
  ).length;
}
