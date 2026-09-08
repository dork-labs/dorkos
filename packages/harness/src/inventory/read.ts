/**
 * The inventory's filesystem primitives — every read that can fail, failing into
 * an {@link UnreadableSource} instead of an exception.
 *
 * `inventorySourceTree` runs on whatever tree it is pointed at, including a
 * hostile one, and a hostile tree is not exotic: a file where a directory is
 * expected, a symlink whose target moved, a half-written JSON file. Each of
 * those is something a person can see and fix, so each becomes a record with a
 * reason rather than a crash three layers up in `dorkos harness sync`. Absent is
 * different from unreadable and stays silent: a repository with no
 * `.claude/rules` has nothing to report.
 *
 * @module inventory/read
 */
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, sep } from 'node:path';
import type { ArtifactType } from '../plan/types.js';
import type { UnreadableSource } from './types.js';

/**
 * A repo-relative path with forward slashes on every platform.
 *
 * Every `source` in the inventory and in a {@link ../plan/types.js#ProjectionAction}
 * is POSIX-separated, so a Windows checkout produces the same strings a macOS one
 * does and the completeness check compares like with like.
 *
 * @param parts - path segments, already repo-relative.
 * @returns the joined path with `/` separators.
 */
export function relPath(...parts: string[]): string {
  return parts.join('/').split(sep).join('/');
}

/** The message a failed read carries, from whatever the filesystem threw. */
function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What {@link readDirEntries} found: the entries, or the reason there are none. */
export interface DirReadResult {
  /** The directory's immediate entries, empty when it is absent or unreadable. */
  entries: Dirent[];
  /** Set when something occupies the path but could not be listed. */
  unreadable?: UnreadableSource;
}

/**
 * List a directory's immediate entries, turning "something is there and it is
 * not a directory" into a reportable finding.
 *
 * An ABSENT directory is silent — nothing was authored, so there is nothing to
 * say. Anything else that stops the listing (a regular file at the path, a
 * dangling link, a permission error) is an {@link UnreadableSource}.
 *
 * @param absDir - absolute path of the directory to list.
 * @param relDir - its repo-relative path, for the finding.
 * @param kind - the artifact kind this directory would have held.
 * @returns the entries and, when the listing failed, why.
 */
export function readDirEntries(absDir: string, relDir: string, kind: ArtifactType): DirReadResult {
  if (lstatSync(absDir, { throwIfNoEntry: false }) === undefined) return { entries: [] };
  try {
    return { entries: readdirSync(absDir, { withFileTypes: true }) };
  } catch (err) {
    return {
      entries: [],
      unreadable: {
        kind,
        source: relDir,
        reason: `${relDir} could not be listed as a directory (${causeOf(err)}), so nothing in it was inventoried`,
      },
    };
  }
}

/** What {@link readTextFile} found: the text, or the reason there is none. */
export interface TextReadResult {
  /** The file's UTF-8 content, absent when it could not be read. */
  text?: string;
  /** Set when something occupies the path and could not be read. */
  unreadable?: UnreadableSource;
}

/**
 * Read a file that is known to be there — a directory entry the walk just
 * listed, or a path a caller already probed.
 *
 * The failure this exists for is a DANGLING SYMLINK: `readdir` reports it as an
 * entry and `readFile` throws `ENOENT` on it, so a link whose target moved would
 * otherwise take down the whole inventory.
 *
 * @param absPath - absolute path of the file.
 * @param relFile - its repo-relative path, for the finding.
 * @param kind - the artifact kind the file would have held.
 * @returns the content, or why there is none.
 */
export function readTextFile(absPath: string, relFile: string, kind: ArtifactType): TextReadResult {
  try {
    return { text: readFileSync(absPath, 'utf8') };
  } catch (err) {
    return {
      unreadable: {
        kind,
        source: relFile,
        reason: `${relFile} could not be read (${causeOf(err)}) — a link whose target moved, or a file this process may not open`,
      },
    };
  }
}

/** What {@link readJsonFile} found: the parsed value, or the reason there is none. */
export interface JsonReadResult {
  /** The parsed JSON value, absent when the file is absent or unusable. */
  value?: unknown;
  /** Set when the file exists and could not be parsed into an object. */
  unreadable?: UnreadableSource;
}

/**
 * Read and parse a JSON file, reporting an absent one as nothing and a broken
 * one as a finding.
 *
 * "Broken" covers both halves a person would call broken: bytes that are not
 * JSON, and JSON whose top level is not an object (an array or a bare string
 * holds no server map and no hooks map).
 *
 * @param absPath - absolute path of the JSON file.
 * @param relFile - its repo-relative path, for the finding.
 * @param kind - the artifact kind the file would have held.
 * @returns the parsed object, or why there is none.
 */
