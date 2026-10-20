/**
 * The folder and file names no web approval may touch, wherever they sit.
 * Used by `relay-approvable.ts` for file writes and the folders commands run
 * in, and by `command-tripwire.ts` for command text. Names are compared
 * already folded (lower case where the file system ignores case).
 *
 * Settings names: writing there changes what agents may do next.
 *
 * | Name                                      | Why                                    |
 * | ----------------------------------------- | -------------------------------------- |
 * | any `.claude*` folder                     | Claude Code settings, hooks and skills |
 * | `.dork`, `.codex`, `.opencode`, `.agents` | DorkOS and harness settings and skills |
 * | `opencode.json`, `opencode.jsonc`         | OpenCode settings, wherever they sit   |
 * | `.mcp.json`                               | which MCP servers a harness starts     |
 *
 * Run-later names: writing there plants code that runs later, outside the
 * one run the owner read.
 *
 * | Name                                                  | Why                                   |
 * | ----------------------------------------------------- | ------------------------------------- |
 * | any `.git` part, and any git folder by its contents   | hooks run on commit; config runs code |
 * | `.husky`, `.githooks`, `.lefthook`                    | git hooks, committed to the project   |
 * | `lefthook.yml`, `.lefthook.yml`, `lefthook-local.yml` | git hooks                             |
 * | `.pre-commit-config.yaml`, `.simple-git-hooks*`       | git hooks                             |
 * | `.lintstagedrc*`                                      | runs on commit                        |
 * | `.vscode`, `.cursor`, `.zed`, `*.code-workspace`      | editor tasks run when a folder opens  |
 * | `.idea`                                               | run configurations                    |
 * | `.devcontainer`                                       | runs when the container is built      |
 * | `.github/workflows`, `.github/actions`                | runs in CI on the next push           |
 * | `.gitlab-ci.yml`, `.circleci`, `.buildkite`           | runs in CI on the next push           |
 * | `.envrc`, `.envrc.local`                              | direnv runs it on entering the folder |
 * | `mise.toml`, `.mise.toml`                             | mise runs its hooks and tasks         |
 *
 * A git folder not named `.git` (a bare clone such as `.bare`) is known by
 * its contents: a `HEAD` file beside an `objects` folder. Nothing inside one
 * may be written, which covers its `hooks` folder and its `config` file.
 *
 * `.env` files stay allowed: they hold values, not code. `package.json`
 * scripts are code too, but refusing every `package.json` would refuse most
 * ordinary project work, so it stays allowed.
 *
 * @module services/core/session-relay/web-approvable/protected-names
 */
import fs from 'node:fs';
import path from 'node:path';

/** Folders under which nothing may be written (`.claude*` matches by prefix). */
const PROTECTED_FOLDERS = new Set([
  // Harness settings.
  '.dork',
  '.codex',
  '.opencode',
  '.agents',
  // Run later.
  '.git',
  '.husky',
  '.githooks',
  '.lefthook',
  '.vscode',
  '.cursor',
  '.zed',
  '.idea',
  '.devcontainer',
  '.circleci',
  '.buildkite',
]);

/** Files that may not be written wherever they sit. */
const PROTECTED_FILES = new Set([
  // Harness settings.
  'opencode.json',
  'opencode.jsonc',
  '.mcp.json',
  // Run later.
  '.envrc',
  '.envrc.local',
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook-local.yml',
  '.pre-commit-config.yaml',
  '.gitlab-ci.yml',
  'mise.toml',
  '.mise.toml',
]);

/** File name prefixes and suffixes that run later, whatever follows or leads. */
const PROTECTED_PREFIXES = ['.simple-git-hooks', '.lintstagedrc'];
const PROTECTED_SUFFIXES = ['.code-workspace'];

/** `.github/<folder>` folders that run in CI. */
const CI_FOLDERS = new Set(['workflows', 'actions']);

/** A folder name no web approval may write under. */
function protectedFolder(part: string): boolean {
  return part.startsWith('.claude') || PROTECTED_FOLDERS.has(part);
}

/** A file name no web approval may write. */
function protectedFile(name: string): boolean {
  return (
    PROTECTED_FILES.has(name) ||
    PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    PROTECTED_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Whether the parts hold `.github` directly followed by a CI folder. */
function namesCiFolder(parts: readonly string[]): boolean {
  return parts.some((part, i) => part === '.github' && CI_FOLDERS.has(parts[i + 1] ?? ''));
}

/**
 * Whether a resolved, folded path is under a protected name.
 *
 * @param target - An absolute path, already folded for case where case is ignored.
 * @returns True when any folder in it, or its file name, is protected.
 */
export function pathNamesProtected(target: string): boolean {
  const parts = target.split(path.sep);
  return (
    parts.some(protectedFolder) || protectedFile(path.basename(target)) || namesCiFolder(parts)
  );
}

/**
 * Whether one word of command text names a protected folder or file. Every
 * path part is checked as both, since a command may name either.
 *
 * @param parts - One word of folded command text, split on path separators.
 * @returns True when any part, or a `.github` CI pair, is protected.
 */
export function wordNamesProtected(parts: readonly string[]): boolean {
  return parts.some((part) => protectedFolder(part) || protectedFile(part)) || namesCiFolder(parts);
}

/** Whether a folder on disk is a git folder: a `HEAD` file beside an `objects` folder. */
function isGitDir(dir: string): boolean {
  try {
    return (
      fs.statSync(path.join(dir, 'HEAD')).isFile() &&
      fs.statSync(path.join(dir, 'objects')).isDirectory()
    );
  } catch {
    return false;
  }
}

/**
 * Whether a path is a git folder or inside one, whatever that folder is named.
 *
 * @param target - An absolute path with its existing part resolved, in the case the disk stores.
 * @returns True when it, or any folder above it, is a git folder.
 */
export function insideGitDir(target: string): boolean {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (isGitDir(dir)) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * A path with its deepest existing ancestor resolved by the OS (symlinks
 * followed, the case the disk stores), the rest appended as written.
 *
 * @param target - An absolute path.
 * @returns The same path as the disk would reach it.
 */
export function realOrResolved(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
