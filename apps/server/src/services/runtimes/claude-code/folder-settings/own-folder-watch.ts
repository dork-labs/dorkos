/**
 * One Activity line for every change an agent makes to its own open folder
 * setup (DOR-3483, Security's second Must).
 *
 * Found by hashing, never by watching tool calls: a Bash write leaves no tool
 * event. DorkOS hashes the home's `.claude/**`, `.agents/**` and `.mcp.json` at
 * every launch whose own folder is open and at the end of each of its turns,
 * and compares the result with what it last saw for that home. Any difference,
 * whatever wrote it, is one line naming the files. The first look after a server
 * start is only remembered: there is nothing to compare it with.
 *
 * Symlinks are hashed by where they point, never followed (`.claude/skills/<x>`
 * links into `.agents/`, which is hashed on its own). A file over
 * {@link MAX_HASHED_BYTES} is hashed by its size and change time, and a folder
 * over {@link MAX_FILES} entries stops there, so a runaway folder can't stall
 * a launch.
 *
 * @module services/runtimes/claude-code/folder-settings/own-folder-watch
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { recordFullAction } from '../../../core/turn-power/full-autonomy.js';

/** The parts of a home that are watched, relative to it. */
const WATCHED = ['.claude', '.agents', '.mcp.json'] as const;
/** Files past this size are hashed by size and change time. */
const MAX_HASHED_BYTES = 4 * 1024 * 1024;
/** The most entries one look hashes. */
const MAX_FILES = 5_000;
/** How many files a line names before "and N more". */
const NAMED_IN_LINE = 5;
/** How many homes are remembered, oldest dropped first. */
const MEMORY = 1_000;

/** What one look saw: each watched path, relative to the home, and its digest. */
export type OwnFolderSnapshot = Map<string, string>;

/** The last look at each home, by real path. */
const lastSeen = new Map<string, OwnFolderSnapshot>();

/** Hash a file's content, or its size and change time past {@link MAX_HASHED_BYTES}. */
async function contentDigest(
  file: string,
  stat: { size: number; mtimeMs: number }
): Promise<string> {
  if (stat.size > MAX_HASHED_BYTES) return `big:${stat.size}:${stat.mtimeMs}`;
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/**
 * Hash one entry: a file by content; a link by where it points AND the file
 * behind it, so a write through the link is seen (Security M1); anything else
 * by kind.
 */
async function digestOf(file: string): Promise<string | undefined> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) {
    const target = await readlink(file);
    try {
      const behind = await statFile(file);
      if (behind.isDirectory()) return `link:${target}:dir`;
      if (!behind.isFile()) return `link:${target}`;
      return `link:${target}:${await contentDigest(file, behind)}`;
    } catch {
      return `link:${target}:missing`;
    }
  }
  if (!stat.isFile()) return undefined;
  return contentDigest(file, stat);
}

/** Walk one watched part, adding each file under it to `into`. */
async function walk(home: string, rel: string, into: OwnFolderSnapshot): Promise<void> {
  if (into.size >= MAX_FILES) return;
  const full = path.join(home, rel);
  let stat;
  try {
    stat = await lstat(full);
  } catch {
    return; // Not there: nothing to hash.
  }
  if (!stat.isDirectory()) {
    try {
      const digest = await digestOf(full);
      if (digest !== undefined) into.set(rel, digest);
    } catch {
      into.set(rel, 'unreadable');
    }
    return;
  }
  let names: string[];
  try {
    names = (await readdir(full)).sort();
  } catch {
    into.set(rel, 'unreadable');
    return;
  }
  for (const name of names) await walk(home, path.join(rel, name), into);
}

/**
 * Hash a home's open folder setup.
 *
 * @param home - The agent home.
 */
export async function snapshotOwnFolder(home: string): Promise<OwnFolderSnapshot> {
  const snapshot: OwnFolderSnapshot = new Map();
  for (const part of WATCHED) await walk(home, part, snapshot);
  return snapshot;
}

