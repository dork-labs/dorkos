import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import { isWithinDirectory } from '@dorkos/shared/paths';

/**
 * Match working directories for one project listing without changing the stored cwd.
 *
 * A runtime with mixed spellings tries the literal check first, preserving its
 * existing subtree matches, then compares on-disk paths when the spellings differ.
 * Each realpath lookup is reused within the listing.
 *
 * A runtime that already stores canonical cwds supplies its own project resolver.
 * It compares cwd as stored, including future directories that resolver can name.
 *
 * @param projectDir - The project directory requested by the caller.
 * @param options - An optional project resolver for a store with canonical cwds.
 * @returns A predicate over the candidate cwd, including absent cwd.
 */
export function projectMembership(
  projectDir: string,
  options: { resolveStoredProject?: (projectDir: string) => string } = {}
): (cwd: unknown) => boolean {
  if (options.resolveStoredProject) {
    const storedRoot = options.resolveStoredProject(projectDir);
    return (cwd) => isWithinDirectory(cwd, storedRoot);
  }

  let canonicalRoot: string | undefined;
  const canonicalCwds = new Map<string, string>();
  return (cwd) => {
    if (isWithinDirectory(cwd, projectDir)) return true;
    if (typeof cwd !== 'string') return false;

    canonicalRoot ??= canonicalDirectory(projectDir);
    let canonicalCwd = canonicalCwds.get(cwd);
    if (canonicalCwd === undefined) {
      canonicalCwd = canonicalDirectory(cwd);
      canonicalCwds.set(cwd, canonicalCwd);
    }
    return isWithinDirectory(canonicalCwd, canonicalRoot);
  };
}
