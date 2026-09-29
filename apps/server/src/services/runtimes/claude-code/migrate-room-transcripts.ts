/**
 * One-time move of room transcripts from worktree folders to the agent's home
 * folder (spec `agent-home-desk` §8.1).
 *
 * Claude Code files a transcript under `<configDir>/projects/<slug(cwd)>/`
 * ({@link projectSlug}). From DOR-1597 until room turns moved back home, a room
 * turn's cwd was the agent's room worktree, so its conversation was filed under
 * the WORKTREE's slug. Once a room turn stands at home, DorkOS looks for that
 * session in the home's slug folder and finds nothing. This module moves each
 * such transcript to where the next launch and every DorkOS read will look.
 * That includes a worktree the idle reap has since removed: its folder is gone,
 * its transcripts are not.
 *
 * **When it runs matters more than what it does.** The caller must run it:
 *
 * - only once room turns no longer stand in worktrees. Moved earlier, a turn
 *   still launched at the worktree would resume into an empty folder;
 * - before the room dispatcher starts, so no DorkOS turn is writing a
 *   transcript while it moves;
 * - after the agent registry has loaded, because `agentPaths` decides whose a
 *   worktree is. An empty list would skip every worktree and still write the
 *   marker, which never runs the move again;
 * - inside a `try`. It throws on an unexpected filesystem error, and on a
 *   marker write that races another process writing the same marker (both use
 *   one fixed temp name). A throw leaves the marker unwritten, so the next start
 *   tries again; it must not stop the server from starting.
 *
 * A moved transcript keeps the worktree as the `cwd` its records carry. Listing
 * accepts it anyway (it sits in the home's own slug folder), and a resume at the
 * home carries its history (measured, spec §8.1), but a caller that reads `cwd`
 * off a record must not assume it is the home.
 *
 * What it guarantees:
 *
 * - **Never overwrites.** Files move by `link` then `unlink`, and `link` refuses
 *   an existing destination, so a destination `<id>.jsonl` always wins. The
 *   source is then set aside in place as `<id>.jsonl.conflict`, because two
 *   files named `<id>.jsonl` would put one session id in the search index twice,
 *   and `jsonl-frontier.ts` refuses a contested id outright rather than index
 *   either. `.jsonl.conflict` is read by nothing. A sibling `<id>/` folder that
 *   meets an existing destination folder is set aside as `<id>.conflict`. Both
 *   paths of every conflict go to the log and the marker.
 * - **Leaves a live transcript alone.** A transcript written in the last
 *   {@link RECENT_WRITE_WINDOW_MS} may belong to a Claude Code process outside
 *   DorkOS (a person's own `claude --resume`, or a subprocess that outlived the
 *   last server). That process appends by path, so moving the file under it
 *   would make it recreate `<id>.jsonl` at the old place: two transcripts for
 *   one id. Such a file is skipped and the marker is not written, so the next
 *   start tries again. The window protects a turn IN FLIGHT and nothing more:
 *   an interactive `claude` session left idle outside DorkOS longer than the
 *   window still holds the old path and will recreate the file on its next
 *   turn, and a subagent transcript still being written under `<id>/` does not
 *   refresh the main file's time. The next pass then finds a destination and
 *   sets the recreated file aside as a conflict, so nothing is lost, but the
 *   session is split until the operator resolves it.
 * - **Runs to completion once.** The marker at
 *   {@link ROOM_TRANSCRIPT_MIGRATION_MARKER} is written only after a pass with
 *   no failures and no skipped live files; while it is absent every start
 *   retries, which is safe because every step is "move what is still at the
 *   source". A move the filesystem cannot do at all (`EXDEV`, a slug folder
 *   symlinked to another volume) is recorded in the marker and logged once,
 *   rather than failing, and retrying, on every start.
 * - **Moves transcripts, nothing else.** Anything else in a worktree's slug
 *   folder stays and is named in the marker's `leftBehind`. That includes Claude
 *   Code's per-project auto-memory (`memory/`): several rooms' worktrees of one
 *   agent each have their own, the home has one, and merging them would carry
 *   one room's notes into every other room and into the person's own sessions
 *   at home. The operator decides.
 * - **Records the worktrees it saw.** The marker freezes the list of room
 *   worktree folders that existed, each with the agent it belongs to, so a
 *   reader that still has to look in those folders (a runtime whose listing is
 *   scoped by directory) can be fed a list that never grows.
 *
 * @module services/runtimes/claude-code/migrate-room-transcripts
 */
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../lib/logger.js';
import { RoomWorktreeManager } from '../../rooms/repo/room-worktree-manager.js';
import { projectSlug } from './sessions/project-slug.js';

