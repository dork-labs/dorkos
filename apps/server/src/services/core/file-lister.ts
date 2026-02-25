import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { FILE_LIMITS, FILE_LISTING } from '../../config/constants.js';
import { validateBoundary } from '../../lib/boundary.js';

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
    const entries = await fs.readdir(path.join(cwd, prefix), { withFileTypes: true });
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
}

export const fileLister = new FileListService();
