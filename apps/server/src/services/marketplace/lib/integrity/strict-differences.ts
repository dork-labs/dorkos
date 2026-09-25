/**
 * The exact-match rule every record rebuild shares (DOR-2197, DOR-2322).
 *
 * A record computed from the exact commit an install came from speaks for the
 * live folder only when every recorded file is still there with the same
 * bytes (files the package marks as the person's to edit may differ), and
 * nothing unrecorded sits where a package keeps what it runs. Check files and
 * the sweep after boot (`rebuildRecordStrict`) require exactly that; an
 * update's or uninstall's own rebuild (`rebuildInstalledFiles`) tries it first.
 * One function, so the two can never disagree about what "exact" means.
 *
 * @module services/marketplace/lib/integrity/strict-differences
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_PLUGIN_MANIFEST_PATH,
  declaredEffectPaths,
  EFFECT_BEARING_PATHS,
  isReservedPackagePath,
  matchesUserEditable,
} from '@dorkos/marketplace';
import { isNeverCarried, lstatChain, scanTree, type InstalledFiles } from '../installed-files.js';
import { cachedHashFile } from './file-hash-cache.js';

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/**
 * The locations the install's own plugin.json declares something runnable at
 * (`declaredEffectPaths`), read only when it is a regular file reached through
 * real directories. None when it is absent or unreadable.
 */
async function declaredLocationsOf(root: string): Promise<string[]> {
  if ((await lstatChain(root, CLAUDE_PLUGIN_MANIFEST_PATH)).kind !== 'file') return [];
  try {
    return declaredEffectPaths(
      JSON.parse(await readFile(fsPath(root, CLAUDE_PLUGIN_MANIFEST_PATH), 'utf-8'))
    );
  } catch {
    return [];
  }
}

/**
 * Unrecorded files and links at or under an effect-bearing path (the defaults,
 * and every location the install's plugin.json declares), found without
 * following any link. The installer's files, reserved paths (data, secrets,
 * `.dork-old` / `.dork-new` copies) and owned paths are never counted. An
 * agent's identity files (`.dork/agent.json`, `.dork/SOUL.md`, …) sit outside
 * every effect-bearing path, so they never reach this check.
 *
 * @param root - The install folder.
 * @param record - The record to compare with.
 * @returns The unrecorded paths, unsorted.
 */
export async function addedEffectFiles(root: string, record: InstalledFiles): Promise<string[]> {
  const counts = (p: string): boolean =>
    !(p in record.files) && !isReservedPackagePath(p) && !isNeverCarried(p, record.ownedPaths);
  const added = new Set<string>();
  const effectPaths = new Set<string>([
    ...Object.values(EFFECT_BEARING_PATHS),
    ...(await declaredLocationsOf(root)),
  ]);
  for (const effectPath of effectPaths) {
    const { kind } = await lstatChain(root, effectPath);
    if (kind === 'file' || kind === 'symlink') {
      if (counts(effectPath)) added.add(effectPath);
      continue;
    }
    if (kind !== 'dir') continue;
    const scan = await scanTree(fsPath(root, effectPath));
    for (const [rel, entry] of scan.entries) {
      const p = `${effectPath}/${rel}`;
      if ((entry.kind === 'file' || entry.kind === 'symlink') && counts(p)) added.add(p);
    }
  }
  return [...added];
}

/**
 * Where the live folder at `root` differs from `record`, by the exact rule: a
 * recorded file that is not a regular file with the same bytes (skipped when
 * `userEditable` covers it), and every unrecorded file where a package keeps
 * what it runs. Only regular files reached through real directories are read.
 *
 * @param root - The live install folder.
 * @param record - A record computed from the exact commit the install came from.
 * @param userEditable - The paths the person may edit freely.
 * @returns The differing paths, sorted and without repeats; empty means exact.
 */
export async function strictDifferences(
  root: string,
  record: InstalledFiles,
  userEditable: readonly string[]
): Promise<string[]> {
  const differing: string[] = [];
  for (const [p, hash] of Object.entries(record.files)) {
    if (matchesUserEditable(p, userEditable)) continue;
    const { kind } = await lstatChain(root, p);
    if (kind !== 'file' || (await cachedHashFile(fsPath(root, p))) !== hash) differing.push(p);
  }
  // The live folder must also hold nothing extra where a package keeps what it
  // runs: an unrecorded skill or hook would otherwise verify clean while it
  // runs. This also catches a case-only rename, whose live spelling is
  // unrecorded.
  differing.push(...(await addedEffectFiles(root, record)));
  return [...new Set(differing)].sort();
}