/** The marker's path, relative to the DorkOS data directory. */
export const ROOM_TRANSCRIPT_MIGRATION_MARKER = path.join(
  'migrations',
  'agent-home-desk-transcripts.json'
);

/**
 * How recently a transcript may have been written and still be moved.
 *
 * Fifteen minutes. A Claude Code turn appends to its transcript on every event,
 * and the longest it can go without one is a single tool call: the Bash tool's
 * ceiling is ten minutes. Fifteen is past that with room to spare, so a file
 * older than this has no turn in progress. Being too cautious costs one more
 * start before the marker is written; being too eager costs a split transcript.
 */
export const RECENT_WRITE_WINDOW_MS = 15 * 60_000;

/**
 * How much of an agent's name rides in its worktree name, mirrored from
 * `RoomWorktreeManager.slugFor` (`SLUG_NAME_CHARS`). A test builds a worktree
 * name from the longest possible agent name, so a drift fails there.
 */
const WORKTREE_NAME_CHARS = 40;

/** A ULID, which is what every room id is (`room-lifecycle.ts`). */
const ROOM_ID = '[0-9A-HJKMNP-TV-Z]{26}';

/** One room worktree folder the migration saw. */
export interface MigratedWorktree {
  /** Absolute worktree folder, `<dorkHome>/rooms/<room>/worktrees/<name>`. */
  path: string;
  /** The registered agent it belongs to, or `null` when none is registered. */
  agentPath: string | null;
}

/** A source set aside because its destination already existed. */
export interface TranscriptConflict {
  /** Where the source now is: `<id>.jsonl.conflict` or `<id>.conflict` in the worktree's slug folder. */
  source: string;
  /** The destination that was kept. */
  destination: string;
}

/** A transcript the filesystem could not move. */
export interface UnmovableTranscript {
  /** Where it still is. */
  source: string;
  /** Where it would have gone. */
  destination: string;
  /** The error code, e.g. `EXDEV`. */
  reason: string;
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
  /** Sources set aside, including any an earlier interrupted pass set aside. */
  conflicts: TranscriptConflict[];
  /** Transcripts the filesystem could not move; they stay where they were. */
  unmovable: UnmovableTranscript[];
  /** Everything else still in a worktree's slug folder (`memory/`, unknown files). */
  leftBehind: string[];
  /**
   * Slug folders shaped like a reaped worktree of a registered agent whose name
   * part was refused (too long, or carrying another worktree's digest, as a path
   * nested inside a worktree does). Not moved; listed for the operator.
   */
  nearMisses: string[];
}

/** Inputs, injected so a test never touches a real config directory. */
export interface MigrateRoomTranscriptsDeps {
  /** The DorkOS data directory (`lib/dork-home.ts`). */
  dorkHome: string;
  /** Every Claude config directory DorkOS launches with (`resolveClaudeRootSet()`). */
  claudeRoots: readonly string[];
  /** Every registered agent's home. Must come from a loaded registry. */
  agentPaths: readonly string[];
  /** Clock for the live-file window and the marker's timestamp. */
  now?: () => Date;
}

