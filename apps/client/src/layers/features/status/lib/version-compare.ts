/**
 * Semver comparison utilities for version display and upgrade detection.
 *
 * @module features/status/lib/version-compare
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

/**
 * Returns true if the major or minor version changed (not just patch).
 *
 * @param latest - The newer version string
 * @param current - The current installed version string
 */
export function isFeatureUpdate(latest: string, current: string): boolean {
  const [latMaj, latMin] = latest.split('.').map(Number);
  const [curMaj, curMin] = current.split('.').map(Number);
  return latMaj !== curMaj || latMin !== curMin;
}
