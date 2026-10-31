/**
 * Which of a project's packages DorkOS itself installed, with their files
 * still as installed: the only packages whose hooks run without a person on
 * the Full preset (DOR-3422).
 *
 * The scan that finds a project's packages treats any folder under
 * `<project>/.dork/plugins/` holding a manifest as installed. A repository can
 * commit one, so "found here" says nothing about who put it there. The proof is
 * the installer's own record in `{dorkHome}/marketplace/project-installs.json`
 * (outside the project, where a commit cannot reach) for that install folder,
 * carrying the digest of the folder as it was staged, and the folder still
 * hashing to it (`installFolderDigest`). The same two facts give a project
 * extension its trusted origin (`extensions/extension-trusted-origin.ts`).
 *
 * Not proven, and so asked about even on Full: a folder with no record, a
 * record with no digest (a local or `file://` install), a folder whose files
 * changed since, and a dev link (its folder is a link, which never digests).
 *
 * Async because the digest walks the folder; `planWithConsent` is sync, so each
 * trigger proves first and passes the answer in. One that passes nothing has
 * nothing proven, which is the strict answer.
 *
 * @module services/harness/dorkos-installed
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { readProjectInstalls } from '../marketplace/lib/project-install-index.js';
import { installFolderDigest } from '../marketplace/lib/install-digest.js';

/**
 * One package DorkOS installed into a project, unchanged since: its install
 * folder (resolved) and its name.
 */
export interface ProvenInstall {
  /** The install folder, resolved. */
  installRoot: string;
  /** The package name the installer recorded. */
  name: string;
}

/** A path's real form, or its absolute one when it cannot be resolved. */
function canonical(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The packages DorkOS installed into this project whose files are unchanged.
 *
 * Never throws: an index that cannot be read proves nothing.
 *
 * @param projectPath - The project root.
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns One entry per proven install, keyed for lookup by install folder.
 */
export async function provenDorkosInstalls(
  projectPath: string,
  dorkHome: string
): Promise<ReadonlyMap<string, ProvenInstall>> {
  const proven = new Map<string, ProvenInstall>();
  let installs;
  try {
    installs = await readProjectInstalls(dorkHome);
  } catch {
    return proven;
  }
  const project = canonical(projectPath);
  for (const record of installs) {
    if (!record.installDigest || canonical(record.projectPath) !== project) continue;
    const folder = await installFolderDigest(record.installRoot);
    if (folder.kind !== 'digest' || folder.digest !== record.installDigest) continue;
    const installRoot = canonical(record.installRoot);
    proven.set(installRoot, { installRoot, name: record.name });
  }
  return proven;
}

/**
 * {@link provenDorkosInstalls}, only when the answer can change anything: on
 * Full. Below Full every undecided package asks anyway, so the folder walk is
 * skipped.
 *
 * @param projectPath - The project root.
 * @param dorkHome - Resolved DorkOS data directory.
 * @param full - Whether the stored preset is Full.
 * @returns The proven installs, or `undefined` below Full.
 */
export async function provenDorkosInstallsIfFull(
  projectPath: string,
  dorkHome: string,
  full: boolean
): Promise<ReadonlyMap<string, ProvenInstall> | undefined> {
  return full ? provenDorkosInstalls(projectPath, dorkHome) : undefined;
}

/**
 * Whether one scanned package is a proven DorkOS install.
 *
 * @param proven - What {@link provenDorkosInstalls} answered.
 * @param installRoot - The scanned package's folder.
 * @param packageName - The scanned package's name.
 */
export function isProvenDorkosInstall(
  proven: ReadonlyMap<string, ProvenInstall> | undefined,
  installRoot: string,
  packageName: string
): boolean {
  return proven?.get(canonical(installRoot))?.name === packageName;
}