/** What one call did. */
export interface MigrateRoomTranscriptsOutcome {
  /** False when the marker was already present and nothing was looked at. */
  ran: boolean;
  /** The marker written by this call, or `null` (already done, or the pass is not finished). */
  marker: RoomTranscriptMigrationMarker | null;
  /** What went wrong; non-empty means the next start tries again. */
  failures: string[];
  /** Transcripts left alone because they were written recently; the next start tries again. */
  skippedRecent: string[];
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
 * The frozen list of room worktree folders: the marker's `worktrees[]` once the
 * move has completed, and until then the folders on disk now. Read once at
 * startup and kept for the process, so it never grows — the reader it exists
 * for (a runtime whose session listing is scoped by folder, codex and opencode,
 * spec §8.1) only needs the folders room turns stood in before they moved home.
 *
 * @param dorkHome - The DorkOS data directory.
 * @returns Absolute worktree folders; empty when there are none or none can be read.
 */
export async function frozenRoomWorktrees(dorkHome: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER), 'utf-8');
    const marker = JSON.parse(raw) as Partial<RoomTranscriptMigrationMarker>;
    if (Array.isArray(marker.worktrees)) {
      return marker.worktrees.map((w) => w?.path).filter((p): p is string => typeof p === 'string');
    }
  } catch {
    // No marker yet, or one that cannot be read: the folders on disk answer.
  }
  return listRoomWorktrees(dorkHome, []);
}

/**
 * The folders in a frozen list that belong to one agent, matched on the digest
 * half of the folder name — the scheme `RoomWorktreeManager.slugFor` names them
 * by, so a folder left by a renamed agent still matches.
 *
 * @param frozen - From {@link frozenRoomWorktrees}.
 * @param agentPath - The agent's home.
 */
export function roomWorktreesOfAgent(frozen: readonly string[], agentPath: string): string[] {
  const suffix = `-${RoomWorktreeManager.digestFor(agentPath)}`;
  return frozen.filter((folder) => path.basename(folder).endsWith(suffix));
}

/**
 * The registered agent a digest belongs to.
 *
 * `null` for no match, and for two registered paths sharing one digest, which
 * would make either answer a guess.
 */
function ownerOfDigest(digest: string, digests: ReadonlyMap<string, string[]>): string | null {
  const owners = digests.get(digest);
  return owners?.length === 1 ? owners[0]! : null;
}

/**
 * The registered agent a worktree folder belongs to, by the digest suffix of its
 * name (`RoomWorktreeManager.slugFor`: `<name>-<digest of the agent path>`).
 */
function ownerOf(worktree: string, digests: ReadonlyMap<string, string[]>): string | null {
  const name = path.basename(worktree);
  const dash = name.lastIndexOf('-');
  return dash < 0 ? null : ownerOfDigest(name.slice(dash + 1), digests);
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The exact shape of a room worktree's slug folder under one data directory:
 * `<slug of the rooms folder>-<room ULID>-worktrees-<agent name>-<8 hex>`.
 *
 * Anchored at both ends, and every part is only what `slugFor` and the room
 * store can produce, because a looser match moves somebody else's history. The
 * case that proved it: a dev DorkOS running INSIDE a room worktree keeps its
 * own data under `<worktree>/apps/server/.temp/.dork/rooms/…/worktrees/…`, whose
 * slug starts with the outer worktree's and ends in a real agent's digest. Here
 * the name part is a slugified agent name of at most
 * {@link WORKTREE_NAME_CHARS} characters with no dash-delimited token equal to
 * a known worktree digest (a registered agent's, or one on a worktree folder on
 * disk), which is what any path nested inside a worktree carries: the outer
 * worktree's own digest. Any other 8-hex word is a legitimate name ("Release
 * 20260926"). Room ids are ULIDs, so a lookalike beside the rooms folder
 * (`rooms-old/…`) does not match either.
 */
function worktreeSlugPattern(roomsSlug: string): RegExp {
  const name = `[a-z0-9]+(?:-[a-z0-9]+)*`;
  return new RegExp(`^${escapeRegExp(roomsSlug)}-${ROOM_ID}-worktrees-(${name})-([0-9a-f]{8})$`);
}

/** Whether a worktree slug's name part could have come from `slugFor`. */
function isAgentNamePart(name: string, knownDigests: ReadonlySet<string>): boolean {
  return (
    name.length <= WORKTREE_NAME_CHARS && !name.split('-').some((token) => knownDigests.has(token))
  );
}

/**
 * Slug folders in one projects root that name a room worktree of a registered
 * agent, whether or not that worktree is still on disk.
 *
 * The one shape this misses is a slug the SDK truncated past 200 characters (its
 * hash suffix replaces the digest); a worktree still on disk is found by its
 * path instead, so only a reaped worktree with a very long path is left behind.
 *
 * A folder that has the shape and ends in a registered agent's digest but whose
 * name part is refused is not moved, and is named in the marker's `nearMisses`
 * and the log, so a wrong refusal is recoverable by hand rather than silent.
 */
async function reapedWorktreeSlugs(
  projects: string,
  pattern: RegExp,
  digests: ReadonlyMap<string, string[]>,
  knownDigests: ReadonlySet<string>,
  tally: PassTally
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let entries: string[];
  try {
    entries = await fs.readdir(projects);
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') tally.failures.push(`${projects}: ${String(err)}`);
    return found;
  }
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const agentPath = ownerOfDigest(match[2]!, digests);
    if (agentPath === null) continue;
    if (isAgentNamePart(match[1]!, knownDigests)) {
      found.set(entry, agentPath);
    } else {
      const nearMiss = path.join(projects, entry);
      tally.nearMisses.push(nearMiss);
      logger.warn('[migrate-room-transcripts] looks like a room worktree but is not moved', {
        path: nearMiss,
        agentPath,
      });
    }
  }
  return found;
}

