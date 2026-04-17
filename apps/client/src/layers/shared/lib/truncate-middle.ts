/**
 * Truncate a path in the middle, preserving the basename.
 *
 * For paths longer than maxChars, returns `<head>…/<basename>` where head is
 * a leading slice of the original path. Short paths are returned unchanged.
 *
 * @param path - The path to truncate.
 * @param maxChars - Target maximum visible characters. Defaults to 40.
 */
export function truncateMiddle(path: string, maxChars = 40): string {
  if (path.length <= maxChars) return path;
  const basename = path.split('/').pop() ?? path;
  const reserved = basename.length + 2; // for "…/"
  const headBudget = Math.max(6, maxChars - reserved);
  return `${path.slice(0, headBudget)}…/${basename}`;
}
