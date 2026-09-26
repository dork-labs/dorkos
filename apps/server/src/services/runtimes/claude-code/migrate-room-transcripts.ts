/**
 * One-time move of room transcripts from worktree folders to the agent's home
 * folder (spec `agent-home-desk` §8.1).
 *
 * Claude Code files a transcript under `<configDir>/projects/<slug(cwd)>/`
 * ({@link projectSlug}). From DOR-1597 until room turns moved back home, a room
 * turn's cwd was the agent's room worktree, so its conversation was filed under
 * the WORKTREE's slug. Once a room turn stands at home, resuming that session
 * looks in the home's slug folder and finds nothing. This module moves each
 * such transcript to where the next launch will look.
 *
 * **When it runs matters more than what it does.** It must run only once room
 * turns no longer stand in worktrees: moved earlier, a turn still launched at
 * the worktree would resume into an empty folder. So it is built here and
 * wired at startup, before the room dispatcher starts, by the change that moves
 * the desk.
 *
 * What it guarantees:
 *
 * - **Never overwrites.** A destination `<id>.jsonl` that already exists wins.
 *   The source is renamed in place to `<id>.jsonl.conflict`, because two files
 *   named `<id>.jsonl` would put one session id in the search index twice, and
 *   `jsonl-frontier.ts` refuses a contested id outright rather than index
 *   either. `.jsonl.conflict` is read by nothing. Both paths go to the log and
 *   the marker for the operator.
 * - **Runs to completion once.** The marker at
 *   {@link ROOM_TRANSCRIPT_MIGRATION_MARKER} is written only after a pass with
 *   no failures; while it is absent, every start retries, and a retry after an
 *   interrupted pass is safe because every step is "move what is still at the
 *   source".
 * - **Records the worktrees it saw.** The marker freezes the list of room
 *   worktree folders that existed, each with the agent it belongs to, so a
 *   reader that still has to look in those folders (a runtime whose listing is
 *   scoped by directory) can be fed a list that never grows.
 *
 * Same projects root on both sides, so every move is a `rename` on one
 * filesystem.
 *
 * @module services/runtimes/claude-code/migrate-room-transcripts
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../../lib/logger.js';
import { RoomWorktreeManager } from '../../rooms/repo/room-worktree-manager.js';
import { projectSlug } from './sessions/project-slug.js';

/** The marker's path, relative to the DorkOS data directory. */
export const ROOM_TRANSCRIPT_MIGRATION_MARKER = path.join(
  'migrations',
  'agent-home-desk-transcripts.json'
);

/** Suffix a colliding source transcript is renamed to. Not `.jsonl`, so nothing indexes it. */
const CONFLICT_SUFFIX = '.conflict';

/** One room worktree folder the migration saw. */
export interface MigratedWorktree {
  /** Absolute worktree folder, `<dorkHome>/rooms/<room>/worktrees/<name>`. */
  path: string;
  /** The registered agent it belongs to, or `null` when none is registered. */
  agentPath: string | null;
}

/** A source transcript set aside because its destination already existed. */
export interface TranscriptConflict {
  /** Where the source now is: `<id>.jsonl.conflict` in the worktree's slug folder. */
  source: string;
  /** The destination that was kept. */
  destination: string;
}

/** What the marker file holds. */
export interface RoomTranscriptMigrationMarker {
  /** Marker schema version. */
  version: 1;
  /** When the completing pass finished (ISO 8601). */
  completedAt: string;
  /** The Claude config directories visited. */
  claudeRoots: string[];
  /** Every room worktree folder on disk at the time — the frozen list. */
  worktrees: MigratedWorktree[];
  /** Transcripts moved by the completing pass. */
  moved: number;
  /** Worktree folders skipped because their agent is not registered. */
  skippedUnregistered: number;
  /** Colliding sources set aside, including any an earlier interrupted pass set aside. */
  conflicts: TranscriptConflict[];
}

