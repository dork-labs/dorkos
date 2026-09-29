/**
 * Which rows in an action list are an older version of an action listed
 * again below or above it. When the service releases a new version, an
 * account can hold the same action twice; both rows read the same, so the
 * older one gets a quiet "Older version" hint instead of a version number.
 *
 * @module features/connections/lib/older-versions
 */

/** The fields that tell two rows of one action apart. */
interface VersionedAction {
  readonly operationRevisionId: string;
  readonly operationSlug: string;
  readonly toolkitVersion: string;
}

/**
 * The revision ids of every row that has a newer row for the same action in
 * the list. Versions compare naturally (`2` before `10`, dates in order).
 *
 * @param actions - The rows shown together.
 */
export function olderVersionIds(actions: readonly VersionedAction[]): ReadonlySet<string> {
  const newest = new Map<string, VersionedAction>();
  for (const action of actions) {
    const current = newest.get(action.operationSlug);
    if (
      !current ||
      action.toolkitVersion.localeCompare(current.toolkitVersion, undefined, { numeric: true }) > 0
    ) {
      newest.set(action.operationSlug, action);
    }
  }
  return new Set(
    actions
      .filter(
        (action) =>
          newest.get(action.operationSlug)!.operationRevisionId !== action.operationRevisionId
      )
      .map((action) => action.operationRevisionId)
  );
}
