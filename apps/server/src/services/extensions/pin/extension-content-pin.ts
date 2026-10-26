/**
 * Reading what an approval's digest is compared with, and building the
 * approval a yes writes (DOR-3068). The rule itself is pure and lives in
 * `extension-path-trust.ts` and `extension-load-policy.ts`; this module does
 * the I/O around it.
 *
 * - **What is digested.** The whole plugin folder for a plugin-carried copy
 *   (an extension can import any file its plugin ships), the extension's own
 *   folder otherwise. The same digest the installer and the snapshots use
 *   (`installFolderDigest`), so a snapshot of the approved files is named by
 *   the approval's own digest.
 * - **When it is read again.** Discovery reads it on every scan. Every other
 *   load (a reload, `test_extension`, starting a server half, serving the
 *   browser bundle) re-reads the live folder through {@link pinStillHolds},
 *   so an edit made after the scan is refused there too.
 * - **What a person is shown.** {@link changedFilesSince} names the files that
 *   differ from the approved snapshot, never their contents.
 *
 * @module services/extensions/pin/extension-content-pin
 */
import fs from 'fs/promises';
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import { installFolderDigest } from '../../marketplace/lib/install-digest.js';
import { isRuntimeStatePath } from '../../marketplace/lib/content-hash.js';
import { fileSha256Hex } from '../../marketplace/lib/records/tree-scan.js';
import { installRootOf } from '../extension-trusted-origin.js';
import { snapshotRootOf } from './extension-snapshots.js';
import { grantsDigestOf, keepsPathTrust } from './extension-path-trust.js';
import {
  approvedSourceOf,
  isSameStoredCopy,
  type ExtensionApprovals,
  type ExtensionDeclaringCopy,
} from '../extension-load-policy.js';

/** The most changed files a "changed since you approved" row names. */
export const CHANGED_FILES_MAX = 20;

/** The fields of a copy that say where its digested files are. */
type DigestedCopy = Pick<ExtensionRecord, 'path' | 'sourcePlugin'>;

/**
 * The folder a copy's digest covers: its plugin's install folder when it came
 * inside one, its own folder otherwise.
 *
 * @param copy - The extension record.
 */
export function digestRootOf(copy: DigestedCopy): string {
  return copy.sourcePlugin ? installRootOf(copy.path) : path.resolve(copy.path);
}

/**
 * The digest of a copy's files as they are on disk now, or null when the
 * folder holds a symbolic link or cannot be read (such a copy has nothing a
 * pinned approval could match).
 *
 * @param copy - The extension record.
 */
export async function liveDigestOf(copy: DigestedCopy): Promise<string | null> {
  const found = await installFolderDigest(digestRootOf(copy));
  return found.kind === 'digest' ? found.digest : null;
}

/**
 * Whether a copy approved by digest still holds exactly the approved files,
 * read from disk now rather than from the last scan. When it does not, the
 * record is marked with what it holds now, so every gate refuses it until a
 * person approves again. A copy with no digest-pinned approval passes.
 *
 * @param record - The extension record; updated in place on a mismatch.
 * @param approvals - `config.extensions`.
 * @returns `false` when the live files no longer match the approval.
 */
export async function pinStillHolds(
  record: ExtensionRecord,
  approvals: ExtensionApprovals
): Promise<boolean> {
  if (record.origin !== 'user' || record.devLink) return true;
  const source = approvals.approvedSources?.[record.id];
  if (!source?.digest || !isSameStoredCopy(record, source)) return true;
  const live = await liveDigestOf(record);
  if (live === source.digest) return true;
  record.currentDigest = live ?? undefined;
  record.pinnedDigest = undefined;
  record.runPath = undefined;
  return false;
}

/**
 * The approval a yes writes for this copy (DOR-3068): its folder and plugin,
 * the grants it declares now, the author's folder when one of our agents
 * created it, and the digest of its files unless it keeps path trust.
 *
 * @param copy - The extension record being approved.
 * @param options.digest - The copy's files as they are now, read just before.
 * @param options.authorHome - The real path of the creating agent's folder,
 *   when known: from `create_extension`, or kept from the approval it replaces.
 * @returns The approval to store, or null when it must be pinned and there is
 *   no digest to pin it to (the folder holds a link or cannot be read).
 */
export function approvalFor(
  copy: ExtensionDeclaringCopy,
  options: { digest: string | null; authorHome?: string }
): ExtensionApprovedSource | null {
  const source: ExtensionApprovedSource = {
    ...approvedSourceOf(copy),
    grants: grantsDigestOf(copy.manifest),
    ...(options.authorHome ? { authorHome: options.authorHome } : {}),
  };
  // A dev link is approved by path alone (DOR-2696).
  if (copy.devLink) return source;
  if (keepsPathTrust(copy, source)) {
    delete source.digest;
    return source;
  }
  if (!options.digest) return null;
  return { ...source, digest: options.digest };
}

