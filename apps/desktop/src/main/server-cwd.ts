import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { resolveDataDirectory } from './dork-home';
import { configString, readUserConfig } from './user-config';

/**
 * Choosing the directory the desktop app's server works in.
 *
 * The server needs an answer to "where am I?" before anything else can work:
 * `GET /api/directory/default` hands it to the client, the session list asks
 * every runtime about it, and the boundary check refuses anything outside the
 * user's home. Left unanswered, `apps/server/src/lib/resolve-root.ts` falls
 * back to a path derived from its own file location — which inside a packaged
 * app is `…/DorkOS.app/Contents/Resources`. That is outside the boundary, so a
 * Finder-launched app opened on a directory the server then refused, and logged
 * `runtime listing degraded … Access denied: path outside directory boundary`
 * on every boot (DOR-1335). `process.cwd()` is no better: a Finder-launched app
 * inherits `/`.
 *
 * So the shell decides, before it forks the child, and hands the answer down as
 * `DORKOS_DEFAULT_CWD`. The precedence mirrors the CLI's
 * (`packages/cli/src/cli.ts`) minus the flags a windowed app has no equivalent
 * of — **environment variable, then `config.json`, then the boundary root** —
 * and it applies to the working directory and the boundary alike.
 *
 * **Both keys, one rule.** That symmetry is the whole point and it was not free.
 * The child inherits this process's environment wholesale, so an exported
 * `DORKOS_BOUNDARY` reached it whether or not anything here looked at it, while
 * an exported `DORKOS_DEFAULT_CWD` was silently overwritten. Reading only one of
 * the two produced the precise failure this module exists to prevent: launch the
 * app from a shell exporting `DORKOS_BOUNDARY=/tmp/scope` with nothing in
 * `config.json`, and the shell would clamp against home, send
 * `DORKOS_DEFAULT_CWD=$HOME`, and the child would enforce `/tmp/scope` and
 * refuse it — "path outside directory boundary", again. Whatever this module
 * clamps against has to be the same boundary the child enforces.
 *
 * **The clamp resolves symlinks**, because the enforcement does: the server's
 * `initBoundary`/`resolveCanonicalPath` (`apps/server/src/lib/boundary.ts`)
 * compare canonical paths, so a lexical check here would pass a `~/work`
 * symlinked onto an external volume that the server then refuses.
 *
 * @module main/server-cwd
 */

/** Where the server child should start, and how far it may reach. */
export interface ServerWorkingDirectory {
  /** Absolute path the server treats as its default working directory. */
  cwd: string;
  /**
   * The boundary someone set, from `DORKOS_BOUNDARY` or `server.boundary`.
   *
   * `undefined` means "no opinion", and is deliberately not filled in with the
   * home directory: the server already defaults the boundary to home, and
   * passing a value would turn its default into an explicit setting that
   * anything downstream would read as a choice a person made.
   *
   * Returned un-canonicalized, as the person wrote it. The child realpaths it
   * in `initBoundary` and lands on the same place the clamp here used; keeping
   * the string identical is what makes re-exporting an inherited
   * `DORKOS_BOUNDARY` a no-op rather than a silent rewrite.
   */
  boundary: string | undefined;
}

/** Whether `target` is `root` or sits inside it. Both must already be canonical. */
function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * The path with every symlink resolved, or the path itself when it cannot be.
 *
 * Mirrors the server's `resolveCanonicalPath`, which is what makes the clamp
 * agree with the enforcement. Falling back to the input rather than throwing is
 * deliberate: a boundary that does not exist yet is the server's problem to
 * report, and this module must never be the reason the app fails to start.
 */
function canonical(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** Whether `candidate` is a directory that exists right now. */
function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decide where the packaged server should work.
 *
 * Reads the environment and then `config.json` straight off disk (see
 * `user-config.ts` for why), and applies two guards in the order that matters:
 *
 * 1. **The directory has to exist.** A stale pin — a project directory renamed
 *    months ago — would otherwise reach `utilityProcess.fork`'s `cwd`, where a
 *    nonexistent path is not a wrong answer but a failed spawn, i.e. an app
 *    that does not start at all. It is checked first because the clamp below
 *    resolves symlinks, which only a real path can do.
 * 2. **The boundary clamp**, exactly as the CLI applies it: a working directory
 *    outside the effective boundary falls back to the boundary root rather than
 *    being handed to a server that would refuse every request about it.
 *
 * A relative value resolves against the home directory, not `process.cwd()`.
 * The CLI can use the process's own directory because someone typed `dorkos` in
 * it; a Finder-launched app's is `/`, so home is the only anchor that means
 * anything here.
 *
 * @returns The directory to fork the server in, and the boundary someone set.
 */
export function resolveServerCwd(): ServerWorkingDirectory {
  const home = app.getPath('home');
  const config = readUserConfig(resolveDataDirectory());

  // Environment first, for both keys — see the module doc for what reading only
  // one of them did.
  const configuredBoundary =
    configString(process.env.DORKOS_BOUNDARY) ?? configString(config?.server?.boundary);
  const boundary = configuredBoundary ? path.resolve(home, configuredBoundary) : undefined;
  // Canonical, because this is what the candidate below is measured against and
  // what the child's own boundary check will compare with.
  const boundaryRoot = canonical(boundary ?? home);

  const configuredCwd =
    configString(process.env.DORKOS_DEFAULT_CWD) ?? configString(config?.server?.cwd);
  if (!configuredCwd) return { cwd: boundaryRoot, boundary };

  const asked = path.resolve(home, configuredCwd);
  if (!isExistingDirectory(asked)) {
    log.warn(
      `[server] Ignoring the configured working directory "${asked}": there is no such ` +
        `directory. Starting in ${boundaryRoot} instead.`
    );
    return { cwd: boundaryRoot, boundary };
  }
  const candidate = canonical(asked);
  if (!isInside(candidate, boundaryRoot)) {
    log.warn(
      `[server] Ignoring the configured working directory "${asked}"${
        candidate === asked ? '' : ` (really ${candidate})`
      }: it is outside the boundary "${boundaryRoot}", so DorkOS could not open anything ` +
        `there. Starting in ${boundaryRoot} instead.`
    );
    return { cwd: boundaryRoot, boundary };
  }
  return { cwd: candidate, boundary };
}
