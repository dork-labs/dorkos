import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import type { FileEntry } from '@dorkos/shared/schemas';
import { FILE_LIMITS, FILE_LISTING } from '../../config/constants.js';
import { validateBoundary } from '../../lib/boundary.js';

/** Convert an OS-separated relative path to a POSIX (`/`) path for the wire. */
function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/**
 * File listing service for the client file browser.
 *
 * Tries `git ls-files` first for accuracy, falls back to recursive readdir.
 * Results are cached with a 5-minute TTL. Enforces a 10,000 file limit.
 *
 * @module services/file-lister
 */
const execFileAsync = promisify(execFile);

class FileListService {
  private cache = new Map<string, { files: string[]; timestamp: number }>();

  async listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }> {
    await validateBoundary(cwd);

    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.timestamp < FILE_LISTING.CACHE_TTL_MS) {
      return {
        files: cached.files,
        truncated: cached.files.length >= FILE_LISTING.MAX_FILES,
        total: cached.files.length,
      };
    }

    let files: string[];
    try {
      files = await this.listViaGit(cwd);
    } catch {
      files = await this.listViaReaddir(cwd);
    }

    const truncated = files.length > FILE_LISTING.MAX_FILES;
    if (truncated) files = files.slice(0, FILE_LISTING.MAX_FILES);

    this.cache.set(cwd, { files, timestamp: Date.now() });
    return { files, truncated, total: files.length };
  }

  private async listViaGit(cwd: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      {
        cwd,
        maxBuffer: FILE_LIMITS.GIT_MAX_BUFFER,
      }
    );
    return stdout.split('\n').filter(Boolean);
  }

  private async listViaReaddir(cwd: string, prefix = '', depth = 0): Promise<string[]> {
    if (depth > FILE_LIMITS.MAX_READDIR_DEPTH) return [];
    const results: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(path.join(cwd, prefix), { withFileTypes: true });
    } catch {
      // Permission denied or inaccessible directory — skip silently
      return [];
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (FILE_LISTING.EXCLUDED_DIRS.has(entry.name)) continue;
        results.push(...(await this.listViaReaddir(cwd, rel, depth + 1)));
      } else {
        results.push(rel);
      }
      if (results.length >= FILE_LISTING.MAX_FILES) break;
    }
    return results;
  }

  invalidateCache(cwd?: string): void {
    if (cwd) this.cache.delete(cwd);
    else this.cache.clear();
  }

  /**
   * List one directory level (or several, up to `depth`) of a working directory
   * for the workbench file explorer. Each entry's `path` is relative to `cwd`
   * (POSIX-separated). Directories are listed before files, alphabetically.
   *
   * Both `baseDir` and `cwd` must already be boundary-validated absolute paths
   * (the route does this). By default dotfiles and `.gitignore`d entries are
   * filtered out via `git check-ignore`; `showHidden` includes them. When the
   * directory is not inside a git repo, git awareness degrades to the static
   * excluded-directories denylist.
   *
   * @param baseDir - Absolute directory to list (the requested subtree root).
   * @param cwd - Absolute session working directory the returned paths are relative to.
   * @param depth - Recursion bound (1 = immediate children only).
   * @param showHidden - Include dotfiles and gitignored entries.
   */
  async listTree(
    baseDir: string,
    cwd: string,
    depth: number,
    showHidden: boolean
  ): Promise<FileEntry[]> {
    return this.collectLevel(baseDir, cwd, depth, showHidden);
  }

  private async collectLevel(
    dir: string,
    cwd: string,
    depth: number,
    showHidden: boolean
  ): Promise<FileEntry[]> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied or inaccessible directory — skip silently.
      return [];
    }

    // `.git` is never listed. Dotfiles are hidden unless requested.
    let candidates = dirents.filter((d) => d.name !== '.git');
    if (!showHidden) {
      candidates = candidates.filter((d) => !d.name.startsWith('.'));
      candidates = await this.filterGitignored(dir, cwd, candidates);
    }

    const described: { entry: FileEntry; abs: string }[] = [];
    for (const d of candidates) {
      const abs = path.join(dir, d.name);
      const entry = await describeEntry(abs, d, cwd);
      if (entry) described.push({ entry, abs });
    }
    // Directories first, then files, each alphabetical — a conventional tree order.
    described.sort((a, b) =>
      a.entry.type === b.entry.type
        ? a.entry.name.localeCompare(b.entry.name)
        : a.entry.type === 'dir'
          ? -1
          : 1
    );

    const out: FileEntry[] = [];
    for (const { entry, abs } of described) {
      out.push(entry);
      // Never recurse THROUGH a symlinked directory — following it would walk (and
      // disclose metadata for) a tree outside the confined working directory.
      if (depth > 1 && entry.type === 'dir' && !entry.isSymlink) {
        out.push(...(await this.collectLevel(abs, cwd, depth - 1, showHidden)));
      }
      if (out.length >= FILE_LISTING.MAX_FILES) break;
    }
    return out;
  }

  /**
   * Drop gitignored entries from a directory level. Uses `git check-ignore` (run
   * in `cwd`) for accuracy; when the directory is not in a git repo the command
   * fails and we fall back to the static excluded-directories denylist.
   */
  private async filterGitignored(
    dir: string,
    cwd: string,
    candidates: Dirent[]
  ): Promise<Dirent[]> {
    if (candidates.length === 0) return candidates;
    const relPaths = candidates.map((d) => toPosix(path.relative(cwd, path.join(dir, d.name))));
    const ignored = await this.gitIgnoredSet(cwd, relPaths);
    if (ignored) {
      return candidates.filter((_, i) => !ignored.has(relPaths[i]));
    }
    // No git awareness — approximate with the well-known build/dep directories.
    return candidates.filter((d) => !(d.isDirectory() && FILE_LISTING.EXCLUDED_DIRS.has(d.name)));
  }

  private async gitIgnoredSet(cwd: string, relPaths: string[]): Promise<Set<string> | null> {
    try {
      // `check-ignore` echoes the ignored inputs (one per line). `-z` is not used
      // because it requires `--stdin`; directory-entry names never contain
      // newlines in practice, so line-splitting is safe here.
      const { stdout } = await execFileAsync('git', ['check-ignore', '--', ...relPaths], {
        cwd,
        maxBuffer: FILE_LIMITS.GIT_MAX_BUFFER,
      });
      return new Set(stdout.split('\n').filter(Boolean));
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      // `git check-ignore` exits 1 when NONE of the paths are ignored — that is a
      // successful empty result, not a failure.
      if (e.code === 1) {
        return new Set(e.stdout ? e.stdout.split('\n').filter(Boolean) : []);
      }
      // Exit 128 (not a git repo) or git missing — no git-based awareness.
      return null;
    }
  }
}

/**
 * Build a {@link FileEntry} for a directory child. `fs.stat` follows symlinks so
 * a link to a directory is typed as `dir`; a broken link falls back to `lstat`.
 * Returns `null` when the entry can't be stat'd at all (raced deletion, EACCES).
 */
async function describeEntry(abs: string, dirent: Dirent, cwd: string): Promise<FileEntry | null> {
  const isSymlink = dirent.isSymbolicLink();
  let type: 'file' | 'dir';
  let size = 0;
  let mtime = 0;
  try {
    const st = await fs.stat(abs);
    type = st.isDirectory() ? 'dir' : 'file';
    size = st.isDirectory() ? 0 : st.size;
    mtime = Math.floor(st.mtimeMs);
  } catch {
    try {
      const lst = await fs.lstat(abs);
      type = lst.isDirectory() ? 'dir' : 'file';
      size = lst.isDirectory() ? 0 : lst.size;
      mtime = Math.floor(lst.mtimeMs);
    } catch {
      return null;
    }
  }
  return {
    name: dirent.name,
    path: toPosix(path.relative(cwd, abs)),
    type,
    size,
    mtime,
    isSymlink,
  };
}

export const fileLister = new FileListService();
