/**
 * "Move out of {agent}'s folder" (DOR-3234, Must 3): a person moves a mini
 * app an agent can rewrite into DorkOS's own `extensions` folder, so
 * "Confirm it's you" can be on again.
 *
 * Copy, verify, then remove:
 *
 * - **No links.** A folder holding any symbolic link is refused, so the move
 *   never follows one out of the folder or brings one along.
 * - **Verified.** Every file's bytes are hashed in both places; any difference
 *   undoes the copy and leaves the original where it was.
 * - **Never re-trusted.** The moved copy is a new copy at a new path. The load
 *   policy compares it with its approval record on the next scan, and an
 *   approval that held only by its old path or its author's folder no longer
 *   covers it, so it waits for a person's yes.
 *
 * @module services/extensions/move-extension-out
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Why a move did not happen, in the person's words. */
export class MoveExtensionError extends Error {
  constructor(
    message: string,
    /** `not-movable`, `has-link`, `exists` or `changed-while-moving`. */
    readonly code: 'not-movable' | 'has-link' | 'exists' | 'changed-while-moving'
  ) {
    super(message);
    this.name = 'MoveExtensionError';
  }
}

/** Every file under `root`, relative, sorted; refuses any symbolic link. */
async function filesOf(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new MoveExtensionError(
          'This mini app’s folder holds a link, so it can’t be moved safely.',
          'has-link'
        );
      }
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full));
    }
  };
  await walk(root);
  return files.sort();
}

/** One digest over every file's name and bytes, in order. */
async function treeDigest(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    hash
      .update(file)
      .update('\0')
      .update(await fs.readFile(path.join(root, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

/**
 * Move one extension's folder into `{dorkHome}/extensions/{id}`.
 *
 * @param source - The folder it runs from now. Must not itself be a link.
 * @param id - The extension's id, already checked against the safe-id pattern.
 * @param dorkHome - DorkOS's data folder.
 * @returns Where it now lives.
 */
export async function moveExtensionOut(
  source: string,
  id: string,
  dorkHome: string
): Promise<string> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MoveExtensionError('This mini app can’t be moved from where it is.', 'not-movable');
  }
  const extensionsDir = path.join(dorkHome, 'extensions');
  const target = path.join(extensionsDir, id);
  const staging = path.join(extensionsDir, `.${id}.moving-${process.pid}-${Date.now()}`);
  await fs.mkdir(extensionsDir, { recursive: true });
  if (await exists(target)) {
    throw new MoveExtensionError(
      'A mini app with this name is already in DorkOS’s own folder.',
      'exists'
    );
  }
  const files = await filesOf(source);
  const before = await treeDigest(source, files);
  try {
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await fs.copyFile(path.join(source, file), path.join(staging, file));
    }
    const copied = await filesOf(staging);
    const after = await treeDigest(staging, copied);
    // The files must be the same in both places, and the original must not
    // have changed while it was copied.
    if (
      after !== before ||
      copied.join('\n') !== files.join('\n') ||
      (await treeDigest(source, await filesOf(source))) !== before
    ) {
      throw new MoveExtensionError(
        'This mini app changed while it was being moved. Nothing moved.',
        'changed-while-moving'
      );
    }
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  await fs.rm(source, { recursive: true, force: true });
  return target;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}