/** Inputs, injected so a test never touches a real config directory. */
export interface MigrateRoomTranscriptsDeps {
  /** The DorkOS data directory (`lib/dork-home.ts`). */
  dorkHome: string;
  /** Every Claude config directory DorkOS launches with (`resolveClaudeRootSet()`). */
  claudeRoots: readonly string[];
  /** Every registered agent's home. */
  agentPaths: readonly string[];
  /** Clock for the marker's timestamp. */
  now?: () => Date;
}

/** What one call did. */
export interface MigrateRoomTranscriptsOutcome {
  /** False when the marker was already present and nothing was looked at. */
  ran: boolean;
  /** The marker written by this call, or `null` (already done, or a failure kept it back). */
  marker: RoomTranscriptMigrationMarker | null;
  /** What went wrong; non-empty means the next start tries again. */
  failures: string[];
}

/** An error's code, when it has one. */
function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Whether a path exists, without following a final symlink. */
async function present(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Every room worktree folder on disk, `<dorkHome>/rooms/<room>/worktrees/<name>`.
 *
 * Read from disk rather than from the room store, because a transcript was filed
 * under whatever folder the turn stood in, whether or not its room row survived.
 */
async function listRoomWorktrees(dorkHome: string, failures: string[]): Promise<string[]> {
  const roomsRoot = path.join(dorkHome, 'rooms');
  let rooms: import('fs').Dirent[];
  try {
    rooms = await fs.readdir(roomsRoot, { withFileTypes: true });
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') failures.push(`${roomsRoot}: ${String(err)}`);
    return [];
  }
  const found: string[] = [];
  for (const room of rooms) {
    if (!room.isDirectory()) continue;
    const worktreesRoot = path.join(roomsRoot, room.name, 'worktrees');
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(worktreesRoot, { withFileTypes: true });
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') failures.push(`${worktreesRoot}: ${String(err)}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) found.push(path.join(worktreesRoot, entry.name));
    }
  }
  return found.sort();
}

/**
 * The registered agent a worktree folder belongs to, by the digest suffix of its
 * name (`RoomWorktreeManager.slugFor`: `<name>-<digest of the agent path>`).
 *
 * `null` for no match, and for the two-agents-one-digest case, which would make
 * either answer a guess.
 */
function ownerOf(worktree: string, digests: ReadonlyMap<string, string[]>): string | null {
  const name = path.basename(worktree);
  const dash = name.lastIndexOf('-');
  if (dash < 0) return null;
  const owners = digests.get(name.slice(dash + 1));
  return owners?.length === 1 ? owners[0]! : null;
}

/**
 * The first free `<file>.conflict` name, so a second collision for one id
 * (a retry after the operator restored a file) never overwrites the first.
 */
async function freeConflictPath(source: string): Promise<string> {
  const first = `${source}${CONFLICT_SUFFIX}`;
  if (!(await present(first))) return first;
  for (let n = 2; ; n += 1) {
    const candidate = `${first}.${n}`;
    if (!(await present(candidate))) return candidate;
  }
}

/** Counters one pass accumulates. */
interface PassTally {
  moved: number;
  conflicts: TranscriptConflict[];
  failures: string[];
}

/**
 * Move every `<id>.jsonl` (and its sibling `<id>/` folder) from one worktree's
 * slug folder to its agent's home slug folder, within one projects root.
 */
