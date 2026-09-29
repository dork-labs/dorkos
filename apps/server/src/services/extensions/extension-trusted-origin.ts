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
 * - **A project copy's folder still holds exactly what the installer put
 *   there.** The record keeps each carried extension folder's digest
 *   (`extensionDigestsOf`); anything that writes inside the project — an
 *   agent, a `git pull`, a re-clone — can put other code at the same path,
 *   and a changed folder has no origin. Discovery reports it
 *   (`changedSinceInstall`) so Settings can say so. Global plugins are not
 *   re-hashed: `{dorkHome}` is DorkOS's own, and editing a file on this
 *   machine is outside what an install hash guards (`content-hash.ts`).
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
import { readProjectInstalls } from '../marketplace/lib/provenance/project-install-index.js';
import { trustedSourceOfInstall } from '../marketplace/lib/provenance/trusted-source.js';
import { extensionFolderDigest } from '../marketplace/lib/provenance/extension-digest.js';
import { logger } from '../../lib/logger.js';

/** One install DorkOS's installer recorded, reduced to what proves an origin. */
export interface TrustedInstall {
  /** The plugin's install folder. */
  installRoot: string;
  /** The normalized `owner/repo`, when the installer recorded one. */
  source?: string;
  /** Project installs only: each carried extension folder's digest at install. */
  extensionDigests?: Record<string, string>;
}

/** What a copy looks like on disk right now, read by {@link inspectCopy}. */
export interface CopyOnDisk {
  /** The plugin folder or the extension folder is a symbolic link. */
  linked: boolean;
  /** The extension folder's digest now; project copies only, else null. */
  digest: string | null;
}

/** Where a copy provably came from, and why not when it cannot say. */
export interface OriginProof {
  /** The trusted origin, or null. */
  origin: ExtensionOrigin | null;
  /**
   * The installer recorded this project copy, but its folder no longer holds
   * what was installed (or became a link): someone changed it afterwards.
   */
  changedSinceInstall: boolean;
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
 * Where this copy provably came from, and whether a recorded project copy
 * changed after the installer put it there.
 *
 * Pure: the caller reads the installs once per discovery pass
 * ({@link readTrustedInstalls}) and each copy once ({@link inspectCopy}).
 *
 * @param copy - A discovered copy.
 * @param installs - The installs this machine's installer recorded.
 * @param onDisk - The copy as it is on disk now.
 */
export function proveOrigin(
  copy: OriginCopy,
  installs: TrustedInstalls,
  onDisk: CopyOnDisk
): OriginProof {
  const none: OriginProof = { origin: null, changedSinceInstall: false };
  if (!copy.sourcePlugin) return none;
  const root = installRootOf(copy.path);
  const pool = copy.scope === 'global' ? installs.global : installs.project;
  const install = pool.find((candidate) => path.resolve(candidate.installRoot) === root);
  if (!install?.source) return none;
  if (copy.scope === 'local') {
    const recorded = install.extensionDigests?.[path.basename(copy.path)];
    if (!recorded) return none;
    if (onDisk.linked || onDisk.digest !== recorded) {
      return { origin: null, changedSinceInstall: true };
    }
  } else if (onDisk.linked) {
    return none;
  }
  return {
    origin: { plugin: copy.sourcePlugin, source: install.source },
    changedSinceInstall: false,
  };
}

/**
 * Where this copy provably came from, or null. See {@link proveOrigin}.
 *
 * @param copy - A discovered copy.
 * @param installs - The installs this machine's installer recorded.
 * @param onDisk - The copy as it is on disk now.
 */
export function trustedOriginOf(
  copy: OriginCopy,
  installs: TrustedInstalls,
  onDisk: CopyOnDisk
): ExtensionOrigin | null {
  return proveOrigin(copy, installs, onDisk).origin;
}

/**
 * Read what {@link proveOrigin} needs from disk: whether the copy or its
 * plugin folder is a link, and, for a project copy, its folder's digest.
 *
 * @param copy - A discovered plugin-carried copy.
 */
export async function inspectCopy(copy: OriginCopy): Promise<CopyOnDisk> {
  const isLink = async (target: string): Promise<boolean> => {
    try {
      return (await fs.lstat(target)).isSymbolicLink();
    } catch {
      return true;
    }
  };
  const linked = (await isLink(installRootOf(copy.path))) || (await isLink(copy.path));
  const digest = copy.scope === 'local' && !linked ? await extensionFolderDigest(copy.path) : null;
  return { linked, digest };
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
      ...(install.extensionDigests ? { extensionDigests: install.extensionDigests } : {}),
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
