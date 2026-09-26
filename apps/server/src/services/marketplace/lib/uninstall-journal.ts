/**
 * The write-ahead journal an in-place uninstall keeps, and the two ways to
 * settle it (DOR-2245, spec §5 and §14).
 *
 * An uninstall no longer moves the install root anywhere. It moves only the
 * files the installed-files record proves are the package's into a sibling
 * `<root>.dorkos-uninstall-<createdAt>-<owner>-<uuid>`, on the same filesystem,
 * and the person's files never move. The sibling carries
 * `.dorkos-journal.json`: every move is appended (and synced to disk) BEFORE it
 * happens, and the phase is advanced `moving` → `side-effects` → `committed`.
 *
 * - {@link rollBackUninstall}: before `committed`, rename every journaled move
 *   back in reverse order. The package identity files moved last, so they come
 *   back first and the root regains its manifest before anything else. A move
 *   logged but never made (its source still in place, nothing in the sibling)
 *   is skipped.
 * - {@link finishUninstall}: after `committed`, prune the record to what is
 *   still in the root, delete the sibling, and prune empty directories. An
 *   untouched package leaves nothing behind.
 *
 * Crash recovery (`../install-recovery.ts`) settles a crash-left sibling with
 * the same two functions, chosen by the journal's phase.
 *
 * @module services/marketplace/lib/uninstall-journal
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { INSTALLED_FILES_PATH, PACKAGE_DATA_DIR, PackageTypeSchema } from '@dorkos/marketplace';
import { MARKETPLACE_UNINSTALL_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import { currentRecordOwner, formatRecordOwner } from './record-owner.js';
import {
  readInstalledFiles,
  RecordPathSchema,
  writeInstalledFiles,
  type InstalledFiles,
} from './installed-files.js';

/** The journal's file name, inside the uninstall sibling. */
export const UNINSTALL_JOURNAL_FILE = '.dorkos-journal.json';

/** One journaled move: a root-relative POSIX path, the same inside the sibling. */
const JournalMoveSchema = z.object({
  path: RecordPathSchema,
  /** For a directory moved as one unit: the files classification found under it. */
  unitFiles: z.array(RecordPathSchema).optional(),
});

/** The journal (`.dorkos-journal.json`). */
export const UninstallJournalSchema = z.object({
  version: z.literal(1),
  /** The install root, absolute. */
  root: z.string().min(1),
  package: z.object({ name: z.string(), type: PackageTypeSchema }),
  moves: z.array(JournalMoveSchema),
  phase: z.enum(['moving', 'side-effects', 'committed']),
  /** Set when the agent was unregistered, so a rollback can register it again. */
  agentUnregistered: z.boolean().optional(),
  /**
   * `.dork-old` copies of edited identity files this uninstall wrote into the
   * root (root-relative). Logged before each is written; a rollback deletes
   * them, since the originals come back.
   */
  savedCopies: z.array(RecordPathSchema).optional(),
});

/** See {@link UninstallJournalSchema}. */
export type UninstallJournal = z.infer<typeof UninstallJournalSchema>;

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Whether `target` exists (without following a final symlink). */
async function exists(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => undefined)) !== undefined;
}

/**
 * Create the uninstall sibling beside `root`, named with the record stamp
 * DOR-2273's recovery reads.
 *
 * @param root - The install root being uninstalled.
 * @returns The sibling's absolute path.
 */
export async function createUninstallSibling(root: string): Promise<string> {
  const stamp = `${Date.now()}-${formatRecordOwner(currentRecordOwner())}-${randomUUID()}`;
  const sibling = `${root}${MARKETPLACE_UNINSTALL_DIR_MARKER}${stamp}`;
  await mkdir(sibling);
  return sibling;
}

/**
 * Write the journal durably: to a temp file, synced, then renamed over.
 *
 * @param sibling - The uninstall sibling.
 * @param journal - The journal to write.
 */
export async function writeJournal(sibling: string, journal: UninstallJournal): Promise<void> {
  const target = path.join(sibling, UNINSTALL_JOURNAL_FILE);
  const tmp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
}

/**
 * Read a sibling's journal, or `null` when it is missing or unreadable.
 *
 * @param sibling - The uninstall sibling.
 */
