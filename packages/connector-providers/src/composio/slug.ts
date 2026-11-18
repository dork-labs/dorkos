/**
 * One spelling for a Composio action name, shared by the access-level policy
 * (`action-classes.ts`) and the paid-operation rule (`paid-operations.ts`), so
 * the two never read the same name two ways.
 *
 * @module connector-providers/composio/slug
 */

/**
 * Canonical spelling used for every action-name policy match.
 *
 * @param slug - An action name in any casing or separator style.
 */
export function normalizeSlug(slug: string): string {
  return slug
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
