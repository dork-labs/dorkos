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
import { normalizeTrustedSource } from '../marketplace/lib/provenance/trusted-source.js';
import { logger } from '../../lib/logger.js';

/** One install DorkOS's installer recorded, reduced to what proves an origin. */
export interface TrustedInstall {
  /** The plugin's install folder. */
  installRoot: string;
  /** The normalized `owner/repo`, when the installer recorded one. */
  source?: string;
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
 * Where this copy provably came from, or null.
 *
 * Pure: the caller reads the installs once per discovery pass
 * ({@link readTrustedInstalls}) and hands them in.
 *
 * @param copy - A discovered copy.
 * @param installs - The installs this machine's installer recorded.
 * @returns The copy's trusted origin, or null when this machine cannot prove one.
 */
export function trustedOriginOf(
  copy: OriginCopy,
  installs: TrustedInstalls
): ExtensionOrigin | null {
  if (!copy.sourcePlugin) return null;
  const root = installRootOf(copy.path);
  const pool = copy.scope === 'global' ? installs.global : installs.project;
  const install = pool.find((candidate) => path.resolve(candidate.installRoot) === root);
  if (!install?.source) return null;
  return { plugin: copy.sourcePlugin, source: install.source };
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
      const metadata = await readInstallMetadata(installRoot);
      const source = normalizeTrustedSource(metadata?.sourceRepo);
      global.push({ installRoot, ...(source ? { source } : {}) });
    })
  );

  let project: TrustedInstall[] = [];
  try {
    project = (await readProjectInstalls(dorkHome)).map((install) => ({
      installRoot: path.resolve(install.installRoot),
      ...(install.source ? { source: install.source } : {}),
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
