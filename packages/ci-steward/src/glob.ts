/**
 * Minimal path globbing for the few patterns the `ci/` files use.
 *
 * Supports `**` (any number of path segments), `*` (anything but `/`) and `?`
 * (one character). That is the whole grammar the coverage paths and the fence
 * need, and writing it here keeps the package inside its dependency budget.
 */

/**
 * Compile a glob into an anchored regular expression.
 *
 * @param glob - A repo-relative pattern such as `ci/**` or `.github/workflows/*.yml`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * True when `path` matches at least one of `globs`.
 *
 * @param path - A repo-relative path with forward slashes.
 * @param globs - Patterns to test against.
 */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