export function readJsonFile(absPath: string, relFile: string, kind: ArtifactType): JsonReadResult {
  if (lstatSync(absPath, { throwIfNoEntry: false }) === undefined) return {};
  const { text, unreadable } = readTextFile(absPath, relFile, kind);
  if (text === undefined) return { unreadable };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      unreadable: {
        kind,
        source: relFile,
        reason: `${relFile} is not valid JSON (${causeOf(err)}), so nothing it declares was inventoried`,
      },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      unreadable: {
        kind,
        source: relFile,
        reason: `${relFile} parses, but its top level is not an object, so nothing it declares was inventoried`,
      },
    };
  }
  return { value: parsed };
}

/** One markdown file a walk found, with the name a harness would key it by. */
export interface MarkdownFile {
  /** The name: the path below the walked root, without the `.md` suffix. */
  name: string;
  /** Repo-relative path of the file, forward slashes. */
  source: string;
}

/** Options for {@link listMarkdownFiles}. */
export interface ListMarkdownOptions {
  /** Whether to descend into subdirectories. Defaults to `false`. */
  recursive?: boolean;
}

/** A path's real location, or the path itself when it does not resolve. */
function realpathOr(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return absPath;
  }
}

/**
 * List the `.md` files under a root, sorted by name so the inventory is
 * deterministic.
 *
 * **Symlinks are followed, both kinds.** A linked-in FILE is a rule or a
 * subagent somebody keeps elsewhere, and `Dirent.isFile()` is false for one — the
 * same trap `scan/scanner.ts` documents for skill directories. A linked-in
 * DIRECTORY is the shape a person uses to share a whole folder of rules with
 * their other repositories (`.claude/agents/shared -> ~/company-agents`), and
 * `Dirent.isDirectory()` is false for that one, so it used to be neither a
 * directory to descend into nor an `.md` file — skipped without a word.
 *
 * Following directory links means a link can point back into the tree, so the
 * walk keeps a set of realpaths it has entered and refuses to enter one twice.
 * Before, a loop terminated only because nothing ever descended through it.
 *
 * A DEAD `.md` link is recorded as unreadable and left out of the results. The
 * entry is plainly in the directory, so saying nothing is wrong; but so is
 * returning it, because a caller that never opens the file — the subagent scan
 * used to be one — would otherwise report a `native` for a path that resolves to
 * nothing.
 *
 * @param absRoot - absolute path of the directory to walk.
 * @param relRoot - its repo-relative path, the prefix each result carries.
 * @param kind - the artifact kind this directory holds, for any finding.
 * @param options - see {@link ListMarkdownOptions}.
 * @returns the markdown files found, and every entry that could not be read.
 */
export function listMarkdownFiles(
  absRoot: string,
  relRoot: string,
  kind: ArtifactType,
  options: ListMarkdownOptions = {}
): { files: MarkdownFile[]; unreadable: UnreadableSource[] } {
  const files: MarkdownFile[] = [];
  const unreadable: UnreadableSource[] = [];
  const entered = new Set<string>();

  const walk = (absDir: string, relDir: string): void => {
    const real = realpathOr(absDir);
    if (entered.has(real)) return;
    entered.add(real);

    const result = readDirEntries(absDir, relDir, kind);
    if (result.unreadable) unreadable.push(result.unreadable);
    for (const entry of result.entries) {
      const absEntry = join(absDir, entry.name);
      const relEntry = relPath(relDir, entry.name);
      if (entry.isDirectory()) {
        if (options.recursive) walk(absEntry, relEntry);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // `stat`, not `lstat`: the question is what the link resolves to.
        const resolved = statSync(absEntry, { throwIfNoEntry: false });
        if (resolved === undefined) {
          if (!entry.name.endsWith('.md')) continue;
          unreadable.push({
            kind,
            source: relEntry,
            reason: `${relEntry} is a link whose target is not there, so nothing was inventoried from it`,
          });
          continue;
        }
        if (resolved.isDirectory()) {
          if (options.recursive) walk(absEntry, relEntry);
          continue;
        }
      } else if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      files.push({
        name: relEntry.slice(relRoot.length + 1, -'.md'.length),
        source: relEntry,
      });
    }
  };

  walk(absRoot, relRoot);
  return { files: files.sort((a, b) => a.name.localeCompare(b.name)), unreadable };
}
