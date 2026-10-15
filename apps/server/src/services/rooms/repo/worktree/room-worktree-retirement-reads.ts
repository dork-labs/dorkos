/** Original private legacy-retirement observations and exact text decoding. */
import { existsSync, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { isUnmodifiedSeededSkill, OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import { CLAUDE_INSTRUCTION_CONTENT } from '@dorkos/harness/workspace-data';
import { AGENT_WORKSPACE_HARNESSES } from '../../../harness/agent-workspace-harnesses.js';
import { roomHiddenUntrackedRaw } from '../room-repo-git.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { readOriginalRoomWorktreeRetirementView } from '../room-worktree-manager.js';
import type { RoomWorktreeManager } from '../room-worktree-manager.js';

/** A file's text, or `''` when it does not exist. */
export async function readIfPresent(engineOwner: object, file: string): Promise<string> {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * The pattern lines of DorkOS's marker block in an `info/exclude` file, or none
 * when there is no block.
 *
 * @param exclude - The file's text.
 */
export function blockPatterns(engineOwner: object, exclude: string): string[] {
  const facet = readOriginalRoomWorktreeRetirementView(engineOwner);
  const start = exclude.indexOf(facet.EXCLUDE_SENTINEL);
  if (start === -1) return [];
  const endAt = exclude.indexOf(facet.EXCLUDE_END, start);
  const body = exclude.slice(start, endAt === -1 ? undefined : endAt);
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * The `info/exclude` file with DorkOS's block removed, and everything outside
 * it — another writer's lines — kept.
 *
 * @param current - What the file holds now.
 */
export function withoutExcludeBlock(engineOwner: object, current: string): string {
  const facet = readOriginalRoomWorktreeRetirementView(engineOwner);
  const start = current.indexOf(facet.EXCLUDE_SENTINEL);
  if (start === -1) return current;
  const endAt = current.indexOf(facet.EXCLUDE_END, start);
  const after =
    endAt === -1 ? '' : current.slice(endAt + facet.EXCLUDE_END.length).replace(/^\n/, '');
  return `${current.slice(0, start)}${after}`;
}

/**
 * Untracked files in `worktree` that the block's `patterns` hide, as paths
 * relative to it. One `git ls-files`, file by file (a symlink to a folder is
 * one entry).
 *
 * @param worktree - The worktree.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param patterns - The block's lines.
 */
export async function hiddenUntracked(
  engineOwner: object,
  worktree: string,
  ceiling: string,
  patterns: readonly string[]
): Promise<string[]> {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  const out = await roomHiddenUntrackedRaw(worktree, ceiling, patterns);
  // NUL records are decoded without trimming: a literal path may begin or end with a space.
  return out
    .toString('utf-8')
    .split('\0')
    .filter((rel) => rel !== '');
}

/**
 * Whether one untracked, block-hidden file is something DorkOS wrote while a
 * room turn stood in this worktree — see
 * {@link RoomWorktreeManager.retireLegacyPlumbing} for the rules.
 *
 * @param worktree - The worktree.
 * @param rel - The file, relative to it.
 * @param agentPath - The worktree's agent's home.
 */
export async function isLegacyPlumbing(
  engineOwner: object,
  worktree: string,
  rel: string,
  agentPath: string
): Promise<boolean> {
  const facet = readOriginalRoomWorktreeRetirementView(engineOwner);
  const posix = rel.split(path.sep).join('/');
  const abs = path.join(worktree, rel);
  if (posix.startsWith(`${facet.LEGACY_ATTACHMENTS_DIR}/`)) return true;
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    const linkIsOurs =
      posix.startsWith('.claude/skills/') ||
      (posix.startsWith('.agents/skills/') && path.basename(posix).includes('__'));
    if (!linkIsOurs) return false;
    const target = await fs.realpath(abs).catch(() => null);
    if (target === null) {
      // A dangling link into where the pack or the home was is still ours if
      // its written target says so.
      const written = path.resolve(path.dirname(abs), await fs.readlink(abs));
      return insideAny(engineOwner, written, [path.join(worktree, '.agents', 'skills'), agentPath]);
    }
    return insideAny(engineOwner, target, [
      await realOr(engineOwner, path.join(worktree, '.agents', 'skills')),
      await realOr(engineOwner, agentPath),
    ]);
  }
  if (!stat.isFile()) return false;
  const seeded = OPERATING_SKILLS_PACK.find(
    (skill) => posix === `.agents/skills/${skill.name}/SKILL.md`
  );
  if (seeded) return isUnmodifiedSeededSkill(abs, await fs.readFile(abs, 'utf-8'));
  if (posix === '.agents/harness.manifest.json') {
    try {
      const parsed = JSON.parse(await fs.readFile(abs, 'utf-8')) as { harnesses?: unknown };
      return (
        Array.isArray(parsed.harnesses) &&
        parsed.harnesses.length === AGENT_WORKSPACE_HARNESSES.length &&
        AGENT_WORKSPACE_HARNESSES.every((h, i) => (parsed.harnesses as unknown[])[i] === h)
      );
    } catch {
      return false;
    }
  }
  if (posix === '.claude/CLAUDE.md') {
    return (await fs.readFile(abs, 'utf-8')) === CLAUDE_INSTRUCTION_CONTENT;
  }
  return false;
}

/** Whether `target` is one of `roots` or inside one. */
export function insideAny(engineOwner: object, target: string, roots: readonly string[]): boolean {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** A folder's real path, or its resolved spelling when it does not exist. */
export async function realOr(engineOwner: object, dir: string): Promise<string> {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Whether a path is a directory that exists. */
export async function directoryExists(engineOwner: object, dir: string): Promise<boolean> {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a directory is a git checkout, cheaply.
 *
 * A `.git` entry is enough and a git command would be too much: this runs on
 * the turn path, on every cwd resolution. In a linked worktree `.git` is a file
 * naming the real gitdir, so `existsSync` rather than a directory check.
 *
 * @param dir - The directory to inspect.
 */
export async function isCheckout(engineOwner: object, dir: string): Promise<boolean> {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  if (!(await directoryExists(engineOwner, dir))) return false;
  return existsSync(path.join(dir, '.git'));
}

/** Compare the original filesystem inode and device identity. */
export function sameWorktreeInode(engineOwner: object, left: Stats, right: Stats): boolean {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Whether the room's main checkout and every worktree of this room are free
 * of untracked files the block hides — the only condition under which
 * removing it cannot make a tree read dirty. An unreadable tree answers
 * "needs it", the safe direction.
 *
 * @param roomId - The room.
 * @param ceiling - The room home directory git's search may not climb past.
 * @param patterns - The block's lines.
 */
export async function noWorktreeNeedsBlock(
  engineOwner: object,
  roomId: string,
  ceiling: string,
  patterns: readonly string[],
  context: InstallationRoomMutationContext
): Promise<boolean> {
  readOriginalRoomWorktreeRetirementView(engineOwner);
  // `repo/` reads the same `info/exclude`, and a room's main checkout found
  // dirty stops every write to the room (`MAIN_CHECKOUT_DIRTY`) — so anything
  // the block hides there keeps it too.
  try {
    const repoDir = readInstallationRoomMutationRoots(context).repoPath;
    await checkInstallationRoomMutationTarget(context, repoDir);
    if ((await hiddenUntracked(engineOwner, repoDir, ceiling, patterns)).length > 0) return false;
  } catch {
    return false;
  }
  const root = path.join(readInstallationRoomMutationRoots(context).homePath, 'worktrees');
  await checkInstallationRoomMutationTarget(context, root);
  let names: string[];
  try {
    names = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (error) {
    // Unreadable siblings are not evidence that nobody needs the block.
    // Only absence under the still-current original root permits removal.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
    await checkInstallationRoomMutationTarget(context, root);
    return true;
  }
  await checkInstallationRoomMutationTarget(context, root);
  for (const name of names) {
    const dir = path.join(root, name);
    await checkInstallationRoomMutationTarget(context, dir);
    if (!(await isCheckout(engineOwner, dir))) continue;
    try {
      if ((await hiddenUntracked(engineOwner, dir, ceiling, patterns)).length > 0) return false;
    } catch {
      return false;
    }
  }
  await checkInstallationRoomMutationTarget(context, root);
  return true;
}
