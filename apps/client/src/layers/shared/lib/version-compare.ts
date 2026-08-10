/**
 * Semver comparison for version display and upgrade detection.
 *
 * In `shared/lib` rather than a feature's, because three features ask it now —
 * the settings server tab, the sidebar footer's update pill, and the Ask DorkBot
 * seed builder — and the last of those is a MODEL file. A feature's model
 * reaching into another feature's is the shape `.claude/rules/fsd-layers.md`
 * names forbidden, and the honest fix for a pure two-line string comparison is
 * to put it where every layer may legally read it rather than to grant an
 * exception for it.
 *
 * @module shared/lib/version-compare
 */

/**
 * Simple semver comparison: returns true if a > b.
 *
 * @param a - The version to test as newer
 * @param b - The baseline version
 */
export function isNewer(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = a.split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('.').map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
