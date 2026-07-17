/**
 * @module lib/metadata/docs-breadcrumb
 *
 * Derives a documentation page's section trail — the folder path between the
 * Docs root and the page itself (e.g. "Getting Started" for
 * `/docs/getting-started/quickstart`). The docs Open Graph image (breadcrumb
 * eyebrow) and the docs page (BreadcrumbList JSON-LD) both build from this one
 * trail, so section names stay in sync with the docs navigation.
 */
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import type { Root } from 'fumadocs-core/page-tree';

/** One section folder on the path from the Docs root to a page. */
export interface DocsSection {
  /** Section title, from the folder's `meta.json` (falls back to a title-cased slug). */
  name: string;
  /** Absolute site path to the section, e.g. `/docs/getting-started`. */
  url: string;
}

/** The docs-page fields the trail needs (a subset of the Fumadocs page). */
export interface DocsPageRef {
  /** The page's site path, e.g. `/docs/getting-started/quickstart`. */
  url: string;
  /** The page's slug segments, e.g. `['getting-started', 'quickstart']`. */
  slugs: string[];
}

/** Title-case a slug segment as a last-resort section name. */
function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The ordered folder sections between the Docs root and `page`, excluding both
 * the root and the page. Returns `[]` for the docs index and for top-level pages
 * that sit directly under `/docs` (e.g. the glossary).
 *
 * Section titles come from Fumadocs' breadcrumb (the folder `meta.json` titles,
 * so they match the sidebar); URLs are derived from the slug prefixes so every
 * section has a stable link even when a folder has no index page.
 *
 * @param page - The docs page to trace.
 * @param tree - The docs page tree (`source.pageTree`).
 */
export function docsSectionTrail(page: DocsPageRef, tree: Root): DocsSection[] {
  const folderSlugs = page.slugs.slice(0, -1);
  if (folderSlugs.length === 0) return [];

  // Fumadocs returns the folders along the path, in order (page and separators
  // excluded), so they line up with the folder slug segments. We take each name
  // from the folder (its meta.json title) — a folder without an index page has no
  // url, so pairing by url would drop it; pair by position instead. If the counts
  // ever disagree the per-item fallback title-cases the slug, so names stay sane.
  const items = getBreadcrumbItems(page.url, tree);
  return folderSlugs.map((slug, index) => {
    const name = items.length === folderSlugs.length ? items[index]?.name : undefined;
    return {
      name: typeof name === 'string' ? name : titleCaseSlug(slug),
      url: `/docs/${folderSlugs.slice(0, index + 1).join('/')}`,
    };
  });
}