/** What one pass accumulates. */
interface PassTally {
  moved: number;
  conflicts: TranscriptConflict[];
  unmovable: UnmovableTranscript[];
  leftBehind: string[];
  nearMisses: string[];
  skippedRecent: string[];
  failures: string[];
}

/** How a no-overwrite move came out. */
type MoveResult = 'moved' | 'exists' | 'cross-device';

/** Whether two paths name one file (same device and inode); false if either is missing. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Move a FILE without ever replacing its destination: `link` fails on an
 * existing destination atomically, where a check followed by `rename` would
 * replace a file that appeared in between.
 */
async function moveFileNoClobber(source: string, destination: string): Promise<MoveResult> {
  try {
    await fs.link(source, destination);
  } catch (err) {
    if (codeOf(err) === 'EEXIST') return 'exists';
    if (codeOf(err) === 'EXDEV') return 'cross-device';
    throw err;
  }
  await fs.unlink(source);
  return 'moved';
}

/**
 * Move a FOLDER without replacing its destination. A folder cannot be linked,
 * and `rename` onto an existing EMPTY folder replaces it, so this checks first.
 * Nothing else writes these folders while the migration runs (see the module
 * doc), so the window between the two calls has no writer to lose.
 */
async function moveFolderNoClobber(source: string, destination: string): Promise<MoveResult> {
  if (await present(destination)) return 'exists';
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if (codeOf(err) === 'EXDEV') return 'cross-device';
    if (codeOf(err) === 'ENOTEMPTY' || codeOf(err) === 'EEXIST') return 'exists';
    throw err;
  }
  return 'moved';
}

/**
 * Set a source aside in its own folder under the first free `<base>`,
 * `<base>.2`, `<base>.3`… name, so a second collision for one id never replaces
 * the first one set aside.
 */
