/**
 * Turn a package slug into a human-readable name and detect emoji faces.
 *
 * @module features/agent-creation/lib/humanize-name
 */

/**
 * Humanize a marketplace package name into a display label: strip a leading
 * `@scope/`, drop any remaining path segment, swap `-`/`_` for spaces, and
 * title-case each word. Used as the fallback when a package ships no
 * `displayName`, so gallery cards never show a raw slug.
 *
 * @param name - The package name (e.g. `@dorkos/code-reviewer`).
 * @returns A humanized label (e.g. `Code Reviewer`).
 */
export function humanizeAgentName(name: string): string {
  const withoutScope = name.replace(/^@[^/]+\//, '');
  const base = withoutScope.split('/').pop() ?? withoutScope;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * True when a string is a single emoji grapheme (including variation-selector
 * and ZWJ sequences). A package's `icon` may be an emoji or an arbitrary
 * identifier; only an emoji is a valid seed for the face picker.
 *
 * @param value - Candidate icon string.
 */
export function isSingleEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*$/u.test(trimmed);
}
