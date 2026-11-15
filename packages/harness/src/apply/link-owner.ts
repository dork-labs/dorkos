/**
 * Whether a link in a shared skills folder is DorkOS's own, judged the one way
 * both the global sweep and the user-level skill reader judge it.
 *
 * A link is DorkOS's when its name carries `__`, it is a real symlink, AND its
 * own text points inside a folder DorkOS owns (`<dorkHome>/plugins` or the
 * generated extension plugin roots). The name alone is not enough: a person's
 * own `team__a` linked into their dotfiles is theirs (Security, #3761 Should 1).
 *
 * @module apply/link-owner
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';

/**
 * Whether `child` is `root` or sits inside it, judged one path segment at a
 * time.
 *
 * `startsWith` alone answers `true` for `<dorkHome>/plugins-of-someone-else`
 * against `<dorkHome>/plugins`, which is a neighbouring directory DorkOS has no
 * claim over whatever it is called.
 *
 * @param child - the resolved candidate path.
 * @param root - the resolved containing directory.
 * @returns `true` when `child` is inside `root`, or is `root` itself.
 */
export function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * The folder directly under `root` a candidate link's own text points into —
 * clauses 1 to 3 of the predicate for one owning root.
 *
 * Shared by the two roots a global link can be ours through: `<dorkHome>/plugins`
 * (a package's skill) and the generated extension plugin roots (a running
 * extension's skill, DOR-2685). Never follows the link, for the reason
 * {@link globalLinkPackage} gives.
 *
 * @param abs - the absolute candidate path, directly inside a swept directory.
 * @param root - the resolved owning root.
 * @returns the folder name under `root`, or `undefined` when this is not one of
 *   ours or names no folder.
 */
export function linkOwnerUnder(abs: string, root: string): string | undefined {
  if (!basename(abs).includes(INSTALLED_PROJECTION_MARKER)) return undefined;
  let stats;
  try {
    stats = lstatSync(abs);
  } catch {
    return undefined;
  }
  if (!stats.isSymbolicLink()) return undefined;
  let text: string;
  try {
    text = readlinkSync(abs);
  } catch {
    return undefined;
  }
  const resolved = resolve(dirname(abs), text);
  if (!isInside(resolved, root)) return undefined;
  const [first] = relative(root, resolved).split(sep);
  return first === undefined || first === '' || first === '..' ? undefined : first;
}
