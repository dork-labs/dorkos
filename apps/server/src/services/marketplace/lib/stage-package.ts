/**
 * Symlink-safe package staging copy.
 *
 * Every marketplace install flow stages the incoming package into an isolated
 * temp directory before activating it onto the install root. A malicious
 * package can ship a symlink whose target escapes the package — `data ->
 * /etc/passwd` (absolute) or `data -> ../../other-project` (relative). A plain
 * recursive `cp` copies those links verbatim, and when Harness Sync later walks
 * the activated tree it follows the link and reads or writes outside the install
 * root (DOR-279).
 *
 * {@link stagePackageContents} closes that hole by stripping every symlink as it
 * copies: regular files and directories are copied recursively, and any symlink
 * (of any kind, escaping or internal) is skipped and logged. Marketplace
 * packages are portable content trees — skills, commands, extensions, JSON
 * manifests — that never legitimately ship symlinks, so stripping is the safest
 * containment: it removes the escape vector unconditionally rather than trying to
 * reason about whether a given link target stays within bounds after the staged
 * tree is renamed onto a different install root.
 *
 * @module services/marketplace/lib/stage-package
 */
import { cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';

/**
 * Recursively copy a package's contents from `source` into `dest`, stripping
 * every symlink so no followable escape survives into the staged (and later
 * activated) tree.
 *
 * Uses Node's `fs.cp` with a `filter` that rejects any entry whose `lstat`
 * reports a symbolic link; rejecting a symlinked directory skips its whole
 * subtree. Each skipped link is logged at `warn` so a package shipping symlinks
 * is visible in install diagnostics. The copy is otherwise identical to
 * `cp(source, dest, { recursive: true })`.
 *
 * @param source - Absolute path to the validated package source directory.
 * @param dest - Absolute path to the staging directory to populate.
 * @param logger - Logger used to warn about each stripped symlink.
 */
export async function stagePackageContents(
  source: string,
  dest: string,
  logger: Logger
): Promise<void> {
  await cp(source, dest, {
    recursive: true,
    filter: async (src): Promise<boolean> => {
      const stats = await lstat(src);
      if (stats.isSymbolicLink()) {
        logger.warn(
          `[marketplace/stage] Stripped symlink from package: ${path.relative(source, src) || src}`
        );
        return false;
      }
      return true;
    },
  });
}