export async function readJournal(sibling: string): Promise<UninstallJournal | null> {
  try {
    const parsed = UninstallJournalSchema.safeParse(
      JSON.parse(await readFile(path.join(sibling, UNINSTALL_JOURNAL_FILE), 'utf-8'))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Move one entry from the root into the sibling, journaling it first.
 *
 * @param opts.root - The install root.
 * @param opts.sibling - The uninstall sibling.
 * @param opts.journal - The journal, updated in place and rewritten.
 * @param opts.move - What to move.
 */
export async function journaledMove(opts: {
  root: string;
  sibling: string;
  journal: UninstallJournal;
  move: { path: string; unitFiles?: string[] };
}): Promise<void> {
  opts.journal.moves.push(opts.move);
  await writeJournal(opts.sibling, opts.journal);
  const dest = fsPath(opts.sibling, opts.move.path);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(fsPath(opts.root, opts.move.path), dest);
}

/** The first free `<p>.dork-old[.n]` in `root`. */
async function freeSavedName(root: string, p: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${p}.dork-old` : `${p}.dork-old.${n}`;
    if (!(await exists(fsPath(root, candidate)))) return candidate;
  }
}

/** Every non-directory entry under `dir`, root-relative POSIX paths. */
async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(rel === '' ? dir : fsPath(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (!entry.isDirectory()) out.push(child);
    else {
      // An empty folder counts: it is the person's, and keeps the root.
      const inside = await listFiles(dir, child);
      out.push(...(inside.length > 0 ? inside : [`${child}/`]));
    }
  }
  return out;
}

/**
 * Move back every entry in the sibling that no journaled move accounts for (a
 * file written into a unit-moved directory while it sat in the sibling),
 * before the commit would delete it (spec §5 step 3a). The journal file is
 * never a stray.
 *
 * @param opts.root - The install root.
 * @param opts.sibling - The uninstall sibling.
 * @param opts.journal - The journal.
 * @returns The strays moved back, with where each landed.
 */
export async function returnStrays(opts: {
  root: string;
  sibling: string;
  journal: UninstallJournal;
}): Promise<{ path: string; landedAt: string }[]> {
  // A plain move (a file, or a whole owned directory such as node_modules)
  // accounts for everything at or under its path; a unit-moved directory only
  // for the files classification listed under it.
  const accounted = new Set<string>();
  const plainRoots: string[] = [];
  for (const move of opts.journal.moves) {
    if (move.unitFiles) {
      for (const f of move.unitFiles) accounted.add(`${move.path}/${f}`);
    } else {
      plainRoots.push(move.path);
    }
  }
  const returned: { path: string; landedAt: string }[] = [];
  for (const p of await listFiles(opts.sibling)) {
    if (p === UNINSTALL_JOURNAL_FILE || p.startsWith(`${UNINSTALL_JOURNAL_FILE}.`)) continue;
    if (accounted.has(p)) continue;
    if (plainRoots.some((r) => p === r || p.startsWith(`${r}/`))) continue;
    const landedAt = (await exists(fsPath(opts.root, p))) ? await freeSavedName(opts.root, p) : p;
    await mkdir(path.dirname(fsPath(opts.root, landedAt)), { recursive: true });
    await rename(fsPath(opts.sibling, p), fsPath(opts.root, landedAt));
    returned.push({ path: p, landedAt });
  }
  return returned;
}

/**
 * Undo an uncommitted uninstall: rename every journaled move back, newest
 * first (so the identity files, moved last, return first), tolerating a move
 * that was logged but never made, and delete the `.dork-old` identity copies
 * it wrote. Leaves the sibling on disk until every entry is back, so a crash
 * part-way is retried; then removes it.
 *
 * @param sibling - The uninstall sibling.
 * @param journal - Its journal.
 */
export async function rollBackUninstall(sibling: string, journal: UninstallJournal): Promise<void> {
  for (const move of [...journal.moves].reverse()) {
    const from = fsPath(sibling, move.path);
    if (!(await exists(from))) continue; // Logged but never moved, or already back.
    let to = fsPath(journal.root, move.path);
    if (await exists(to)) to = fsPath(journal.root, await freeSavedName(journal.root, move.path));
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  }
  for (const copy of journal.savedCopies ?? []) {
    await rm(fsPath(journal.root, copy), { force: true });
  }
  await rm(sibling, { recursive: true, force: true });
}

/**
 * Finish a committed uninstall: prune the root's record to the entries still
 * present and mark it uninstalled, then delete the sibling, and remove the
 * directories the uninstall emptied. When nothing but the record would remain, the record and the
 * root go too: an untouched package leaves nothing behind.
 *
 * @param sibling - The uninstall sibling.
 * @param journal - Its journal, in phase `committed`.
 */
export async function finishUninstall(sibling: string, journal: UninstallJournal): Promise<void> {
  const root = journal.root;
  const record = await readInstalledFiles(root);
  // Prune first, atomically, then delete the sibling and its journal. The
  // other order leaves, after a crash between the two, a full record with no
  // journal, and the next install reads every moved-out editable default as
  // one the person deleted. Pruning again on a retry is harmless.
  if (record) await pruneRecord(root, record);
  await rm(sibling, { recursive: true, force: true });
  await pruneEmptiedDirs(
    root,
    journal.moves.map((m) => m.path)
  );
  const remaining = await listFiles(root);
  if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === INSTALLED_FILES_PATH)) {
    await rm(root, { recursive: true, force: true });
  }
}

/** Keep only the recorded entries still in the root, and mark the record uninstalled. */
async function pruneRecord(root: string, record: InstalledFiles): Promise<void> {
  const files: Record<string, string> = {};
  for (const [p, hash] of Object.entries(record.files)) {
    if (await exists(fsPath(root, p))) files[p] = hash;
  }
  const pendingDefaults: Record<string, string> = {};
  for (const [p, shadowed] of Object.entries(record.pendingDefaults)) {
    if (p in files) pendingDefaults[p] = shadowed;
  }
  await writeInstalledFiles(root, {
    ...record,
    files,
    pendingDefaults,
    ownedPaths: [],
    uninstalledAt: new Date().toISOString(),
  });
}

/**
 * Remove the directories this uninstall emptied, deepest first: the folders
 * that held a moved entry, and the package's data folder the installer made.
 * Only those, so an empty folder the person made stays (never `root` itself).
 */
async function pruneEmptiedDirs(root: string, movedPaths: readonly string[]): Promise<void> {
  const candidates = new Set<string>([PACKAGE_DATA_DIR, '.dork']);
  for (const p of movedPaths) {
    const segments = p.split('/');
    for (let i = 1; i < segments.length; i++) candidates.add(segments.slice(0, i).join('/'));
  }
  const deepestFirst = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of deepestFirst) {
    // rmdir refuses a directory that is not empty, which is the whole test.
    await rmdir(fsPath(root, rel)).catch(() => undefined);
  }
}
