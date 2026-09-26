import { COMMUNITY_SHORT_NAME_PATTERN } from '@dorkos/shared/community-admin-wire';

/** A path that opens a community by its short address, `/<name>[/...]`. */
export interface ShortNamePath {
  /** The name as the grammar reads it: percent-decoded and lowercased. */
  name: string;
  /** Everything after the name, as it appeared in the path, or `''`. */
  rest: string;
  /** Whether the path already spells the name that way; if not, it should move to `/<name>`. */
  canonical: boolean;
}

/**
 * Read a raw (still percent-encoded) path as a short address. The server and the browser both
 * use this, so `/Acme` and `/%61cme` mean `/acme` to each of them. Returns `null` for any path
 * whose first segment is not a name the grammar allows, or is reserved.
 */
export function parseShortNamePath(
  pathname: string,
  reservedNames: ReadonlySet<string>
): ShortNamePath | null {
  const match = /^\/([^/]+)(\/.*)?$/u.exec(pathname);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const name = decoded.toLowerCase();
  if (!COMMUNITY_SHORT_NAME_PATTERN.test(name) || reservedNames.has(name)) return null;
  return { name, rest: match[2] ?? '', canonical: match[1] === name };
}
