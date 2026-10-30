/**
 * Reading a worktree's setting files and hook scripts the way Claude Code
 * would, for the repo settings check (DOR-3298).
 *
 * Settings files (`.claude/settings*.json`, `.mcp.json`) are read following a
 * symlink, as Claude Code reads them. Hook scripts are read with lstat, as git
 * stores them: a symlink is its target path, so a committed symlink compares
 * equal to the same symlink on disk. Every file is capped at 64 KB; a bigger
 * one, or one that is not a regular file, can't be vouched for.
 *
 * Synchronous on purpose, like `folder-config-pin.ts`: a handful of small files
 * per launch.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-files
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';

/** The largest file read. */
const MAX_FILE_BYTES = 64 * 1024;

/** The most hook scripts read under one `.claude/hooks/`. */
const MAX_FILES = 200;

/** How deep `.claude/hooks/` is walked. */
const MAX_DEPTH = 4;

/** What reading one settings file gave. */
export type SettingsRead =
  | { kind: 'absent' }
  | { kind: 'unverifiable' }
  | { kind: 'malformed'; text: string }
  | { kind: 'parsed'; value: unknown; text: string };

/**
 * Read a settings file as Claude Code does: following a symlink, regular files
 * only, capped, parsed as JSON.
 *
 * @param file - The absolute path.
 */
export function readSettingsFile(file: string): SettingsRead {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { kind: 'unverifiable' };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unverifiable' };
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { kind: 'unverifiable' };
  }
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return { kind: 'unverifiable' };
  try {
    return { kind: 'parsed', value: JSON.parse(text) as unknown, text };
  } catch {
    return { kind: 'malformed', text };
  }
}

/** What reading one hook script gave. */
export type ScriptRead =
  | { kind: 'absent' }
  | { kind: 'dir' }
  | { kind: 'unverifiable' }
  | { kind: 'file'; bytes: Buffer; symlink: boolean };

/**
 * Read one hook script as git stores it: a symlink is its target path.
 *
 * @param file - The absolute path.
 */
export function readScript(file: string): ScriptRead {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unverifiable' };
  }
  try {
    if (stat.isSymbolicLink()) {
      return { kind: 'file', bytes: Buffer.from(readlinkSync(file)), symlink: true };
    }
    if (stat.isDirectory()) return { kind: 'dir' };
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { kind: 'unverifiable' };
    const bytes = readFileSync(file);
    if (bytes.byteLength > MAX_FILE_BYTES) return { kind: 'unverifiable' };
    return { kind: 'file', bytes, symlink: false };
  } catch {
    return { kind: 'unverifiable' };
  }
}

/**
 * Every file under `dir`, as absolute paths, or `undefined` when the tree
 * can't be vouched for (too deep, too many files, unreadable). A missing
 * folder is no files.
 *
 * @param dir - The folder to walk, usually `<cwd>/.claude/hooks`.
 */
export function walkScripts(dir: string): string[] | undefined {
  const out: string[] = [];
  const walk = (abs: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    let names: string[];
    try {
      if (!lstatSync(abs).isDirectory()) return false;
      names = readdirSync(abs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
    for (const name of names) {
      const child = path.join(abs, name);
      let isDir: boolean;
      try {
        isDir = lstatSync(child).isDirectory();
      } catch {
        return false;
      }
      if (isDir) {
        if (!walk(child, depth + 1)) return false;
      } else {
        if (out.length >= MAX_FILES) return false;
        out.push(child);
      }
    }
    return true;
  };
  return walk(dir, 1) ? out : undefined;
}

/**
 * Only the named keys of a parsed object, or `null` when none is set. A value
 * that is not an object is kept whole, so it is a change like any other.
 *
 * @param value - A parsed settings file.
 * @param keys - The keys to keep.
 */
export function pickKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { notAnObject: value };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) out[key] = (value as Record<string, unknown>)[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * sha256, hex.
 *
 * @param content - Text or bytes.
 */
export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A path relative to `root`, with forward slashes, as git names it.
 *
 * @param root - The repo top.
 * @param abs - A path inside it.
 */
export function repoRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Whether `target` is `root` or inside it.
 *
 * @param root - The folder.
 * @param target - The path to test.
 */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
