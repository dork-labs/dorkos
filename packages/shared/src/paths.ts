/**
 * The one rule for "is this directory the same as, or inside, that one".
 *
 * Session membership is decided in three places — the OpenCode adapter's
 * listing, the server's per-agent fan-out, and the client's session selector —
 * and before DOR-674 all three tested raw string equality, so a session started
 * in a subfolder of an open project was dropped by whichever layer it reached
 * first. They now share this predicate, because three implementations of the
 * same rule is three chances to disagree about which sessions a project has.
 *
 * Deliberately dependency-free (no `node:path`, no filesystem): the client
 * bundles it, and the OpenCode session-mapper's import graph is filesystem-free
 * by test guard (ADR-0308).
 *
 * @module paths
 */

/**
 * An absolute path split into the parts that can be compared: its root, and its
 * meaningful segments. Returns `null` for anything relative or unusable, which
 * is what makes the predicate total.
 */
interface SplitPath {
  /** `'/'` for POSIX and UNC-style paths, or a drive spelling such as `'C:'`. */
  root: string;
  /** Path segments with `.`, empty runs, and resolved `..` removed. */
  segments: string[];
}

/**
 * Split an absolute path into root + normalized segments.
 *
 * Accepts both separators regardless of the host OS: these strings cross the
 * wire between a server and a browser, so a Windows `cwd` gets compared by a
 * client that has no idea what `path.sep` is there.
 *
 * `..` is resolved by popping, and popping past the root is a no-op — the same
 * answer `path.resolve` gives (`/..` is `/`).
 *
 * @param value - Path to split
 */
function splitAbsolute(value: string): SplitPath | null {
  const drive = /^([A-Za-z]:)[/\\]/.exec(value);
  let root: string;
  let rest: string;
  if (drive) {
    root = drive[1]!;
    rest = value.slice(drive[0].length);
  } else if (value.startsWith('/') || value.startsWith('\\')) {
    root = '/';
    rest = value.slice(1);
  } else {
    // Relative or empty: there is no honest answer to "is it inside", because
    // it depends on a working directory this module deliberately cannot see.
    return null;
  }

  const segments: string[] = [];
  for (const segment of rest.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { root, segments };
}

/**
 * True when `candidate` IS `root` or lies inside it.
 *
 * Compares whole path SEGMENTS, never raw characters, so `~/code/app-2` is not
 * read as living inside `~/code/app` — the trap a plain `startsWith` falls
 * into. Spellings of the same path agree: trailing separators, `.` segments,
 * doubled separators, and `..` are all normalized away first.
 *
 * Total by design — it answers `false` rather than throwing for a value that is
 * not a usable absolute path (a `cwd`-less session, a relative directory, a
 * non-string that reached it from untyped data). It runs inside a session-list
 * render and a session-list fan-out, where one malformed row must cost that row
 * and nothing else.
 *
 * Two things it deliberately does NOT do, both because they need knowledge this
 * module does not have:
 *
 * - **Symlinks.** `~/code` and `/Volumes/ssd/code` can be the same directory;
 *   resolving that needs the filesystem. OpenCode stores the real path it
 *   resolved at session-create time, so the two spellings must be reconciled
 *   before they reach here (DOR-695).
 * - **Case.** macOS and Windows are usually case-insensitive, Linux is not, and
 *   folding blindly would merge two genuinely different directories on Linux.
 *   Also DOR-695.
 *
 * @param candidate - Directory to test, e.g. a session's `cwd`
 * @param root - Directory that must contain it, e.g. an agent's project path
 */
export function isWithinDirectory(candidate: unknown, root: unknown): boolean {
  if (typeof candidate !== 'string' || typeof root !== 'string') return false;
  const inner = splitAbsolute(candidate);
  const outer = splitAbsolute(root);
  if (inner === null || outer === null) return false;
  if (inner.root !== outer.root) return false;
  if (inner.segments.length < outer.segments.length) return false;
  return outer.segments.every((segment, i) => inner.segments[i] === segment);
}
