import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
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
 * worktree and its main checkout. It never widens to the user's home folder or
 * anything above it: on an agent's machine that is the real home, with its
 * sign-ins, keys and other repos, and a throwaway `DORK_HOME` seals none of it.
 * In that case, and at the filesystem root, the checkout stays the boundary and
 * specs that need a project lookup fail; `widenedOutOfReach` lets the harness
 * say why.
 *
 * @param repoRoot - The checkout the suite runs from.
 * @param mainCheckout - The main checkout of its repository, or null when unknown.
 * @param home - The user's home folder (defaults to `os.homedir()`).
 */
export function boundaryRootFor(
  repoRoot: string,
  mainCheckout: string | null,
  home: string = homedir()
): string {
  const root = resolve(repoRoot);
  const common = commonRootOf(root, mainCheckout);
  if (!common) return root;
  return isInside(resolve(home), common) ? root : common;
}

/**
 * True when the suite runs from a linked worktree whose main checkout sits
 * outside it, but widening to reach that checkout would cover the home folder,
 * so the boundary stayed at the worktree and project lookups will be refused.
 *
 * @param repoRoot - The checkout the suite runs from.
 * @param mainCheckout - The main checkout of its repository, or null when unknown.
 * @param home - The user's home folder (defaults to `os.homedir()`).
 */
export function widenedOutOfReach(
  repoRoot: string,
  mainCheckout: string | null,
  home: string = homedir()
): boolean {
  const root = resolve(repoRoot);
  if (!mainCheckout || isInside(resolve(mainCheckout), root)) return false;
  return boundaryRootFor(root, mainCheckout, home) === root;
}

/**
 * The nearest folder holding both `root` and its main checkout, or null when
 * there is no main checkout outside `root` or the only such folder is the
 * filesystem root.
 */
function commonRootOf(root: string, mainCheckout: string | null): string | null {
  if (!mainCheckout) return null;
  const main = resolve(mainCheckout);
  if (isInside(main, root)) return null;
  let common = root;
  while (!isInside(main, common)) {
    const up = dirname(common);
    if (up === common) break;
    common = up;
  }
  return common === parse(common).root ? null : common;
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
