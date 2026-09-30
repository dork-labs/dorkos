/**
 * Where a copy of an extension provably came from (spec `flow-multiproject`
 * §9.1, D9).
 *
 * An approval used to be bound only to a copy's PATH, so the same plugin
 * installed into four repos was four copies and asked four times. The fix is
 * to bind it to where the code came from as well, but "where it came from"
 * must be something this machine can prove. A file inside a repo cannot prove
 * it: `.dork/install-metadata.json` can be committed by anyone, so a clone could
 * claim any source it liked. So a copy has a trusted origin only when:
 *
 * - it is carried by a plugin under `{dorkHome}/plugins/<p>/`, which only
 *   DorkOS writes; its origin is that install's recorded `sourceRepo`; or
 * - it is carried by a plugin under `<project>/.dork/plugins/<p>/` AND
 *   `{dorkHome}/marketplace/project-installs.json` holds a record for exactly
 *   that install folder with a `source` (written by the installer at install
 *   time, never read back from the project).
 *
 * Three more conditions hold for both, because a record names only a folder:
 *
 * - **Neither the plugin folder nor the extension folder is a link.** A linked
 *   install is a developer's own tree, and its sidecar lives in that tree; it
 *   proves nothing (the same rule as `global-plugin-consent.ts`).
 * - **A project copy's whole plugin folder still holds exactly what the
 *   installer staged.** The record keeps the staged folder's digest
 *   (`installFolderDigest`), because an extension's bundle can import any
 *   file in its plugin; anything that writes inside the project — an agent, a
 *   `git pull`, a re-clone — can put other code at the same path, and a
 *   changed folder has no origin. Discovery reports it (`originProblem`) so
 *   Settings can say so. The digest found at the scan is pinned on the record
 *   and checked again before and after every bundle (`extension-compiler.ts`),
 *   so a swap between the scan and the load is caught too.
 * - **No symbolic link anywhere in the plugin folder.** The installer strips
 *   every link, and a loader follows one that a hash of files skips.
 * - **The install was fetched from a branch or tag** of the source
 *   repository, never a pull-request head or a bare commit a fork could have
 *   supplied (`isTrustableRef`).
 *
 * Everything else (a direct copy, a plugin committed into a repo someone
 * cloned, a project install recorded before `source` existed) has none, and is
 * approved only by path, exactly as before. `installedFrom` is never used: it
 * is a marketplace name the person chose, not a proven source.
 *
 * @module services/extensions/extension-trusted-origin
 */
import fs from 'fs/promises';
import path from 'path';
import type { ExtensionOrigin, ExtensionRecord } from '@dorkos/extension-api';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import { readInstallMetadata } from '../marketplace/installed-metadata.js';
import { readProjectInstalls } from '../marketplace/lib/project-install-index.js';
import { trustedSourceOfInstall } from '../marketplace/lib/trusted-source.js';
import {
  installFolderDigest,
  installFolderLinks,
  type InstallDigest,
} from '../marketplace/lib/install-digest.js';
import { logger } from '../../lib/logger.js';

/** One install DorkOS's installer recorded, reduced to what proves an origin. */
export interface TrustedInstall {
  /** The plugin's install folder. */
  installRoot: string;
  /** The normalized `owner/repo`, when the installer recorded one. */
  source?: string;
  /** Project installs only: the whole install folder's digest, as staged. */
  installDigest?: string;
}

/** What a copy's plugin folder looks like on disk now, read by {@link inspectCopy}. */
export interface CopyOnDisk {
  /**
   * A project copy: the whole install folder's digest, or why there is none.
   * A global plugin: only whether it holds a link (`clean` when it does not);
   * `{dorkHome}` is DorkOS's own and is never digested.
   */
  folder: InstallDigest | { kind: 'clean' };
}

/**
 * Why a plugin-carried copy has no trusted origin although the installer
 * recorded where it came from.
 *
 * - `changed` — a project copy whose install folder no longer hashes to what
 *   the installer staged, or now holds a symbolic link: someone changed it
 *   after DorkOS installed it.
 * - `linked` — a global plugin that is, or holds, a symbolic link (a linked
 *   developer install): its files live somewhere DorkOS never checked.
 */
export type OriginProblem = 'changed' | 'linked';

/** Where a copy provably came from, and why not when it cannot say. */
export interface OriginProof {
  /** The trusted origin, or null. */
  origin: ExtensionOrigin | null;
  /** Why a recorded copy has none, or null. */
  problem: OriginProblem | null;
  /**
   * The digest the origin was proved against: the one every compile of this
   * copy must still find (`pinnedDigest`). Null without an origin.
   */
  pinnedDigest: string | null;
}

/** The installs an origin may be proved from, split by where they live. */
export interface TrustedInstalls {
  /** Plugins under `{dorkHome}/plugins`, from their own sidecars. */
  global: readonly TrustedInstall[];
  /** Project installs, from `project-installs.json` only. */
  project: readonly TrustedInstall[];
}

