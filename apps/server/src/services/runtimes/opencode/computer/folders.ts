/**
 * Which host folders an agent computer answers for, and their guest names
 * (DOR-5251).
 *
 * The anchor and every folder under it map, segment for segment, to the guest
 * directory and the same folders under it. Nothing else maps in either
 * direction. Both sides are POSIX: the guest is Linux and computers run only on
 * a macOS host (`computer-service.ts`).
 *
 * Three rules hold the boundary:
 *
 * - **Segments, never string prefixes.** `/anchor-2` shares a prefix with
 *   `/anchor` and no segment, so it is outside.
 * - **One plain spelling.** A segment below the anchor or the guest directory
 *   may not be empty, `.` or `..`, and may not hold `%`, `\` or a control
 *   character. `%` is refused outright because OpenCode may decode a folder it
 *   receives again, and an encoded `..` must not become a real one there.
 * - **Real paths on the host.** The guest has no host mount (`lima-config.ts`),
 *   so a host symlink never changes what the guest sees. Host code is what
 *   reads a session's host folder (listing, plugin checks, the agent home), so
 *   a host folder whose real path leaves the real anchor is refused, whichever
 *   side named it. A folder that does not exist on the host yet (most guest
 *   subfolders) resolves through its deepest existing ancestor: nothing below
 *   a missing folder can be a link.
 *
 * @module services/runtimes/opencode/computer/folders
 */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Anything a folder segment may not hold: encodings, a backslash, control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what it refuses
const UNSAFE_SEGMENT = /[%\\\u0000-\u001f\u007f]/;

function refuse(): never {
  throw new Error('COMPUTER_DIRECTORY_REFUSED');
}

/** The segments of an absolute, normalized POSIX directory, or `null`. */
function segmentsOf(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length < 2) return null;
  if (path.posix.normalize(value) !== value || value.endsWith('/')) return null;
  return value.slice(1).split('/');
}

/**
 * The segments `value` adds below `root`, or a refusal when it is not `root` or
 * a plainly spelled folder under it.
 */
function below(value: unknown, root: readonly string[]): string[] {
  if (typeof value !== 'string' || !value.startsWith('/')) refuse();
  const segments = value.slice(1).split('/');
  if (segments.length < root.length || root.some((segment, i) => segments[i] !== segment)) refuse();
  const rest = segments.slice(root.length);
  for (const segment of rest) {
    if (segment === '' || segment === '.' || segment === '..' || UNSAFE_SEGMENT.test(segment))
      refuse();
  }
  return rest;
}

/** The real path of a host folder that may not exist yet. */
function realHostPath(folder: string): string {
  let existing = folder;
  const missing: string[] = [];
  for (;;) {
    try {
      // lstat, not stat: a dangling link EXISTS and must fail realpath below.
      lstatSync(existing);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || existing === '/') refuse();
    }
    missing.unshift(path.posix.basename(existing));
    existing = path.posix.dirname(existing);
  }
  try {
    return path.posix.join(realpathSync(existing), ...missing);
  } catch {
    return refuse();
  }
}

/** Host and guest names for one computer's folders. */
export class ComputerFolders {
  private readonly anchorSegments: string[];
  private readonly guestSegments: string[];

  /**
   * Fix the two roots every mapping is measured from.
   *
   * @param anchor - The host folder the guest directory stands for.
   * @param guestDirectory - The guest folder sessions run in.
   * @throws If either is not an absolute, normalized folder.
   */
  constructor(
    readonly anchor: string,
    readonly guestDirectory: string
  ) {
    const anchorSegments = segmentsOf(anchor);
    const guestSegments = segmentsOf(guestDirectory);
    if (!anchorSegments || !guestSegments) throw new Error('COMPUTER_DIRECTORY_INVALID');
    this.anchorSegments = anchorSegments;
    this.guestSegments = guestSegments;
  }

  /**
   * The guest name of a host folder at or under the anchor.
   *
   * @param value - A host folder, as it arrived.
   * @throws `COMPUTER_DIRECTORY_REFUSED` for anything else.
   */
  toGuest(value: unknown): string {
    const rest = below(value, this.anchorSegments);
    this.assertRealInside(value as string);
    return rest.length ? `${this.guestDirectory}/${rest.join('/')}` : this.guestDirectory;
  }

  /**
   * The host name of a guest folder at or under the guest directory.
   *
   * @param value - A guest folder, as the guest reported it.
   * @throws `COMPUTER_DIRECTORY_REFUSED` for anything else.
   */
  toHost(value: unknown): string {
    const rest = below(value, this.guestSegments);
    const host = rest.length ? `${this.anchor}/${rest.join('/')}` : this.anchor;
    this.assertRealInside(host);
    return host;
  }

  /** Refuse a host folder whose real path leaves the anchor's real path. */
  private assertRealInside(host: string): void {
    const real = segmentsOf(realHostPath(host));
    const anchor = segmentsOf(realHostPath(this.anchor));
    if (!real || !anchor) refuse();
    if (real.length < anchor.length || anchor.some((segment, i) => real[i] !== segment)) refuse();
  }
}
