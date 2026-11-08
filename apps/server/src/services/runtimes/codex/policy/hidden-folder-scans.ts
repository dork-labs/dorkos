/**
 * Keep Codex's Linux mask list out of folders the profile already hides whole.
 *
 * On Linux, Codex expands every deny glob with `rg --files` and asks bwrap to
 * mask each match (codex-rs `linux-sandbox/src/bwrap.rs`,
 * `expand_unreadable_globs_with_ripgrep`, 0.163). A literal `deny` folder
 * becomes an empty read-only tmpfs, so a match inside it, such as Claude
 * Code's `.claude/backups/.claude.json.backup.*`, is a mount point bwrap can
 * never create, and Codex refuses to start (DOR-3949). Nothing in that folder
 * can be read anyway, so this module skips such matches, and only those.
 *
 * Two residuals, both closed rather than open: a link or a copy of the home
 * path added after the profile is rendered is not re-checked until the next
 * render (inside the sandbox the folder is an empty `--perms 000` tmpfs, so
 * the agent cannot reach its files to link them). And a Codex installed
 * without its `codex-path` folder takes `rg` from `PATH`; an `rg` that reads
 * `!` or `[x]` differently only masks more, so the start is refused.
 *
 * @module services/runtimes/codex/policy/hidden-folder-scans
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexVendoredBinary } from '../check-dependencies.js';

type Access = 'read' | 'deny';

/** Characters that make a profile key a glob rather than a literal path. */
const GLOB = /[*?[\]{}]/;
/** A hidden folder this large is not walked; it keeps every mask instead. */
const WALK_CAP = 4096;

/**
 * The folder Codex's scanner searches for one glob key: everything before the
 * first glob character, up to its last slash. This mirrors codex-rs
 * `split_pattern_for_ripgrep`, which splits on `*`, `?`, `[` and `]` only.
 *
 * @param pattern - A profile key in Codex's slash spelling.
 */
export function codexScanRoot(pattern: string): string | undefined {
  const index = pattern.search(/[*?[\]]/);
  if (index < 0) return undefined;
  const prefix = pattern.slice(0, index);
  const end = prefix.endsWith('/') ? prefix.length - 1 : prefix.lastIndexOf('/');
  return end > 0 ? pattern.slice(0, end) : undefined;
}

/**
 * The profile keys that keep scan root `root` out of folder `dir`, as `rg`
 * sees it under that root.
 *
 * `rg` matches a glob against the path relative to the folder it runs in when
 * that folder is above the path, and against the whole path otherwise. Codex
 * runs it from `/` for its file helper (the AGENTS.md read at thread start)
 * and from the command's folder for a shell command. So there are two keys:
 * - `![/]home/u/.claude/backups` matches the whole absolute path;
 * - `![h]ome/u/.claude/backups` matches the same path relative to `/`.
 * Each holds a slash, so `rg` anchors it, and neither matches any other
 * folder. In each, the class right after `!` is the key's first glob
 * character, so Codex keeps `root` as the search folder. From any other
 * folder above `dir`, neither matches and the start fails closed.
 *
 * @param root - A glob scan root above `dir`.
 * @param dir - An absolute folder path under `root`, with no glob characters.
 */
export function hiddenFolderExclusions(root: string, dir: string): string[] {
  return [`${root}/![/]${dir.slice(1)}`, `${root}/![${dir[1]}]${dir.slice(2)}`];
}

/**
 * Whether bwrap hides this folder's whole contents and nothing inside can lead
 * elsewhere: a real directory, spelled by its real path, holding no links.
 * Anything unproven keeps every mask, so a failure stays a refused start.
 */
/**
 * Whether a folder path can be spelled into the exclusion keys unchanged.
 * Glob characters change what `rg` matches. `[!…]` and `[^…]` would negate
 * the class the second key starts with, and a first character outside the
 * Basic Multilingual Plane would split into a lone surrogate there.
 *
 * @param dir - An absolute folder path.
 */
export function safeForKeys(dir: string): boolean {
  return !/[*?[\]{}\\]/.test(dir) && !/^\/[!^\uD800-\uDFFF]/.test(dir);
}

function hiddenWhole(dir: string): boolean {
  if (!safeForKeys(dir)) return false;
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync.native(dir) !== dir) return false;
    const pending = [dir];
    let seen = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        // A link inside would move its target out of the hidden folder; the
        // scanner would then mask that target, so it must keep scanning here.
        if (++seen > WALK_CAP || entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) pending.push(`${current}/${entry.name}`);
      }
    }
    return true;
  } catch {
    return false;
  }
}

let vendored: string | null | undefined;

/**
 * The `rg` Codex ships beside its binary, or `null` when it is not installed.
 * Resolved once per process; `null` means no folder is skipped.
 */
export function codexVendoredRg(): string | null {
  if (vendored !== undefined) return vendored;
  try {
    const binary = resolveCodexVendoredBinary();
    const rg = binary && path.join(path.dirname(path.dirname(binary)), 'codex-path', 'rg');
    vendored = rg && fs.existsSync(rg) ? rg : null;
  } catch {
    vendored = null;
  }
  return vendored;
}

