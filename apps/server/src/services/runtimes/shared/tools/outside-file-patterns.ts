/**
 * Whether a wildcard path could name a folder of outside files (DOR-5240): `cat ~/Down?oads/x`
 * reads the Downloads folder, and `grep -r x ~/D*` searches it. Read against the folder's own name, part
 * by part, so it costs nothing on disk and holds whether or not the files exist yet.
 *
 * `*`, `?` and `[…]` match within one part (a `[…]` as any one character, and letters in either
 * case, since the Mac's disk ignores case); `**` matches any number of parts.
 *
 * @module services/runtimes/shared/tools/outside-file-patterns
 */

/** A pattern with more parts than this is not read; it counts as reaching outside files. */
const MAX_PATTERN_PARTS = 64;
/** A part longer than this is not read; it counts as matching. */
const MAX_PART = 1_024;

/**
 * Whether one part of a path holds a wildcard.
 *
 * @param part - One part, between separators.
 */
export function hasWildcard(part: string): boolean {
  return /[*?[]/.test(part);
}

/** One step of a part's pattern: any run of characters, or one character test. */
type Step = '*' | ((char: string) => boolean);

/** A part's pattern as steps. A `[…]` with a close is any one character; without one, a `[`. */
function stepsOf(part: string): Step[] {
  const steps: Step[] = [];
  for (let at = 0; at < part.length; at += 1) {
    const char = part[at]!;
    if (char === '*') {
      if (steps.at(-1) !== '*') steps.push('*');
    } else if (char === '?') {
      steps.push(() => true);
    } else if (char === '[' && part.indexOf(']', at + 2) !== -1) {
      at = part.indexOf(']', at + 2);
      steps.push(() => true);
    } else {
      const lower = char.toLowerCase();
      steps.push((other) => other.toLowerCase() === lower);
    }
  }
  return steps;
}

/** Whether a name fits a part's pattern: goes back only to the last star, so name × pattern steps. */
function partMatches(pattern: string, name: string): boolean {
  if (pattern.length > MAX_PART) return true;
  const steps = stepsOf(pattern);
  let at = 0;
  let step = 0;
  let star = -1;
  let mark = 0;
  while (at < name.length) {
    const current = steps[step];
    if (current === '*') {
      star = step;
      step += 1;
      mark = at;
    } else if (current !== undefined && current(name[at]!)) {
      at += 1;
      step += 1;
    } else if (star !== -1) {
      step = star + 1;
      mark += 1;
      at = mark;
    } else {
      return false;
    }
  }
  while (steps[step] === '*') step += 1;
  return step === steps.length;
}

/**
 * Whether a pattern's parts could name the folder whose parts are given, or a path inside it, or,
 * for a search's root, a folder above it.
 *
 * @param pattern - The pattern's parts, from its first wildcard on.
 * @param folder - The folder's parts, below where the pattern's fixed part ends.
 * @param asRoot - Whether a folder above it counts too.
 */
export function patternReachesFolder(
  pattern: readonly string[],
  folder: readonly string[],
  asRoot: boolean
): boolean {
  if (pattern.length > MAX_PATTERN_PARTS) return true;
  const failed = new Set<number>();
  const reaches = (at: number, depth: number): boolean => {
    if (depth === folder.length) return true;
    if (at === pattern.length) return asRoot;
    const key = at * (folder.length + 1) + depth;
    if (failed.has(key)) return false;
    const part = pattern[at]!;
    const found =
      part === '**'
        ? asRoot || reaches(at + 1, depth) || reaches(at, depth + 1)
        : partMatches(part, folder[depth]!) && reaches(at + 1, depth + 1);
    if (!found) failed.add(key);
    return found;
  };
  return reaches(0, 0);
}
