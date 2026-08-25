/**
 * The filesystem half every **M1** discovery shares: what one root is, and every
 * `.jsonl` file under it.
 *
 * Discovery itself stays the source's — Claude Code decides what a main session
 * is, Codex decides what a rollout is, and neither decision belongs here. What
 * IS shared is the part where the two would silently drift: which failures are
 * reported and which are silent, and when two spellings are one directory. Both
 * were argued once, on DOR-682, and getting either wrong the second time is a
 * blackout rather than a bug (see {@link collapseRoots}).
 *
 * @module server/services/search/jsonl-walk
 */
import fs from 'fs/promises';
import path from 'path';

/** One `.jsonl` file the walk found, with its path relative to the root already split. */
export interface WalkedFile {
  /** Absolute path. */
  filePath: string;

  /** Path segments below the root — `['<slug>', '<sessionId>.jsonl']` for a Claude main session. */
  segments: string[];
}

/** What one root's walk produced. */
export interface WalkedRoot {
  /** Files found under this root, in walk order. Possibly partial when `failure` is set. */
  files: WalkedFile[];

  /** Why the root itself could not be enumerated, or `null`. */
  failure: string | null;
}

/**
 * Every `.jsonl` file anywhere under one root, in walk order — plus why the root
 * itself could not be read, when that is what happened.
 *
 * Recursion is deliberate rather than incidental. A one-level glob would exclude
 * everything nested by an accident of depth rather than by a decision anybody
 * made, and the day somebody wants those files the change has to be a predicate
 * rather than a rewrite. The result is one `readdir` per directory, with
 * `withFileTypes` so no extra `stat` is paid to tell a file from a directory.
 * Symbolic links are not followed — a link back up the tree would walk forever.
 *
 * **Only the root's own failure is reported, and only when it is not `ENOENT`.**
 * The two cases mean opposite things and must not be merged. A missing root is a
 * runtime that never wrote under it — an account Claude Code never ran in, a
 * machine with no Codex — and its containers are correctly pruned. A root that
 * is THERE and refuses to be listed — a permission removed, a volume gone
 * sideways — leaves an unknown amount unread, so it is reported and the sweep
 * stops pruning. A directory NESTED in a readable root is silent either way: one
 * unreadable project must not cost the other 240, and its absence narrows the
 * corpus by a knowable amount.
 *
 * @param root - The directory to walk.
 * @returns The files, and the root's own failure if it had one.
 */
export async function walkJsonlFiles(root: string): Promise<WalkedRoot> {
  const found: WalkedFile[] = [];
  let failure: string | null = null;

  async function visit(dir: string, segments: string[], isRoot: boolean): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        failure = err instanceof Error ? err.message : String(err);
      }
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, [...segments, entry.name], false);
      else if (entry.isFile() && entry.name.endsWith('.jsonl'))
        found.push({ filePath: full, segments: [...segments, entry.name] });
    }
  }

  await visit(root, [], true);
  return { files: found, failure };
}

/**
 * What makes two spellings of a root the same root.
 *
 * The real path, so a symlinked root collapses onto its target instead of
 * duplicating every file it holds. This is not tidiness: twins are refused
 * rather than preferred, so one directory reached two ways gives every container
 * id a twin, and the source indexes NOTHING — forever, rebuilding nothing every
 * five minutes. That is a total blackout from one plausible config entry
 * (DOR-682, spec Amendment 2 delta 4).
 *
 * A root that cannot be resolved — it does not exist, or a link in it dangles —
 * falls back to the lexical form: an absent root walks to nothing anyway, and
 * guessing that two unresolvable paths are one directory would be a worse error
 * than scanning one twice.
 *
 * @param root - The root as the caller spelled it.
 * @returns A key that is equal for two paths iff they name one directory.
 */
async function rootIdentity(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * The roots to walk, in order, with every directory named exactly once.
 *
 * @param roots - The roots as the caller spelled them, in sweep order.
 * @returns The same spellings, minus any that name a directory already listed.
 */
export async function collapseRoots(roots: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const collapsed: string[] = [];
  for (const root of roots) {
    const identity = await rootIdentity(root);
    if (seen.has(identity)) continue;
    seen.add(identity);
    collapsed.push(root);
  }
  return collapsed;
}
