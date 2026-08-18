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
 * The same doctrine covers one other file. A package-shipped `.npmrc` is not a
 * preference file: it lands in the directory npm runs in, where `global=true`
 * turns a plain `npm install` into a global install of the package itself with
 * bin shims (a shim named `git` or `claude` runs the package's code the next
 * time anyone types that command), and `registry=`/`cache=` redirect where
 * bytes come from and go. `lib/npm-dependencies.ts` pins `--global=false` on
 * the command line, which a config file cannot override — but the file would
 * still be sitting at the install root afterwards, where the remedy DorkOS
 * prints for a failed dependency install ("run `npm install` in <path>") would
 * walk the person straight into it. So it is stripped here too, before it ever
 * reaches disk. The USER's own `~/.npmrc` is untouched; that is where
 * private-registry auth lives.
 *
 * @module services/marketplace/lib/stage-package
 */
import { cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { PACKAGE_NPMRC } from './npm-dependencies.js';

/**
 * Recursively copy a package's contents from `source` into `dest`, stripping
 * every symlink — and the package's own root `.npmrc` — so no followable escape
 * and no npm-redirecting config survives into the staged (and later activated)
 * tree.
 *
 * Uses Node's `fs.cp` with a `filter` that rejects any entry whose `lstat`
 * reports a symbolic link; rejecting a symlinked directory skips its whole
 * subtree. Each skipped entry is logged at `warn` so a package shipping one is
 * visible in install diagnostics. The copy is otherwise identical to
 * `cp(source, dest, { recursive: true })`.
 *
 * Only the ROOT `.npmrc` is dropped: that is the one npm reads as project
 * config when it runs in this directory. A copy nested inside the package is
 * inert content and is left alone, exactly as any other file would be.
 *
 * @param source - Absolute path to the validated package source directory.
 * @param dest - Absolute path to the staging directory to populate.
 * @param logger - Logger used to warn about each stripped entry.
 */
export async function stagePackageContents(
  source: string,
  dest: string,
  logger: Logger
): Promise<void> {
  const rootNpmrc = path.join(source, PACKAGE_NPMRC);
  await cp(source, dest, {
    recursive: true,
    filter: async (src): Promise<boolean> => {
      if (src === rootNpmrc) {
        logger.warn(
          `[marketplace/stage] Stripped the package's own ${PACKAGE_NPMRC}: it can redirect or escape an npm install, and nothing a package needs at runtime lives in it.`
        );
        return false;
      }
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
