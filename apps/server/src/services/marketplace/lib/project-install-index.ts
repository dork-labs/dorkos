/**
 * The record of every package installed into a project, kept under dorkHome.
 *
 * Global installs live under dorkHome, where anything can find them. A
 * project install lives in `<project>/.dork/`, and the only other list of
 * projects is the agent registry, which does not include a folder that was
 * never registered, nor one whose agent was unregistered (its installs stay on
 * disk). The package cache's sweep must know what every install records before
 * it deletes anything (DOR-2249), so the installer writes one record here per
 * project install, and the sweep reads it.
 *
 * A record carries the commit and subfolder too, so an install on a drive that
 * is not plugged in right now stays protected. A record is dropped only when
 * its install is verifiably gone: its project folder exists and its install
 * folder does not, checked again at the moment of the drop. Any other doubt
 * keeps it, so the record of a deleted project stays and keeps its commit's
 * tree (it cannot be told apart from an unplugged drive).
 *
 * Writes are serialised in this process and land by an fsynced, atomic
 * rename. One server holds a data directory at a time (`lib/instance-lock.ts`).
 *
 * An index that does not parse (a torn write, a hand edit) is refused by every
 * reader, so the sweep stops rather than read it as empty. The next install
 * that records moves it aside to `project-installs.json.corrupt-<time>` and
 * starts a fresh one: installs keep being recorded, at the price of forgetting
 * the records the bad file held (those installs then rely on the agent
 * registry, like installs made before this record existed).
 *
 * @module services/marketplace/lib/project-install-index
 */
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** Where the index lives under dorkHome. */
const INDEX_PATH = path.join('marketplace', 'project-installs.json');

/** One project install, as the installer recorded it. */
export interface ProjectInstallRecord {
  /** The project the package was installed into. */
  projectPath: string;
  /** The package's install root inside that project's `.dork/`. */
  installRoot: string;
  /** The package name the install's sidecar records. */
  name: string;
  /** The full commit id it was fetched at; absent for local and `file://` installs. */
  commitSha?: string;
  /** The subfolder it was fetched from (`sourceKey.subpath`); absent when unknown. */
  subpath?: string;
}

/** On-disk shape of the index. */
interface IndexFile {
  version: 1;
  installs: ProjectInstallRecord[];
}

/** A readable index file that is not the shape this module writes. */
class CorruptIndexError extends Error {
  /**
   * Build the error for one index file.
   *
   * @param file - The index file.
   */
  constructor(readonly file: string) {
    super(`Can't make sense of ${file}`);
    this.name = 'CorruptIndexError';
  }
}

/** Tail of the in-process write chain, per index file. */
const writeChains = new Map<string, Promise<void>>();

/**
 * Read every recorded project install.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns The records; `[]` when nothing was ever recorded.
 * @throws {Error} When the index exists but cannot be read or parsed. A caller
 *   deciding what to delete must not read that as "nothing recorded".
 */
export async function readProjectInstalls(dorkHome: string): Promise<ProjectInstallRecord[]> {
  const file = path.join(dorkHome, INDEX_PATH);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Can't read ${file}: ${(err as Error).message}`, { cause: err });
  }
  const installs = parseIndex(raw);
  if (installs === null) throw new CorruptIndexError(file);
  return installs;
}

/**
 * Record a project install, replacing any earlier record for the same
 * install root (a reinstall or an applied update). An index that does not
 * parse is moved aside first, so recording always recovers.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param record - What the install recorded.
 */
export function recordProjectInstall(
  dorkHome: string,
  record: ProjectInstallRecord
): Promise<void> {
  return mutate(
    dorkHome,
    async (installs) => [
      ...installs.filter((existing) => existing.installRoot !== record.installRoot),
      record,
    ],
    { replaceCorrupt: true }
  );
}

/**
 * Drop records a sweep found gone, as a compare-and-delete inside the write
 * chain: a record goes only if it still matches what the sweep read (same
 * install root and commit) and its install folder is still missing while its
 * project folder exists. A reinstall that recorded in between, or that put
 * the folder back, keeps its record.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param gone - The records the sweep found gone, as it read them.
 */
export function forgetProjectInstalls(
  dorkHome: string,
  gone: readonly ProjectInstallRecord[]
): Promise<void> {
  if (gone.length === 0) return Promise.resolve();
  return mutate(dorkHome, async (installs) => {
    const kept: ProjectInstallRecord[] = [];
    for (const record of installs) {
      const readBySweep = gone.some(
        (g) => g.installRoot === record.installRoot && g.commitSha === record.commitSha
      );
      const stillGone =
        readBySweep &&
        (await existence(record.installRoot)) === 'missing' &&
        (await existence(record.projectPath)) === 'present';
      if (!stillGone) kept.push(record);
    }
    return kept;
  });
}

/**
 * Whether `target` exists: `'missing'` only on ENOENT, `'unknown'` on any
 * other failure (which proves nothing either way).
 *
 * @param target - Absolute path to check.
 */
export async function existence(target: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    await stat(target);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

/**
 * Read, change and durably rewrite the index, one change at a time.
 *
 * @param opts.replaceCorrupt - Move an unparseable index aside and start
 *   fresh instead of refusing. Only the install path sets it.
 * @internal
 */
function mutate(
  dorkHome: string,
  change: (installs: ProjectInstallRecord[]) => Promise<ProjectInstallRecord[]>,
  opts: { replaceCorrupt?: boolean } = {}
): Promise<void> {
  const file = path.join(dorkHome, INDEX_PATH);
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    let current: ProjectInstallRecord[];
    try {
      current = await readProjectInstalls(dorkHome);
    } catch (err) {
      if (!(opts.replaceCorrupt && err instanceof CorruptIndexError)) throw err;
      await rename(file, `${file}.corrupt-${Date.now()}`);
      current = [];
    }
    const body: IndexFile = { version: 1, installs: await change(current) };
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`, 'utf-8');
      // Durable before it replaces the old file, so a crash cannot leave a
      // renamed but empty index.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  });
  writeChains.set(
    file,
    next.catch(() => undefined)
  );
  return next;
}

/**
 * Parse index text, or `null` when it is not the shape this module writes.
 * Every field of every record is checked: these strings decide what the
 * cache keeps.
 *
 * @internal
 */
function parseIndex(raw: string): ProjectInstallRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { version, installs } = parsed as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(installs)) return null;
  const records: ProjectInstallRecord[] = [];
  for (const item of installs) {
    if (typeof item !== 'object' || item === null) return null;
    const { projectPath, installRoot, name, commitSha, subpath } = item as Record<string, unknown>;
    if (typeof projectPath !== 'string' || typeof installRoot !== 'string') return null;
    if (typeof name !== 'string') return null;
    if (commitSha !== undefined && typeof commitSha !== 'string') return null;
    if (subpath !== undefined && typeof subpath !== 'string') return null;
    records.push({
      projectPath,
      installRoot,
      name,
      ...(commitSha !== undefined && { commitSha }),
      ...(subpath !== undefined && { subpath }),
    });
  }
  return records;
}
