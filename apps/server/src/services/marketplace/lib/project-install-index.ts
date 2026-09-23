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
 * folder does not. Any other doubt keeps it.
 *
 * Writes are serialised in this process and land by atomic rename. One
 * server holds a data directory at a time (`lib/instance-lock.ts`).
 *
 * @module services/marketplace/lib/project-install-index
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  if (installs === null) throw new Error(`Can't make sense of ${file}`);
  return installs;
}

/**
 * Record a project install, replacing any earlier record for the same
 * install root (a reinstall or an applied update).
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param record - What the install recorded.
 */
export function recordProjectInstall(
  dorkHome: string,
  record: ProjectInstallRecord
): Promise<void> {
  return mutate(dorkHome, (installs) => [
    ...installs.filter((existing) => existing.installRoot !== record.installRoot),
    record,
  ]);
}

/**
 * Drop the records of install roots that are verifiably gone.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param installRoots - The install roots to forget.
 */
export function forgetProjectInstalls(dorkHome: string, installRoots: string[]): Promise<void> {
  if (installRoots.length === 0) return Promise.resolve();
  const gone = new Set(installRoots);
  return mutate(dorkHome, (installs) => installs.filter((r) => !gone.has(r.installRoot)));
}

/**
 * Read, change and atomically rewrite the index, one change at a time.
 *
 * @internal
 */
function mutate(
  dorkHome: string,
  change: (installs: ProjectInstallRecord[]) => ProjectInstallRecord[]
): Promise<void> {
  const file = path.join(dorkHome, INDEX_PATH);
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    const installs = change(await readProjectInstalls(dorkHome));
    const body: IndexFile = { version: 1, installs };
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
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
