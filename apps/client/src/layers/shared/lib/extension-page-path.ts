/**
 * Extension pages — the addresses they live at and how one is matched.
 *
 * An extension mounts full pages at `/x/<extensionId>/<path>` (spec
 * `flow-multiproject` §6.5). The `x/` prefix is what keeps any core route from
 * ever colliding with one, so everything that has to recognise an extension
 * page — the link seam, the tab strip, the route that renders it — asks this
 * module rather than repeating the rule.
 *
 * Pure functions only: the registry that holds the pages lives in
 * `shared/model/extension-registry`, and callers hand its entries in.
 *
 * @module shared/lib/extension-page-path
 */
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';

/** The first segment of every extension page's address. */
export const EXTENSION_PAGE_PREFIX = '/x/';

/**
 * The two router paths that serve extension pages: an extension's home and
 * everything under it. The only parameterised routes the app has, which is why
 * the route-list drift guard names them.
 */
export const EXTENSION_PAGE_ROUTE_PATHS = ['/x/$extensionId', '/x/$extensionId/$'] as const;

/**
 * What `registerPage` accepts as a path: `''` for the extension's home, or
 * `/`-separated segments that are either lowercase words (`settings`) or
 * `:param` placeholders (`p/:name`).
 */
export const EXTENSION_PAGE_PATH_PATTERN =
  /^(?:[a-z0-9-]+|:[a-z][a-zA-Z0-9]*)(?:\/(?:[a-z0-9-]+|:[a-z][a-zA-Z0-9]*))*$|^$/;

/** An extension page address, taken apart. */
export interface ExtensionPagePath {
  /** The extension the address belongs to. */
  extensionId: string;
  /** Everything after `/x/<extensionId>/`, without a leading or trailing slash; `''` for the home. */
  subpath: string;
}

/**
 * Take an extension page address apart, or answer `null` when the pathname is
 * not one (another route, or an id no extension could have).
 *
 * @param pathname - A router pathname, without query or hash.
 */
export function parseExtensionPagePath(pathname: string): ExtensionPagePath | null {
  if (!pathname.startsWith(EXTENSION_PAGE_PREFIX)) return null;
  const rest = pathname.slice(EXTENSION_PAGE_PREFIX.length).replace(/\/+$/, '');
  const slash = rest.indexOf('/');
  const extensionId = slash === -1 ? rest : rest.slice(0, slash);
  if (!EXTENSION_ID_REGEX.test(extensionId)) return null;
  return { extensionId, subpath: slash === -1 ? '' : rest.slice(slash + 1) };
}

/**
 * The address of an extension page with no params.
 *
 * @param extensionId - The extension's id.
 * @param path - The page path as registered (`''` for the home).
 */
export function extensionPageHref(extensionId: string, path: string): string {
  return `${EXTENSION_PAGE_PREFIX}${extensionId}${path ? `/${path}` : ''}`;
}

/** Whether a registered page path has any `:param` segment. */
export function hasPageParams(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith(':'));
}

/** The one thing {@link matchExtensionPage} needs from a registered page. */
export interface MatchablePage {
  /** The page path as registered, e.g. `''` or `'p/:name'`. */
  path: string;
}

/** A registered page that answers a subpath, and the values of its params. */
export interface ExtensionPageMatch<T extends MatchablePage> {
  /** The page. */
  page: T;
  /** Values of its `:param` segments, decoded. */
  params: Record<string, string>;
}

/** Decode a URL segment, keeping the raw text when it is malformed. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Find the registered page that answers a subpath.
 *
 * A page matches when it has as many segments as the subpath and every literal
 * segment is equal. When several match, the one with more literal segments
 * before its first param wins (`p/new` beats `p/:name`), then the one with more
 * literal segments overall.
 *
 * @param pages - The extension's registered pages.
 * @param subpath - Everything after `/x/<extensionId>/`.
 */
export function matchExtensionPage<T extends MatchablePage>(
  pages: readonly T[],
  subpath: string
): ExtensionPageMatch<T> | null {
  const wanted = subpath === '' ? [] : subpath.split('/');
  let best: { match: ExtensionPageMatch<T>; lead: number; literals: number } | null = null;

  for (const page of pages) {
    const segments = page.path === '' ? [] : page.path.split('/');
    if (segments.length !== wanted.length) continue;

    const params: Record<string, string> = {};
    let lead = 0;
    let literals = 0;
    let seenParam = false;
    let matches = true;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      const value = wanted[i]!;
      if (segment.startsWith(':')) {
        if (value === '') {
          matches = false;
          break;
        }
        seenParam = true;
        params[segment.slice(1)] = decodeSegment(value);
      } else if (segment === value) {
        literals += 1;
        if (!seenParam) lead += 1;
      } else {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    if (best === null || lead > best.lead || (lead === best.lead && literals > best.literals)) {
      best = { match: { page, params }, lead, literals };
    }
  }

  return best?.match ?? null;
}
