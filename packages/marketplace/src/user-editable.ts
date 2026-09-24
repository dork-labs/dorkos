/**
 * Which paths inside a package belong to whom (ADR 260923-163513, 260923-163514).
 *
 * Two questions a package's paths raise, answered in one browser-safe place:
 *
 * - **Reserved paths.** Some paths inside an install root always belong to the
 *   person or the installer: the package's data directory, its secrets file,
 *   the installer's own records, and the `.dork-old` / `.dork-new` copies an
 *   update saves. A package may never ship one, because the next update would
 *   then treat a person's file as the package's.
 * - **`userEditable`.** A package can say that some of the files it ships are
 *   meant to be edited. On update an edited copy of such a file is kept, and a
 *   changed default is saved beside it; every other shipped file is replaced,
 *   with the person's edited copy saved beside it. The pattern language is
 *   deliberately tiny: an exact path, or a directory prefix ending `/**`.
 *
 * @module @dorkos/marketplace/user-editable
 */
import { z } from 'zod';
import {
  CLAUDE_PLUGIN_MANIFEST_PATH,
  INSTALL_METADATA_POSIX_PATH,
  INSTALLED_FILES_PATH,
  PACKAGE_DATA_DIR,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_SECRETS_PATH,
  UNINSTALLED_AGENT_PATH,
} from './constants.js';

/** Single reserved files, as POSIX paths relative to the package root. */
const RESERVED_FILES: readonly string[] = [
  PACKAGE_SECRETS_PATH,
  INSTALL_METADATA_POSIX_PATH,
  INSTALLED_FILES_PATH,
  UNINSTALLED_AGENT_PATH,
];

/** A basename ending `.dork-old` or `.dork-new`, optionally numbered (`.dork-old.2`), any case. */
const KEPT_COPY_BASENAME = /\.dork-(?:old|new)(?:\.\d+)?$/i;

/**
 * A path folded the way a case-insensitive volume compares names. APFS and
 * NTFS treat `.dork/Secrets.json` as `.dork/secrets.json`, so every ownership
 * comparison here runs on folded paths: compatibility forms first (`ſ` is
 * `s`), then lower case.
 */
function fold(posixPath: string): string {
  return posixPath.normalize('NFKC').toLowerCase();
}

/** The package identity files; a package's identity is never the person's to keep. */
const IDENTITY_FILES: readonly string[] = [PACKAGE_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH];

/**
 * Whether a package-relative POSIX path is reserved for the person or the
 * installer, so a package may not ship it.
 *
 * @param posixPath - A path relative to the package root, `/`-separated.
 */
export function isReservedPackagePath(posixPath: string): boolean {
  const p = fold(posixPath);
  if (p === PACKAGE_DATA_DIR || p.startsWith(`${PACKAGE_DATA_DIR}/`)) return true;
  if (RESERVED_FILES.includes(p)) return true;
  const basename = p.slice(p.lastIndexOf('/') + 1);
  return KEPT_COPY_BASENAME.test(basename);
}

/** The directory a `dir/**` pattern names, or `undefined` for an exact path. */
function prefixOf(pattern: string): string | undefined {
  return pattern.endsWith('/**') ? pattern.slice(0, -3) : undefined;
}

/**
 * Whether a pattern covers `target`, a file or directory path: an exact pattern
 * covers only itself; `dir/**` covers everything beneath `dir`, and `dir`
 * itself when `target` is a directory that contains it.
 */
function covers(pattern: string, target: string): boolean {
  const prefix = prefixOf(pattern);
  if (prefix === undefined) return pattern === target;
  return target.startsWith(`${prefix}/`) || `${target}/`.startsWith(`${prefix}/`);
}

/** Whether a pattern reaches any reserved path or package identity file, in any case. */
function coversOwnedPath(value: string): 'reserved' | 'identity' | undefined {
  const pattern = fold(value);
  const prefix = prefixOf(pattern);
  if (prefix === undefined) {
    if (IDENTITY_FILES.includes(pattern)) return 'identity';
    return isReservedPackagePath(pattern) ? 'reserved' : undefined;
  }
  if (IDENTITY_FILES.some((p) => covers(pattern, p))) return 'identity';
  if ([PACKAGE_DATA_DIR, ...RESERVED_FILES].some((p) => covers(pattern, p))) return 'reserved';
  return isReservedPackagePath(prefix) ? 'reserved' : undefined;
}

/**
 * One `userEditable` entry: a POSIX path relative to the package root, or a
 * directory prefix ending `/**`. Nothing else is accepted, and no entry may
 * cover a reserved path or the package's own identity files.
 */
export const UserEditablePathSchema = z.string().superRefine((value, ctx) => {
  const fail = (message: string): void => {
    ctx.addIssue({ code: 'custom', message });
  };
  if (value.length === 0) return fail('userEditable entries cannot be empty');
  if (value.length > 512) return fail('userEditable entries are at most 512 characters');
  if (value.includes('\\')) return fail(`"${value}": use / between folders, not \\`);
  if (value.startsWith('/')) return fail(`"${value}": use a path relative to the package root`);
  if (value.startsWith('./')) return fail(`"${value}": drop the leading ./`);
  const body = prefixOf(value) ?? value;
  if (body.length === 0) return fail(`"${value}": name a folder before /**`);
  if (body.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return fail(`"${value}": a path may not contain empty, "." or ".." parts`);
  }
  if (/[*?]/.test(body)) {
    return fail(`"${value}": only an exact path or a folder ending /** is supported`);
  }
  const owned = coversOwnedPath(value);
  if (owned === 'identity') {
    return fail(`"${value}": a package's own manifest files can't be user-editable`);
  }
  if (owned === 'reserved') {
    return fail(`"${value}": that path already belongs to the person or DorkOS`);
  }
});

/**
 * Whether a package-relative POSIX file path is covered by `userEditable`.
 *
 * @param posixPath - The file path, `/`-separated, relative to the package root.
 * @param patterns - The package's `userEditable` list.
 */
export function matchesUserEditable(posixPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const prefix = prefixOf(pattern);
    return prefix === undefined ? posixPath === pattern : posixPath.startsWith(`${prefix}/`);
  });
}