async function moveSlugFolder(sourceDir: string, destDir: string, tally: PassTally): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') tally.failures.push(`${sourceDir}: ${String(err)}`);
    return;
  }

  for (const entry of entries) {
    // A source an earlier, interrupted pass already set aside: it is still the
    // operator's to resolve, so the marker this pass writes must name it too.
    const setAsideMatch = /^(.+)\.jsonl\.conflict(?:\.\d+)?$/.exec(entry);
    if (setAsideMatch) {
      tally.conflicts.push({
        source: path.join(sourceDir, entry),
        destination: path.join(destDir, `${setAsideMatch[1]}.jsonl`),
      });
      continue;
    }
    if (!entry.endsWith('.jsonl')) continue;
    const id = entry.slice(0, -'.jsonl'.length);
    const source = path.join(sourceDir, entry);
    const destination = path.join(destDir, entry);
    try {
      if (await present(destination)) {
        const setAside = await freeConflictPath(source);
        await fs.rename(source, setAside);
        tally.conflicts.push({ source: setAside, destination });
        logger.warn(
          '[migrate-room-transcripts] transcript conflict: destination kept, source set aside',
          { source: setAside, destination }
        );
        continue;
      }
      await fs.mkdir(destDir, { recursive: true });
      // The folder first, then the file: an interrupted pass leaves the file at
      // the source, which is what the retry looks for.
      const sourceFolder = path.join(sourceDir, id);
      const destFolder = path.join(destDir, id);
      if ((await present(sourceFolder)) && !(await present(destFolder))) {
        await fs.rename(sourceFolder, destFolder);
      }
      await fs.rename(source, destination);
      tally.moved += 1;
    } catch (err) {
      tally.failures.push(`${source}: ${String(err)}`);
    }
  }

  // Tidy an emptied folder; anything still in it (a conflict, a folder the
  // move did not own) keeps it.
  await fs.rmdir(sourceDir).catch(() => undefined);
}

/** Write a JSON file atomically (temp file, then rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * Move room transcripts from worktree slug folders to home slug folders, once.
 *
 * A no-op when the marker exists. Otherwise one pass over every room worktree
 * folder and every Claude config directory; the marker is written only when the
 * pass had no failures, so a failed pass is retried on the next start.
 *
 * @param deps - Where to look and who is registered.
 * @returns What the call did.
 */
export async function migrateRoomTranscripts(
  deps: MigrateRoomTranscriptsDeps
): Promise<MigrateRoomTranscriptsOutcome> {
  const markerPath = path.join(deps.dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER);
  if (await present(markerPath)) return { ran: false, marker: null, failures: [] };

  const tally: PassTally = { moved: 0, conflicts: [], failures: [] };

  const digests = new Map<string, string[]>();
  for (const agentPath of new Set(deps.agentPaths)) {
    const digest = RoomWorktreeManager.digestFor(agentPath);
    digests.set(digest, [...(digests.get(digest) ?? []), agentPath]);
  }

  const worktrees: MigratedWorktree[] = (
    await listRoomWorktrees(deps.dorkHome, tally.failures)
  ).map((worktree) => ({ path: worktree, agentPath: ownerOf(worktree, digests) }));

  for (const root of deps.claudeRoots) {
    const projects = path.join(root, 'projects');
    for (const { path: worktree, agentPath } of worktrees) {
      if (agentPath === null) continue;
      await moveSlugFolder(
        path.join(projects, projectSlug(worktree)),
        path.join(projects, projectSlug(agentPath)),
        tally
      );
    }
  }

  const skippedUnregistered = worktrees.filter((w) => w.agentPath === null).length;

  if (tally.failures.length > 0) {
    logger.warn('[migrate-room-transcripts] incomplete; will retry on next start', {
      moved: tally.moved,
      failures: tally.failures,
    });
    return { ran: true, marker: null, failures: tally.failures };
  }

  const marker: RoomTranscriptMigrationMarker = {
    version: 1,
    completedAt: (deps.now ?? (() => new Date()))().toISOString(),
    claudeRoots: [...deps.claudeRoots],
    worktrees,
    moved: tally.moved,
    skippedUnregistered,
    conflicts: tally.conflicts,
  };
  await writeJsonAtomic(markerPath, marker);
  logger.info('[migrate-room-transcripts] room transcripts moved to agent homes', {
    moved: marker.moved,
    conflicts: marker.conflicts.length,
    skippedUnregistered,
    worktrees: worktrees.length,
  });
  return { ran: true, marker, failures: [] };
}
