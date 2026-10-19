/**
 * One wiki-link target, looked for beyond the doc index's limits (DOR-2982).
 *
 * The index stops at 2,000 docs, 2,000 folders and 8 levels so the `[[` menu
 * answers quickly, and a large repo passes all three. A target that matches
 * nothing in a truncated index is not missing yet: the client asks here,
 * where the same walk runs with much wider limits and a longer time budget,
 * and the shared rules (`@dorkos/shared/doc-links`) pick the doc, so the
 * answer is the one a complete index would give. When even this walk stops
 * early, the answer says so (`complete: false`) and the client does not
 * call the link missing.
 *
 * @module server/services/docs/links/doc-resolve
 */
import { createDocLinkIndex, type DocResolve } from '@dorkos/shared/doc-links';
import type { DocSpace } from '../doc-space.js';
import { buildDocIndex, type DocIndexLimits } from './doc-index.js';

/** The wider limits a targeted resolve walks with. */
export const DOC_RESOLVE_LIMITS: DocIndexLimits = {
  maxDocs: 50_000,
  maxDepth: 32,
  maxFolders: 20_000,
  budgetMs: 4000,
};

/**
 * The doc a typed target names in a space, looked for through the whole
 * space within {@link DOC_RESOLVE_LIMITS}.
 *
 * @param space - The space, from `resolveDocSpace`.
 * @param target - What the author typed before `#` and `|`.
 * @param fromPath - The linking doc's path in the space, or `null`.
 * @param limits - How far to look; {@link DOC_RESOLVE_LIMITS} unless a test says otherwise.
 */
export async function resolveDocTarget(
  space: DocSpace,
  target: string,
  fromPath: string | null,
  limits: DocIndexLimits = DOC_RESOLVE_LIMITS
): Promise<DocResolve> {
  const index = await buildDocIndex(space, limits);
  const doc = createDocLinkIndex(index.docs).resolve(target, fromPath);
  return { doc, complete: !index.truncated };
}
