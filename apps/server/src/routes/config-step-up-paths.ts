/** Settings writes that need per-action confirmation; preferences and narrowing stay free. */
import { findOperatorOnlyPaths } from '../services/core/operator/config-write-policy.js';
import { frontDoorPathsOf } from '../services/core/operator/front-door-settings.js';
import { SAFEST_VALUES } from '../services/core/operator/operator-only-tightening.js';
import { configManager } from '../services/core/config-manager.js';

// Only these arrays grant access by membership. A new array asks until its
// direction is classified; removing a denial can widen access.
const ALLOW_LIST_PATHS = new Set([
  'mesh.scanRoots',
  'harness.global.harnesses',
  'cloud.credits.agents',
  'extensions.enabled',
  'extensions.approvedToRun',
  'extensions.legacyUnsourced',
  'extensions.trustedSources',
  'harness.approvedHooks',
  'harness.approvedFolderConfig',
  'harness.approvedRepoConfig',
  'runtimes.claudeCode.defaultAccountOnlyProjects',
  'runtimes.claudeCode.accounts',
  'connectors.rawMcpServers',
]);
const DENY_LIST_PATHS = new Set([
  'extensions.disabled',
  'harness.refusedFolderConfig',
  'harness.refusedRepoConfig',
]);

/** Read one ordinary dot path, without traversing inherited properties. */
function valueAt(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Return the lasting-access or spending settings a patch names, excluding strictest values.
 * Unknown front-door settings ask by default; their existing bar still runs for every value.
 *
 * @param patch - The settings patch, before any write.
 */
export function frontDoorStepUpPaths(patch: unknown): string[] {
  const paths = findOperatorOnlyPaths(patch);
  const frontDoor = new Set(frontDoorPathsOf(paths));
  return paths.filter((path) => {
    if (
      !frontDoor.has(path) &&
      !path.startsWith('cloud.credits.') &&
      path !== 'heartbeats.triageOnCredits'
    )
      return false;
    const value = valueAt(patch, path);
    if (path === 'heartbeats.triageOnCredits' && value === false) return false;
    if (path === 'cloud.credits.offer' || (path === 'cloud.credits.linkedTo' && value === null))
      return false;
    if (
      path === 'cloud.credits.defaults' &&
      value &&
      typeof value === 'object' &&
      Object.values(value).every(
        (entry: unknown) =>
          entry &&
          typeof entry === 'object' &&
          (!Object.hasOwn(entry, 'runsOn') ||
            (entry as { runsOn?: string }).runsOn === 'own-sign-in')
      )
    )
      return false;
    const previous = valueAt(configManager.getAll(), path);
    if (
      ALLOW_LIST_PATHS.has(path) &&
      Array.isArray(value) &&
      Array.isArray(previous) &&
      value.every((entry) => previous.includes(entry))
    )
      return false;
    if (
      DENY_LIST_PATHS.has(path) &&
      Array.isArray(value) &&
      Array.isArray(previous) &&
      previous.every((entry) => value.includes(entry))
    )
      return false;
    const arrayPath = path.split('[]')[0]!;
    if (path.includes('[]') && ALLOW_LIST_PATHS.has(arrayPath)) {
      const next = valueAt(patch, arrayPath);
      const before = valueAt(configManager.getAll(), arrayPath);
      if (
        Array.isArray(next) &&
        Array.isArray(before) &&
        next.every((entry) => before.some((old) => JSON.stringify(old) === JSON.stringify(entry)))
      )
        return false;
    }
    return !SAFEST_VALUES.has(path) || !Object.is(valueAt(patch, path), SAFEST_VALUES.get(path));
  });
}