/** The fields of a discovered copy that say where on disk it sits. */
export type OriginCopy = Pick<ExtensionRecord, 'path' | 'scope' | 'sourcePlugin'>;

/**
 * The plugin install folder that carries a plugin-carried copy:
 * `<installRoot>/.dork/extensions/<id>` → `<installRoot>`.
 *
 * @param copyPath - The copy's directory.
 */
export function installRootOf(copyPath: string): string {
  return path.resolve(copyPath, '..', '..', '..');
}

/**
 * Where this copy provably came from, and, when the installer recorded it but
 * the folder cannot be vouched for, why.
 *
 * Pure: the caller reads the installs once per discovery pass
 * ({@link readTrustedInstalls}) and each copy once ({@link inspectCopy}).
 *
 * @param copy - A discovered copy.
 * @param installs - The installs this machine's installer recorded.
 * @param onDisk - The copy's plugin folder as it is on disk now.
 */
export function proveOrigin(
  copy: OriginCopy,
  installs: TrustedInstalls,
  onDisk: CopyOnDisk
): OriginProof {
  const none: OriginProof = { origin: null, problem: null, pinnedDigest: null };
  if (!copy.sourcePlugin) return none;
  const root = installRootOf(copy.path);
  const pool = copy.scope === 'global' ? installs.global : installs.project;
  const install = pool.find((candidate) => path.resolve(candidate.installRoot) === root);
  if (!install?.source) return none;
  const { folder } = onDisk;
  if (copy.scope === 'local') {
    if (!install.installDigest) return none;
    if (folder.kind !== 'digest' || folder.digest !== install.installDigest) {
      return { ...none, problem: 'changed' };
    }
  } else if (folder.kind === 'linked') {
    return { ...none, problem: 'linked' };
  } else if (folder.kind === 'unreadable') {
    return none;
  }
  return {
    origin: { plugin: copy.sourcePlugin, source: install.source },
    problem: null,
    pinnedDigest: folder.kind === 'digest' ? folder.digest : null,
  };
}

/**
 * Where this copy provably came from, or null. See {@link proveOrigin}.
 *
 * @param copy - A discovered copy.
 * @param installs - The installs this machine's installer recorded.
 * @param onDisk - The copy's plugin folder as it is on disk now.
 */
export function trustedOriginOf(
  copy: OriginCopy,
  installs: TrustedInstalls,
  onDisk: CopyOnDisk
): ExtensionOrigin | null {
  return proveOrigin(copy, installs, onDisk).origin;
}

/**
 * Read what {@link proveOrigin} needs from disk: the digest of the whole
 * plugin folder that carries the copy, or that it holds a link.
 *
 * @param copy - A discovered plugin-carried copy.
 */
export async function inspectCopy(copy: OriginCopy): Promise<CopyOnDisk> {
  const root = installRootOf(copy.path);
  if (copy.scope === 'global') {
    const links = await installFolderLinks(root);
    return { folder: { kind: links } };
  }
  return { folder: await installFolderDigest(root) };
}

/**
 * Whether two origins are the same proven source for the same plugin.
 *
 * @param a - One origin, or nothing.
 * @param b - The other, or nothing.
 */
export function sameOrigin(
  a: ExtensionOrigin | null | undefined,
  b: ExtensionOrigin | null | undefined
): boolean {
  return !!a && !!b && a.plugin === b.plugin && a.source === b.source;
}

/**
 * Read every install an origin may be proved from: each global plugin's own
 * sidecar (a folder only DorkOS writes), and the project install index. A
 * project index that does not parse proves nothing, so it reads as empty.
 *
 * @param dorkHome - DorkOS's data directory.
 */
export async function readTrustedInstalls(dorkHome: string): Promise<TrustedInstalls> {
  const pluginsDir = path.join(dorkHome, 'plugins');
  const global: TrustedInstall[] = [];
  let names: string[] = [];
  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !isInstallSiblingName(name));
  } catch {
    // No global plugins.
  }
  await Promise.all(
    names.map(async (name) => {
      const installRoot = path.resolve(pluginsDir, name);
      // A linked install's sidecar lives in the developer's own tree, so it
      // proves nothing (`global-plugin-consent.ts` answers the same way).
      const linked = await fs
        .lstat(installRoot)
        .then((stats) => stats.isSymbolicLink())
        .catch(() => true);
      const metadata = linked ? null : await readInstallMetadata(installRoot);
      const source = metadata ? trustedSourceOfInstall(metadata) : null;
      global.push({ installRoot, ...(source ? { source } : {}) });
    })
  );

  let project: TrustedInstall[] = [];
  try {
    project = (await readProjectInstalls(dorkHome)).map((install) => ({
      installRoot: path.resolve(install.installRoot),
      ...(install.source ? { source: install.source } : {}),
      ...(install.installDigest ? { installDigest: install.installDigest } : {}),
    }));
  } catch (err) {
    logger.warn(
      '[Extensions] Could not read the project install index; no project copy has a proven source',
      {
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
  return { global, project };
}
