/**
 * Turn a package slug into a human-readable name and detect emoji faces.
 *
 * Lives in `shared/lib` because every surface that renders a marketplace
 * package name — the browse cards, the install/detail dialogs, the installed
 * list, the install/update/uninstall toasts, and the agent-creation gallery —
 * needs a human name for a package that may ship only a slug.
 *
 * @module shared/lib/humanize-name
 */

/**
 * Humanize a marketplace package name into a display label: strip a leading
 * `@scope/`, drop any remaining path segment, swap `-`/`_` for spaces, and
 * title-case each word. Used as the fallback when a package ships no
 * `displayName`, so no surface ever shows a raw kebab-case slug.
 *
 * @param name - The package name (e.g. `@dorkos/code-reviewer`).
 * @returns A humanized label (e.g. `Code Reviewer`).
 */
export function humanizePackageName(name: string): string {
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
 * The display label a marketplace package renders under everywhere: its
 * author-supplied `displayName`, or the humanized slug when it ships only a
 * name. This is the single source of truth shared by BOTH the card/dialog
 * renders and the alphabetical sort, so a card can never read one name while
 * sorting under another (e.g. slug `security-scanner` shown as "PR Guardian").
 *
 * Typed structurally (`{ name, displayName? }`) so `shared/lib` stays free of a
 * marketplace-schema import while still accepting an `AggregatedPackage`.
 *
 * @param pkg - Anything carrying a package `name` and optional `displayName`.
 * @returns The label to both show and sort by (e.g. `Code Reviewer`).
 */
export function packageDisplayLabel(pkg: { name: string; displayName?: string }): string {
  return pkg.displayName ?? humanizePackageName(pkg.name);
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