/** A link in a home's open setup that points outside the home. */
export interface OutsideLink {
  /** The link's own path. */
  link: string;
  /** Where it leads: its real path, or the resolved target when nothing is there. */
  target: string;
  /** Whether it leads to a folder. */
  folder: boolean;
}

/**
 * Every link in a home's `.claude/`, `.agents/` and `.mcp.json` that leads
 * outside the home, by real path (Security M1 on #3319). A person's shared
 * safety rule linked into an agent's `.claude/rules/` is one: opening the
 * folder must not open the file behind it. Links that stay inside the home
 * (`.claude/skills/<x>` into `.agents/`) are not listed.
 *
 * @param home - The agent home.
 */
export async function linksOutsideHome(home: string): Promise<OutsideLink[]> {
  const realHome = await realpath(home).catch(() => path.resolve(home));
  const inside = (p: string) => p === realHome || p.startsWith(`${realHome}${path.sep}`);
  const found: OutsideLink[] = [];
  let seen = 0;
  const visit = async (full: string): Promise<void> => {
    if ((seen += 1) > MAX_FILES) return;
    let entry;
    try {
      entry = await lstat(full);
    } catch {
      return;
    }
    if (entry.isSymbolicLink()) {
      const real = await realpath(full).catch(async () =>
        path.resolve(path.dirname(full), await readlink(full))
      );
      if (inside(real)) return;
      const folder = await statFile(full)
        .then((behind) => behind.isDirectory())
        .catch(() => false);
      found.push({ link: full, target: real, folder });
      return;
    }
    if (!entry.isDirectory()) return;
    const names = await readdir(full).catch(() => [] as string[]);
    for (const name of names) await visit(path.join(full, name));
  };
  for (const part of WATCHED) await visit(path.join(path.resolve(home), part));
  return found;
}

/**
 * The paths that differ between two looks: added, removed or changed, sorted.
 *
 * @param before - The earlier look.
 * @param after - The later look.
 */
export function changedPaths(before: OwnFolderSnapshot, after: OwnFolderSnapshot): string[] {
  const changed = new Set<string>();
  for (const [file, digest] of after) if (before.get(file) !== digest) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** The files a line names, with a count for the rest. */
function describe(files: readonly string[]): string {
  const named = files.slice(0, NAMED_IN_LINE).join(', ');
  const rest = files.length - NAMED_IN_LINE;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/** Who changed what, for the line. */
export interface OwnFolderWatch {
  /** The agent home. */
  home: string;
  /** What to call the agent. */
  agentName?: string;
  /** The chat the look is taken for. */
  sessionId: string;
}

/**
 * Look at a home's open folder setup, write one Activity line if it changed
 * since the last look, and remember this look. Never throws.
 *
 * @param watch - The home, the agent and the chat.
 * @param when - Whether the look is at a launch or at a turn's end.
 */
export async function noteOwnFolderChanges(
  watch: OwnFolderWatch,
  when: 'launch' | 'turn-end'
): Promise<void> {
  try {
    const key = await realpath(watch.home).catch(() => path.resolve(watch.home));
    const now = await snapshotOwnFolder(watch.home);
    const before = lastSeen.get(key);
    lastSeen.delete(key);
    lastSeen.set(key, now);
    if (lastSeen.size > MEMORY) lastSeen.delete(lastSeen.keys().next().value!);
    if (!before) return;
    const changed = changedPaths(before, now);
    if (changed.length === 0) return;
    recordFullAction({
      actionId: 'files.own-folder',
      did: `changed its own folder setup: ${describe(changed)}`,
      limit:
        "its file tools can't change these, and a changed hook or MCP server waits for a person",
      agentPath: watch.home,
      ...(watch.agentName ? { agentName: watch.agentName } : {}),
      sessionId: watch.sessionId,
      facts: { changed: changed.slice(0, 50), changedCount: changed.length, seenAt: when },
    });
  } catch (err) {
    logger.warn("[OwnFolder] Could not check an agent's own folder setup for changes", {
      home: watch.home,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Forget every home's last look. For tests.
 *
 * @internal
 */
export function resetOwnFolderWatch(): void {
  lastSeen.clear();
}
