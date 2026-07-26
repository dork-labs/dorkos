/**
 * Undo ledger for scaffolding into a directory that may already belong to
 * someone.
 *
 * A scaffold can stop partway through (a full disk, a permission change), and
 * the cleanup that follows must remove what this run added and nothing else.
 * The ledger records each path as the run creates it, then removes only those
 * paths, re-checking every one of them at removal time so it never deletes
 * something that changed underneath it.
 *
 * @module lib/scaffold-ledger
 */
import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';

/** One thing a scaffold run created. */
interface LedgerEntry {
  /** Absolute path that was created. */
  path: string;
  /**
   * What was created there. A `tree` is a directory the run created along with
   * everything under it, undone by pruning empty directories from the bottom
   * up so any file that appeared inside it survives.
   */
  kind: 'file' | 'dir' | 'tree';
}

/** What {@link ScaffoldLedger.rollback} managed to undo. */
export interface RollbackOutcome {
  /** Paths the rollback deleted. */
  removed: string[];
  /** Paths that are still on disk because deleting them was not safe or not possible. */
  kept: string[];
}

/**
 * Records what a scaffold run created so a failure can undo exactly that much.
 *
 * Every recording step proves the run is the creator before it writes the entry
 * down: {@link ScaffoldLedger.mkdir} relies on a non-recursive `mkdir`, which
 * fails when the directory is already there, and
 * {@link ScaffoldLedger.claimFile} records a path only when nothing exists at
 * it yet. {@link ScaffoldLedger.noteFile} is for writers that report their own
 * created paths.
 */
export class ScaffoldLedger {
  private readonly entries: LedgerEntry[] = [];

  /**
   * Create a directory and record it only when this call is what made it.
   *
   * The `mkdir` is non-recursive on purpose: it either creates the directory or
   * fails with `EEXIST`, so there is no window where another process could have
   * created it first and had it recorded as ours.
   *
   * @param dirPath - Absolute path of the directory to create
   * @returns True when this call created the directory
   */
  async mkdir(dirPath: string): Promise<boolean> {
    try {
      await fs.mkdir(dirPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
    this.entries.push({ path: dirPath, kind: 'dir' });
    return true;
  }

  /**
   * Record a file path this run is about to write, but only when nothing is
   * there yet.
   *
   * Uses `lstat`, so a symlink counts as something being there and the path is
   * left out of the ledger.
   *
   * @param filePath - Absolute path of the file about to be written
   */
  async claimFile(filePath: string): Promise<void> {
    try {
      await fs.lstat(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.entries.push({ path: filePath, kind: 'file' });
    }
  }

  /**
   * Record a file that another writer reports it created during this run.
   *
   * @param filePath - Absolute path of the created file
   */
  noteFile(filePath: string): void {
    this.entries.push({ path: filePath, kind: 'file' });
  }

  /**
   * Record a directory tree that another writer reports it created during this
   * run, named by its topmost new directory.
   *
   * The caller must have proof, which in practice means a recursive `mkdir`
   * returned this path: that return value says the directory did not exist, so
   * nothing at or below it predates the run. Rollback still only removes empty
   * directories, so a file that appeared inside the tree keeps itself and its
   * parents.
   *
   * Record a tree before the files written into it, so rollback deletes those
   * files first and leaves the directories empty enough to go.
   *
   * @param dirPath - Absolute path of the topmost created directory
   */
  noteDirTree(dirPath: string): void {
    this.entries.push({ path: dirPath, kind: 'tree' });
  }

  /**
   * Delete the recorded paths, newest first so directories empty out before
   * they are removed.
   *
   * Each path is re-checked first. A recorded file is deleted only when it is
   * still a plain file, a recorded directory only when it is still a directory
   * and is empty, and a recorded tree only down to the directories inside it
   * that are empty. Anything else is left alone and reported in
   * {@link RollbackOutcome.kept}. Paths that are already gone are reported in
   * neither list.
   *
   * @returns What was deleted and what is still on disk
   */
  async rollback(): Promise<RollbackOutcome> {
    const removed: string[] = [];
    const kept: string[] = [];

    for (const entry of [...this.entries].reverse()) {
      const state = await this.statEntry(entry.path);
      if (state === 'gone') continue;
      if (await this.remove(entry, state)) removed.push(entry.path);
      else kept.push(entry.path);
    }

    return { removed, kept };
  }

  /** Classify what is currently at `entryPath` without following symlinks. */
  private async statEntry(entryPath: string): Promise<'file' | 'dir' | 'other' | 'gone'> {
    try {
      const stats = await fs.lstat(entryPath);
      if (stats.isFile()) return 'file';
      if (stats.isDirectory()) return 'dir';
      return 'other';
    } catch {
      return 'gone';
    }
  }

  /** Delete one recorded entry when what is on disk still matches what was recorded. */
  private async remove(entry: LedgerEntry, state: 'file' | 'dir' | 'other'): Promise<boolean> {
    if (entry.kind === 'tree') {
      if (state !== 'dir') return false;
      return this.pruneEmpty(entry.path);
    }
    if (state !== entry.kind) return false;
    try {
      if (entry.kind === 'file') await fs.unlink(entry.path);
      // Non-recursive on purpose: a directory that picked up files this run did
      // not create fails with ENOTEMPTY and stays where it is.
      else await fs.rmdir(entry.path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove `dirPath` and the directories under it, deepest first, stopping at
   * anything that is not an empty directory.
   *
   * Only `rmdir` is used, so a file or a symlink anywhere in the tree keeps
   * itself and every directory above it. Never `rm -rf`.
   *
   * @param dirPath - Directory to prune
   * @returns True when `dirPath` itself was removed
   */
  private async pruneEmpty(dirPath: string): Promise<boolean> {
    let children: Dirent[];
    try {
      children = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const child of children) {
      // `isDirectory()` is false for a symlink, so a link to a directory is
      // never followed and never pruned.
      if (child.isDirectory()) await this.pruneEmpty(path.join(dirPath, child.name));
    }

    try {
      await fs.rmdir(dirPath);
      return true;
    } catch {
      return false;
    }
  }
}