async function setAside(source: string, base: string, isFolder: boolean): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}.${n}`;
    const result = isFolder
      ? await moveFolderNoClobber(source, candidate)
      : await moveFileNoClobber(source, candidate);
    if (result === 'moved') return candidate;
  }
}

/** Matches a name a pass set aside: `<id>.jsonl.conflict[.n]` or `<id>.conflict[.n]`. */
const SET_ASIDE = /^(.+?)(\.jsonl)?\.conflict(?:\.\d+)?$/;

/** Record and log one conflict. */
function recordConflict(tally: PassTally, source: string, destination: string): void {
  tally.conflicts.push({ source, destination });
  logger.warn('[migrate-room-transcripts] conflict: destination kept, source set aside', {
    source,
    destination,
  });
}

/** Record and log one move the filesystem cannot do. */
function recordUnmovable(
  tally: PassTally,
  source: string,
  destination: string,
  reason: string
): void {
  tally.unmovable.push({ source, destination, reason });
  logger.warn('[migrate-room-transcripts] cannot move across filesystems; left in place', {
    source,
    destination,
    reason,
  });
}

/**
 * Move one `<id>.jsonl` and its sibling `<id>/` folder from a worktree's slug
 * folder to the home's.
 */
async function moveTranscript(
  sourceDir: string,
  destDir: string,
  id: string,
  nowMs: number,
  tally: PassTally
): Promise<void> {
  const source = path.join(sourceDir, `${id}.jsonl`);
  const destination = path.join(destDir, `${id}.jsonl`);

  const { mtimeMs } = await fs.stat(source);
  if (nowMs - mtimeMs < RECENT_WRITE_WINDOW_MS) {
    tally.skippedRecent.push(source);
    return;
  }

  // A pass that crashed between `link` and `unlink` left one file under two
  // names. That is this transcript already moved, not a conflict.
  if (await sameFile(source, destination)) {
    await fs.unlink(source);
    tally.moved += 1;
    return;
  }

  // An existing destination transcript means this whole conversation is a
  // conflict: leave its folder with it rather than move half of it.
  if (await present(destination)) {
    recordConflict(tally, await setAside(source, `${source}.conflict`, false), destination);
    return;
  }

  await fs.mkdir(destDir, { recursive: true });

  // The folder first, then the file: an interrupted pass leaves the file at the
  // source, which is what the retry looks for.
  const sourceFolder = path.join(sourceDir, id);
  const destFolder = path.join(destDir, id);
  if (await present(sourceFolder)) {
    const folder = await moveFolderNoClobber(sourceFolder, destFolder);
    if (folder === 'cross-device') {
      recordUnmovable(tally, source, destination, 'EXDEV');
      return;
    }
    if (folder === 'exists') {
      recordConflict(
        tally,
        await setAside(sourceFolder, path.join(sourceDir, `${id}.conflict`), true),
        destFolder
      );
    }
  }

  const file = await moveFileNoClobber(source, destination);
  if (file === 'moved') tally.moved += 1;
  else if (file === 'cross-device') recordUnmovable(tally, source, destination, 'EXDEV');
  else recordConflict(tally, await setAside(source, `${source}.conflict`, false), destination);
}

/**
 * Move every transcript from one worktree's slug folder to its agent's home
 * slug folder, within one projects root.
 */
async function moveSlugFolder(
  sourceDir: string,
  destDir: string,
  nowMs: number,
  tally: PassTally
): Promise<void> {
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
    const setAsideMatch = SET_ASIDE.exec(entry);
    if (setAsideMatch) {
      tally.conflicts.push({
        source: path.join(sourceDir, entry),
        destination: path.join(destDir, `${setAsideMatch[1]}${setAsideMatch[2] ?? ''}`),
      });
      continue;
    }
    if (!entry.endsWith('.jsonl')) continue;
    try {
      await moveTranscript(sourceDir, destDir, entry.slice(0, -'.jsonl'.length), nowMs, tally);
    } catch (err) {
      tally.failures.push(`${path.join(sourceDir, entry)}: ${String(err)}`);
    }
  }

  // What is still here and is not a transcript or its folder is not this
  // module's to move (`memory/`, anything unknown): name it for the operator.
  let remaining: string[];
  try {
    remaining = await fs.readdir(sourceDir);
  } catch {
    return;
  }
  const transcriptIds = new Set(
    remaining.filter((e) => e.endsWith('.jsonl')).map((e) => e.slice(0, -'.jsonl'.length))
  );
  for (const entry of remaining) {
    if (SET_ASIDE.test(entry) || entry.endsWith('.jsonl') || transcriptIds.has(entry)) continue;
    tally.leftBehind.push(path.join(sourceDir, entry));
  }
  if (remaining.length === 0) await fs.rmdir(sourceDir).catch(() => undefined);
}

/**
 * Write the marker atomically: a fixed temp name beside it, then `rename`. A
 * temp file an interrupted write left behind is simply overwritten next time,
 * and removed if this write fails.
 */
async function writeMarker(file: string, value: RoomTranscriptMigrationMarker): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * Move room transcripts from worktree slug folders to home slug folders, once.
 *
 * A no-op when the marker exists. Otherwise one pass over every room worktree
 * folder and every Claude config directory; the marker is written only when the
 * pass had no failures and skipped no live transcript, so an unfinished pass is
 * retried on the next start. See the module doc for when a caller may run it.
 *
 * @param deps - Where to look and who is registered.
 * @returns What the call did.
 */
export async function migrateRoomTranscripts(
  deps: MigrateRoomTranscriptsDeps
): Promise<MigrateRoomTranscriptsOutcome> {
  const markerPath = path.join(deps.dorkHome, ROOM_TRANSCRIPT_MIGRATION_MARKER);
  if (await present(markerPath)) {
    return { ran: false, marker: null, failures: [], skippedRecent: [] };
  }

  const now = (deps.now ?? (() => new Date()))();
  const tally: PassTally = {
    moved: 0,
    conflicts: [],
    unmovable: [],
    leftBehind: [],
    nearMisses: [],
    skippedRecent: [],
    failures: [],
  };

  const digests = new Map<string, string[]>();
  for (const agentPath of new Set(deps.agentPaths)) {
    const digest = RoomWorktreeManager.digestFor(agentPath);
    digests.set(digest, [...(digests.get(digest) ?? []), agentPath]);
  }

  const worktrees: MigratedWorktree[] = (
    await listRoomWorktrees(deps.dorkHome, tally.failures)
  ).map((worktree) => ({ path: worktree, agentPath: ownerOf(worktree, digests) }));

  // A worktree the reap already removed is gone from disk, but its transcripts
  // are not: they are found by their slug folder's shape instead. Every digest a
  // worktree could carry — registered agents' and those on worktree folders on
  // disk, registered or not — is what a path NESTED inside a worktree has in it.
  const knownDigests = new Set(digests.keys());
  for (const { path: worktree } of worktrees) {
    knownDigests.add(path.basename(worktree).slice(path.basename(worktree).lastIndexOf('-') + 1));
  }
  const pattern = worktreeSlugPattern(projectSlug(path.join(deps.dorkHome, 'rooms')));

  for (const root of deps.claudeRoots) {
    const projects = path.join(root, 'projects');
    const sources = new Map<string, string>();
    for (const { path: worktree, agentPath } of worktrees) {
      if (agentPath !== null) sources.set(projectSlug(worktree), agentPath);
    }
    for (const [slug, agentPath] of await reapedWorktreeSlugs(
      projects,
      pattern,
      digests,
      knownDigests,
      tally
    )) {
      if (!sources.has(slug)) sources.set(slug, agentPath);
    }
    for (const [slug, agentPath] of sources) {
      await moveSlugFolder(
        path.join(projects, slug),
        path.join(projects, projectSlug(agentPath)),
        now.getTime(),
        tally
      );
    }
  }

  const skippedUnregistered = worktrees.filter((w) => w.agentPath === null).length;

  if (tally.failures.length > 0 || tally.skippedRecent.length > 0) {
    logger.warn('[migrate-room-transcripts] not finished; will try again on next start', {
      moved: tally.moved,
      failures: tally.failures,
      skippedRecent: tally.skippedRecent,
    });
    return {
      ran: true,
      marker: null,
      failures: tally.failures,
      skippedRecent: tally.skippedRecent,
    };
  }

  const marker: RoomTranscriptMigrationMarker = {
    version: 1,
    completedAt: now.toISOString(),
    claudeRoots: [...deps.claudeRoots],
    worktrees,
    moved: tally.moved,
    skippedUnregistered,
    conflicts: tally.conflicts,
    unmovable: tally.unmovable,
    leftBehind: tally.leftBehind,
    nearMisses: tally.nearMisses,
  };
  await writeMarker(markerPath, marker);
  logger.info('[migrate-room-transcripts] room transcripts moved to agent homes', {
    moved: marker.moved,
    conflicts: marker.conflicts.length,
    unmovable: marker.unmovable.length,
    leftBehind: marker.leftBehind,
    nearMisses: marker.nearMisses,
    skippedUnregistered,
    worktrees: worktrees.length,
  });
  return { ran: true, marker, failures: [], skippedRecent: [] };
}