/**
 * Whether scan root `root` holds a copy of hidden folder `dir`'s path anywhere
 * but `dir` itself, such as `root/backup/home/u/.claude/backups/…`. Codex runs
 * `rg` from a shell command's own folder, and from a folder P the second key
 * also matches `P` + `dir`, so such a copy would lose its masks. This asks
 * `rg` from inside `dir`, which is never above `root`, so it sees every path
 * whole. Any error, a missing `rg`, a timeout or output past 1 MiB counts as
 * a copy, so the folder keeps every mask.
 *
 * @param root - A glob scan root above `dir`.
 * @param dir - The hidden folder, spelled as `rg` sees it under `root`.
 * @param rg - The `rg` to run.
 */
export function hasPathCopy(root: string, dir: string, rg: string | null): boolean {
  if (!rg) return true;
  let out: string;
  try {
    out = execFileSync(
      rg,
      [
        '--no-config',
        '--files',
        '--hidden',
        '--no-ignore',
        '--glob',
        `**/${dir.slice(1)}/**`,
        '--',
        root,
      ],
      { cwd: dir, encoding: 'utf8', timeout: 20_000, maxBuffer: 1 << 20 }
    );
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    // Status 1 with nothing on stderr is rg's "no matches".
    return !(failure.status === 1 && !failure.stderr);
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => (path.isAbsolute(line) ? line : path.join(dir, line)))
    .some((file) => !file.startsWith(`${dir}/`));
}

/** A finder that throws counts as no `rg`, so nothing is skipped. */
function findRg(finder: () => string | null): string | null {
  try {
    return finder();
  } catch {
    return null;
  }
}

function realPathOrSelf(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/**
 * Drop masks bwrap cannot build inside a folder it hides whole, and tell
 * Codex's scanner to skip that folder. Every other key stays as it is.
 *
 * For each literal `deny` folder D that is hidden whole, each glob scan root R
 * above D gets the exclusions from {@link hiddenFolderExclusions}, spelled the
 * way `rg` sees D under R (R may be a link to D's real parent, such as a
 * linked `/home`). They prune D and nothing else; another `.claude/backups`
 * elsewhere is still scanned and masked. Literal keys inside D are removed,
 * and so are globs that only scan inside D. A folder that holds
 * one of `opened` keeps every mask: Codex opens that folder back up inside
 * the tmpfs, so its contents are not hidden. So does a folder whose path is
 * copied under a scan root ({@link hasPathCopy}). Linux only: macOS and
 * Windows build no masks from a scan.
 *
 * @param entries - The rendered, collapsed protected entries.
 * @param opened - Folders Codex binds back in: the cwd, writable and agent folders.
 * @param platform - The platform the profile is rendered for.
 * @param finder - Where to find the `rg` the copy check runs; tests pass one.
 */
export function keepScansOutOfHiddenFolders(
  entries: Readonly<Record<string, Access>>,
  opened: readonly string[],
  platform: NodeJS.Platform = process.platform,
  finder: () => string | null = codexVendoredRg
): Record<string, Access> {
  if (platform !== 'linux') return { ...entries };
  const keys = Object.keys(entries);
  const within = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);
  const hidden = keys.filter(
    (key) =>
      entries[key] === 'deny' &&
      !GLOB.test(key) &&
      !opened.some((folder) => within(folder, key)) &&
      hiddenWhole(key)
  );
  const outermost = hidden.filter((dir) => !hidden.some((other) => dir.startsWith(`${other}/`)));
  if (outermost.length === 0) return { ...entries };
  const roots = [
    ...new Set(keys.filter((key) => GLOB.test(key)).flatMap((key) => codexScanRoot(key) ?? [])),
  ];
  // Each hidden folder's scans, spelled the way rg sees it under each root.
  // A spelling unsafe for a key leaves that scan unexcluded, so the start
  // fails closed. A folder whose path is copied elsewhere under a root keeps
  // every mask (see hasPathCopy).
  let rgPath: string | null | undefined;
  const scans = new Map<string, Array<{ root: string; seen: string }>>();
  for (const dir of outermost) {
    const pairs: Array<{ root: string; seen: string }> = [];
    let copied = false;
    for (const root of roots) {
      const real = realPathOrSelf(root);
      const seen = dir.startsWith(`${root}/`)
        ? dir
        : dir.startsWith(`${real}/`)
          ? `${root}${dir.slice(real.length)}`
          : undefined;
      if (seen === undefined || !safeForKeys(seen)) continue;
      if (hasPathCopy(root, seen, (rgPath ??= findRg(finder)))) {
        copied = true;
        break;
      }
      pairs.push({ root, seen });
    }
    if (!copied) scans.set(dir, pairs);
  }
  const skipped = [...scans.keys()];
  if (skipped.length === 0) return { ...entries };
  // A literal goes when it sits inside D; a glob when the folder it scans is D
  // or inside it.
  const inside = (key: string) => {
    const glob = GLOB.test(key);
    const file = glob ? codexScanRoot(key) : key;
    return (
      file !== undefined &&
      skipped.some((dir) => (glob ? within(file, dir) : file.startsWith(`${dir}/`)))
    );
  };
  const result: Record<string, Access> = {};
  for (const key of keys) if (!inside(key)) result[key] = entries[key]!;
  for (const pairs of scans.values())
    for (const { root, seen } of pairs)
      for (const key of hiddenFolderExclusions(root, seen)) result[key] = 'deny';
  return result;
}
