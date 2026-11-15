/**
 * A one-time Activity line naming the folders Codex trusts in the person's own
 * Codex settings (DOR-4410).
 *
 * Before Oct 5 2026, a Codex chat that could edit files ran through Codex's
 * exec transport, and Codex itself wrote `trust_level = "trusted"` for that
 * folder into `~/.codex/config.toml` (research `20261005_codex-app-server-spikes`).
 * Trust is what makes Codex load a folder's own `.codex/config.toml`, so such a
 * folder keeps loading its settings at every level, not only at Full (#3765).
 *
 * DorkOS cannot tell those entries from ones the person wrote, and the file is
 * the person's, so it is only read, never changed. Once per install, the
 * trusted folders are named in one line, so the person can review them in
 * Codex. Nothing is written when there are none.
 *
 * @module services/runtimes/codex/app-server/trusted-folders-notice
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityService } from '../../../activity/activity-service.js';

/** The largest settings file read; a real one is a few kilobytes. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** `[projects."<path>"]`, `[projects.'<path>']` or a bare key, with an optional comment. */
const PROJECT_TABLE =
  /^\[\s*projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
/** Any other table header. */
const TABLE = /^\[/;
/** `trust_level = "trusted"`, either quote, with an optional comment. */
const TRUSTED = /^trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/;

/**
 * The folders a Codex `config.toml` marks trusted, in file order. A plain line
 * reader, not a TOML parser: it reads the one shape Codex writes, and a file
 * it cannot follow names nothing rather than a wrong folder.
 *
 * @param text - The file's text.
 */
export function trustedProjectsIn(text: string): string[] {
  const found: string[] = [];
  let table: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const project = PROJECT_TABLE.exec(line);
    if (project) {
      table = project[1] !== undefined ? unescape(project[1]) : (project[2] ?? project[3]!);
      continue;
    }
    if (TABLE.test(line)) {
      table = null;
      continue;
    }
    if (table !== null && TRUSTED.test(line) && !found.includes(table)) found.push(table);
  }
  return found;
}

/** A basic TOML string's escapes, for the two a path can hold. */
function unescape(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** A Codex home's `config.toml` text, or `null` when it is absent, too big or not a file. */
function readConfig(home: string): string | null {
  try {
    const file = path.join(home, 'config.toml');
    // Followed through a link: the person's own file, often kept in a dotfiles repo.
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** What {@link recordTrustedFoldersNotice} needs. */
export interface TrustedFoldersNoticeDeps {
  /** The person's Codex homes to read; duplicates are read once. */
  homes: readonly string[];
  /** The done file, inside DorkOS's data directory. */
  doneFile: string;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'>;
}

/** Write the done file, atomically. */
function markDone(doneFile: string, folders: number): void {
  fs.mkdirSync(path.dirname(doneFile), { recursive: true });
  const tmp = `${doneFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, doneAt: new Date().toISOString(), folders }));
  fs.renameSync(tmp, doneFile);
}

/**
 * Name the folders Codex trusts in the person's settings, once per install.
 *
 * @param deps - The homes, the done file and the Activity writer.
 * @returns The folders named, or `null` when it already ran.
 */
export async function recordTrustedFoldersNotice(
  deps: TrustedFoldersNoticeDeps
): Promise<string[] | null> {
  if (fs.existsSync(deps.doneFile)) return null;
  const files: string[] = [];
  const folders: string[] = [];
  for (const home of new Set(deps.homes.map((h) => path.resolve(h)))) {
    const text = readConfig(home);
    if (text === null) continue;
    const trusted = trustedProjectsIn(text);
    if (trusted.length === 0) continue;
    files.push(path.join(home, 'config.toml'));
    for (const folder of trusted) if (!folders.includes(folder)) folders.push(folder);
  }
  if (folders.length > 0) {
    await deps.activity.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: 'codex_trusted_folders.noticed',
      resourceType: 'folder',
      resourceId: folders[0]!,
      summary:
        folders.length === 1
          ? 'Codex trusts 1 folder in your settings. Review it in Codex.'
          : `Codex trusts ${folders.length} folders in your settings. Review them in Codex.`,
      metadata: {
        folders,
        files,
        why: 'Before Oct 5, Codex could add a folder here when a DorkOS chat could edit files.',
      },
    });
  }
  markDone(deps.doneFile, folders.length);
  return folders;
}