/**
 * Refuse a yes when the copy's files changed after they were checked: the
 * code built for it must come from exactly the files the person was shown
 * (DOR-3068).
 *
 * @param copy - The extension record.
 * @param checked - The digest read before the build, or null.
 * @throws {ApprovalRefusedError} `stale` when the files differ now.
 */
export async function assertUnchangedSince(
  copy: DigestedCopy,
  checked: string | null
): Promise<void> {
  if ((await liveDigestOf(copy)) !== checked) {
    throw new ApprovalRefusedError('stale', 'Its files changed while DorkOS checked them.');
  }
}

/**
 * The real path of a folder, or null when it does not exist.
 *
 * @param target - A path.
 */
export async function realPathOf(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/** Whether a root-relative POSIX path is left out of the digest. */
function isSkipped(rel: string): boolean {
  return rel.toLowerCase().split('/').includes('.git') || isRuntimeStatePath(rel);
}

/** Every regular file under `root` the digest covers, by relative path, with its size. */
async function filesOf(root: string): Promise<Map<string, { abs: string; size: number }>> {
  const files = new Map<string, { abs: string; size: number }>();
  const visit = async (rel: string, dir: string): Promise<void> => {
    for (const name of await fs.readdir(dir)) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (isSkipped(childRel)) continue;
      const abs = path.join(dir, name);
      const stats = await fs.lstat(abs);
      if (stats.isDirectory()) await visit(childRel, abs);
      // A link is listed as a file so a new one shows up as a change.
      else files.set(childRel, { abs, size: stats.isFile() ? stats.size : -1 });
    }
  };
  await visit('', root);
  return files;
}

/**
 * The files that differ between the snapshot of the approved digest and the
 * copy's folder now: added, removed or edited, by path inside the digested
 * folder, sorted, at most {@link CHANGED_FILES_MAX}. Names only, never
 * contents.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param copy - The extension record.
 * @param approvedDigest - The digest the person approved.
 * @returns The changed paths, or null when the approved snapshot is gone or
 *   either folder cannot be read.
 */
export async function changedFilesSince(
  dorkHome: string,
  copy: DigestedCopy,
  approvedDigest: string
): Promise<string[] | null> {
  const snapshot = snapshotRootOf(dorkHome, approvedDigest);
  if (!snapshot) return null;
  try {
    const [before, now] = await Promise.all([filesOf(snapshot), filesOf(digestRootOf(copy))]);
    const changed: string[] = [];
    for (const rel of new Set([...before.keys(), ...now.keys()])) {
      const a = before.get(rel);
      const b = now.get(rel);
      if (!a || !b || a.size !== b.size || a.size < 0) {
        changed.push(rel);
      } else if ((await fileSha256Hex(a.abs)) !== (await fileSha256Hex(b.abs))) {
        changed.push(rel);
      }
    }
    return changed.sort().slice(0, CHANGED_FILES_MAX);
  } catch {
    return null;
  }
}

/**
 * The version the person approved, read from the snapshot of the approved
 * files: what an update row says it updates from ("Update from 1.2.0 to
 * 1.3.0"). Display only.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param copy - The extension record.
 * @param approvedDigest - The digest the person approved.
 * @returns The approved manifest's version, or null when the snapshot is
 *   gone or its manifest cannot be read.
 */
export async function approvedVersionOf(
  dorkHome: string,
  copy: DigestedCopy,
  approvedDigest: string
): Promise<string | null> {
  const snapshot = snapshotRootOf(dorkHome, approvedDigest);
  if (!snapshot) return null;
  const rel = path.relative(digestRootOf(copy), path.resolve(copy.path));
  try {
    const raw = await fs.readFile(path.join(snapshot, rel, 'extension.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Why a person's yes was not recorded (DOR-3068):
 *
 * - `stale` — the files changed after the card the person answered was drawn.
 * - `unpinnable` — the copy must be pinned to its files, and its folder holds
 *   a symbolic link or cannot be read, so there is nothing to pin it to.
 */
export class ApprovalRefusedError extends Error {
  /**
   * Build the refusal.
   *
   * @param reason - Why the yes was not recorded.
   * @param message - One plain sentence for the person.
   */
  constructor(
    readonly reason: 'stale' | 'unpinnable',
    message: string
  ) {
    super(message);
    this.name = 'ApprovalRefusedError';
  }
}
