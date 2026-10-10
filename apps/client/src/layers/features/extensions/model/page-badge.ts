/**
 * The host half of `api.setPageBadge` (DOR-2820): check a badge an extension
 * hands over and keep the host's own copy of it in the extension registry.
 *
 * @module features/extensions/model/page-badge
 */
import type { ExtensionPageBadge } from '@dorkos/extension-api';
import { copyPageBadge, pageBadgeProblem } from '@dorkos/extension-api';
import type { ExtensionAPIDeps } from './types';

/**
 * Set, or clear with `null`, the badge on one of an extension's pages.
 *
 * An untyped extension can hand anything, so a badge is checked field by
 * field, and a falsy value that is not `null` is refused rather than read as a
 * clear. A refusal is a console warning and leaves the badge it had.
 *
 * @param extId - The extension asking.
 * @param registry - The extension registry.
 * @param path - The page path as passed to `registerPage`.
 * @param badge - The badge, or `null` to clear it.
 * @returns Whether the badge was set or cleared.
 */
export function applyPageBadge(
  extId: string,
  registry: ExtensionAPIDeps['registry'],
  path: string,
  badge: ExtensionPageBadge | null
): boolean {
  const contributionId = `${extId}:${path}`;
  const owned = registry.getContributions('pages').some((page) => page.id === contributionId);
  const problem = !owned
    ? 'that page is not registered'
    : badge === null
      ? null
      : pageBadgeProblem(badge);
  if (problem) {
    console.warn(`[extensions] ${extId}: setPageBadge('${path}') was ignored: ${problem}`);
    return false;
  }
  registry.setPageBadge(contributionId, badge === null ? null : copyPageBadge(badge));
  return true;
}
