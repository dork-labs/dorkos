/**
 * Path comparison for the packaged smoke, split out of `smoke-packaged.ts` to
 * keep that file under its line limit.
 *
 * @module scripts/same-path-tree
 */
import { realpathSync } from 'fs';
import path from 'path';

/**
 * Whether `child` is `parent` or inside it, compared as the filesystem sees
 * them (`/var` is a symlink to `/private/var`).
 *
 * @param child - The path that should be inside.
 * @param parent - The folder it should be inside.
 */
export function samePathTree(child: string, parent: string): boolean {
  const real = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [childReal, parentReal] = [real(child), real(parent)];
  return childReal === parentReal || childReal.startsWith(parentReal + path.sep);
}
