import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

/**
 * The directory boundary for a server this harness boots from source.
 *
 * Normally the checkout itself. In a linked git worktree that is too narrow: the
 * server resolves a folder's project to its git MAIN checkout and refuses one
 * outside the boundary (`routes/projects.ts`), so every project lookup answers
 * 403 and anything that needs the current project (hello-world's "Start a
 * chat", `start-work.spec.ts`) stays off. CI runs from a plain checkout and never
 * sees it; agents run the suite from worktrees and did.
 *
 * So in a linked worktree the boundary is the nearest folder holding both the
 * worktree and its main checkout. If that is the filesystem root, the checkout
 * stays the boundary: a root-wide boundary would quietly switch the refusal off.
 *
 * @param repoRoot - The checkout the suite runs from.
 * @param mainCheckout - The main checkout of its repository, or null when unknown.
 */
export function boundaryRootFor(repoRoot: string, mainCheckout: string | null): string {
  const root = resolve(repoRoot);
  if (!mainCheckout) return root;
  const main = resolve(mainCheckout);
  if (isInside(main, root)) return root;
  let common = root;
  while (!isInside(main, common)) {
    const up = dirname(common);
    if (up === common) break;
    common = up;
  }
  return common === parse(common).root ? root : common;
}

/**
 * The main checkout of the repository at `repoRoot`, read from git, or null when
 * git can't say (not a repository, or git missing).
 *
 * @param repoRoot - Any folder inside the checkout.
 */
export function mainCheckoutOf(repoRoot: string): string | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return commonDir ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/** True when `child` is `parent` or sits somewhere under it. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
