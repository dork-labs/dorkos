/**
 * Marketplace package scanner — discovers DorkOS packages on disk by looking
 * for the `.dork/manifest.json` marker in immediate child directories.
 *
 * This module is Node.js-only and is not re-exported from the package barrel.
 * Consumers import it via the `@dorkos/marketplace/package-scanner` subpath.
 *
 * @module @dorkos/marketplace/package-scanner
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { PACKAGE_MANIFEST_PATH } from './constants.js';

/**
 * A directory that has been identified as a marketplace package by the scanner.
 *
 * The scanner only checks for the presence of `.dork/manifest.json` — it does
 * not validate the manifest contents. Use the package validator for that.
 */
export interface ScannedPackage {
  /** Absolute path to the package root. */
  packagePath: string;
  /** Package name (directory basename). */
  name: string;
}

/**
 * Scan a directory for marketplace packages.
 *
 * A package is identified by the presence of `.dork/manifest.json` directly
 * inside an immediate child directory of `rootPath`. The scanner does not
 * recurse — only first-level children are inspected. Non-directory entries
 * and directories without a manifest file are silently skipped.
 *
 * @param rootPath - Absolute path to the directory to scan.
 * @returns Array of scanned packages, in the order returned by `readdir`.
 */
export async function scanPackageDirectory(rootPath: string): Promise<ScannedPackage[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const packages: ScannedPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.join(rootPath, entry.name);
    const manifestPath = path.join(packagePath, PACKAGE_MANIFEST_PATH);
    try {
      await fs.access(manifestPath);
      packages.push({ packagePath, name: entry.name });
    } catch {
      // Not a package directory — skip silently.
    }
  }
  return packages;
}
