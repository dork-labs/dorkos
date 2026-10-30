/**
 * A plain line diff for an approval card's detail (DOR-3298): what a repo
 * setting says on the default branch against what it says in the worktree.
 *
 * `-` lines are the default branch's, `+` lines the worktree's, and up to two
 * unchanged lines are kept around each change; longer unchanged runs fold to
 * `…`. Longest-common-subsequence over lines, bounded: two files whose line
 * counts multiply past {@link MAX_CELLS} are shown as every old line removed
 * and every new line added, which is never wrong, only longer.
 *
 * @module services/runtimes/claude-code/repo-settings/text-diff
 */

/** The largest LCS table built. Settings and hook files are capped at 64 KB. */
const MAX_CELLS = 4_000_000;

/** Unchanged lines kept on each side of a change. */
const CONTEXT = 2;

/** One line of the diff. */
type DiffLine = { op: ' ' | '-' | '+'; text: string };

/** Split text into lines, dropping the empty one after a final newline. */
function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** Every line of `a` against every line of `b`, in order. */
function diffLines(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ op: '-' as const, text })),
      ...b.map((text) => ({ op: '+' as const, text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push({ op: '-', text: a[i] });
      i += 1;
    } else {
      out.push({ op: '+', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] });
  while (j < b.length) out.push({ op: '+', text: b[j++] });
  return out;
}

/**
 * One file's diff, headed by its path, with unchanged runs folded.
 *
 * @param file - The repo-relative path, for the header.
 * @param before - The default branch's text, or `null` when it has none.
 * @param after - The worktree's text, or `null` when the worktree has none.
 * @param sides - What the two sides are called, when not the default branch and this worktree.
 */
export function fileDiff(
  file: string,
  before: string | null,
  after: string | null,
  sides: { before: string; after: string } = { before: 'default branch', after: 'this worktree' }
): string {
  const header = [
    `--- ${before === null ? `(not on the ${sides.before})` : `${file} (${sides.before})`}`,
    `+++ ${after === null ? `(removed in ${sides.after})` : `${file} (${sides.after})`}`,
  ];
  const all = diffLines(lines(before ?? ''), lines(after ?? ''));
  const keep = all.map(() => false);
  all.forEach((line, index) => {
    if (line.op === ' ') return;
    const last = Math.min(all.length - 1, index + CONTEXT);
    for (let k = Math.max(0, index - CONTEXT); k <= last; k += 1) {
      keep[k] = true;
    }
  });
  const body: string[] = [];
  let folded = false;
  all.forEach((line, index) => {
    if (keep[index]) {
      body.push(`${line.op}${line.text}`);
      folded = false;
    } else if (!folded) {
      body.push('…');
      folded = true;
    }
  });
  return [...header, ...body].join('\n');
}
