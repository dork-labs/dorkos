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
import path, { basename } from 'node:path';
import { INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';

/** The path functions this module judges with: the platform's, or a test's `path.win32`. */
type PathApi = Pick<typeof path, 'resolve' | 'relative' | 'dirname' | 'sep'>;

/**
 * One spelling of a path, for comparing: resolved, without Windows'
 * `\\?\` long-path prefix, and lower-cased on Windows, whose paths ignore case.
 *
 * @param value - an absolute path.
 * @param p - the path functions to judge with.
 */
function comparable(value: string, p: PathApi): string {
  const resolved = p.resolve(withoutLongPrefix(value, p));
  return p.sep === '\\' ? resolved.toLowerCase() : resolved;
}

/** A Windows path without its `\\?\` long-path prefix, which `readlink` can return. */
function withoutLongPrefix(value: string, p: PathApi): string {
  return p.sep === '\\' && value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

/**
 * Whether `child` is `root` or sits inside it, judged one path segment at a
 * time, the same way on every platform (the #3761 `harness-windows` leg).
 *
 * `startsWith` alone answers `true` for `<dorkHome>/plugins-of-someone-else`
 * against `<dorkHome>/plugins`, which is a neighbouring directory DorkOS has no
 * claim over whatever it is called.
 *
 * @param child - the candidate path.
 * @param root - the containing directory.
 * @param p - the path functions to judge with; the platform's by default.
 * @returns `true` when `child` is inside `root`, or is `root` itself.
 */
export function isInside(child: string, root: string, p: PathApi = path): boolean {
  const c = comparable(child, p);
  const r = comparable(root, p);
  return c === r || c.startsWith(r.endsWith(p.sep) ? r : r + p.sep);
}

/**
 * The first folder under `root` that `target` sits in, or `undefined` when it
 * is not inside `root` or names no folder.
 *
 * @param target - where a link's text points, absolute.
 * @param root - the owning root.
 * @param p - the path functions to judge with; the platform's by default.
 */
export function ownerFolderUnder(
  target: string,
  root: string,
  p: PathApi = path
): string | undefined {
  if (!isInside(target, root, p)) return undefined;
  // `relative` ignores case on Windows and keeps the target's own spelling.
  const [first] = p
    .relative(p.resolve(withoutLongPrefix(root, p)), p.resolve(withoutLongPrefix(target, p)))
    .split(p.sep);
  return first === undefined || first === '' || first === '..' ? undefined : first;
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
  return ownerFolderUnder(path.resolve(path.dirname(abs), text), root);
}
