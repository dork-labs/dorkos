import type { blog } from './source';

type BlogPage = ReturnType<typeof blog.getPages>[number];

/**
 * Extract the release version from a post title or slug
 * ("DorkOS 0.45.1" / "dorkos-0-45-1"). Returns null for non-release posts.
 *
 * @param title - The post title, checked first.
 * @param slug - Optional slug fallback (dashed version suffix).
 */
export function releaseVersion(title: string, slug?: string): string | null {
  const fromTitle = title.match(/\d+\.\d+\.\d+/);
  if (fromTitle) return fromTitle[0];
  const fromSlug = slug?.match(/(\d+)-(\d+)-(\d+)$/);
  if (fromSlug) return `${fromSlug[1]}.${fromSlug[2]}.${fromSlug[3]}`;
  return null;
}

/** Parts of a semver version parsed from a release title, major-first. */
type VersionParts = [number, number, number];

/** Extract a sortable version from a release title like "DorkOS 0.45.1". */
function versionOf(title: string): VersionParts | null {
  const version = releaseVersion(title);
  if (!version) return null;
  const [major, minor, patch] = version.split('.').map(Number);
  return [major, minor, patch];
}

/**
 * Sort blog pages newest-first. The frontmatter date alone is ambiguous for
 * same-day releases (0.45.0 and 0.45.1 shipped hours apart), so same-date
 * posts fall back to version descending, then title.
 *
 * @param pages - Pages from `blog.getPages()`; returns a new sorted array.
 */
export function sortBlogPagesNewestFirst(pages: BlogPage[]): BlogPage[] {
  return [...pages].sort((a, b) => {
    const byDate = new Date(b.data.date).getTime() - new Date(a.data.date).getTime();
    if (byDate !== 0) return byDate;

    const versionA = versionOf(a.data.title);
    const versionB = versionOf(b.data.title);
    if (versionA && versionB) {
      for (let i = 0; i < versionA.length; i++) {
        if (versionB[i] !== versionA[i]) return versionB[i] - versionA[i];
      }
      return 0;
    }
    return a.data.title.localeCompare(b.data.title);
  });
}
