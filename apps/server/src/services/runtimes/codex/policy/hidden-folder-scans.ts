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
 * @module services/runtimes/codex/policy/hidden-folder-scans
 */
import fs from 'node:fs';

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
 * The profile key that keeps scan root `root` out of hidden folder `dir`. The
 * `[/]` class matches the path's leading slash and is the key's first glob
 * character, so Codex keeps `root` as the search folder.
 *
 * @param root - A glob scan root above `dir`.
 * @param dir - An absolute, real folder path with no glob characters.
 */
export function hiddenFolderExclusion(root: string, dir: string): string {
  return `${root}/![/]${dir.slice(1)}`;
}

/**
 * Whether bwrap hides this folder's whole contents and nothing inside can lead
 * elsewhere: a real directory, spelled by its real path, holding no links.
 * Anything unproven keeps every mask, so a failure stays a refused start.
 */
function hiddenWhole(dir: string): boolean {
  if (/[*?[\]{}\\]/.test(dir)) return false;
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

/**
 * Drop masks bwrap cannot build inside a folder it hides whole, and tell
 * Codex's scanner to skip that folder. Every other key stays as it is.
 *
 * For each literal `deny` folder D that is hidden whole, each glob scan root R
 * above D gets one extra deny key, `R/![/]` + D without its leading slash.
 * Codex splits that key at its first `[`, so `rg` gets `--glob '![/]…'`: an
 * exclusion anchored to D's whole absolute path, whatever folder `rg` runs
 * in. It prunes D and nothing else; another `.claude/backups` elsewhere, even
 * one whose path ends in D's, is still scanned and masked. Literal keys inside
 * D are removed, and so are globs that only scan inside D. A folder that holds
 * one of `opened` keeps every mask: Codex opens that folder back up inside
 * the tmpfs, so its contents are not hidden. Linux only: macOS and Windows
 * build no masks from a scan.
 *
 * @param entries - The rendered, collapsed protected entries.
 * @param opened - Folders Codex binds back in: the cwd, writable and agent folders.
 * @param platform - The platform the profile is rendered for.
 */
export function keepScansOutOfHiddenFolders(
  entries: Readonly<Record<string, Access>>,
  opened: readonly string[],
  platform: NodeJS.Platform = process.platform
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
  // A literal goes when it sits inside D; a glob when the folder it scans is D
  // or inside it.
  const inside = (key: string) => {
    const glob = GLOB.test(key);
    const file = glob ? codexScanRoot(key) : key;
    return (
      file !== undefined &&
      outermost.some((dir) => (glob ? within(file, dir) : file.startsWith(`${dir}/`)))
    );
  };
  const result: Record<string, Access> = {};
  for (const key of keys) if (!inside(key)) result[key] = entries[key]!;
  const roots = new Set(
    keys.filter((key) => GLOB.test(key)).flatMap((key) => codexScanRoot(key) ?? [])
  );
  for (const root of roots)
    for (const dir of outermost)
      if (dir.startsWith(`${root}/`)) result[hiddenFolderExclusion(root, dir)] = 'deny';
  return result;
}
