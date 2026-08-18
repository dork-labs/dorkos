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
 * of: `server.cwd` from `config.json` when it is usable, otherwise the
 * boundary root — which is the user's home unless they widened it.
 *
 * @module main/server-cwd
 */

/** Where the server child should start, and how far it may reach. */
export interface ServerWorkingDirectory {
  /** Absolute path the server treats as its default working directory. */
  cwd: string;
  /**
   * `server.boundary` from `config.json`, when someone set one.
   *
   * `undefined` means "no opinion", and is deliberately not filled in with the
   * home directory: the server already defaults the boundary to home, and
   * passing a value would turn its default into an explicit setting that
   * anything downstream would read as a choice a person made.
   */
  boundary: string | undefined;
}

/** Whether `target` is `root` or sits inside it. */
function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
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
 * Reads `config.json` straight off disk (see `user-config.ts` for why), then
 * applies two guards in the order that matters:
 *
 * 1. **The boundary clamp**, exactly as the CLI applies it: a `server.cwd`
 *    outside the effective boundary falls back to the boundary root rather
 *    than being handed to a server that would refuse every request about it.
 * 2. **The directory has to exist.** A stale pin — a project directory renamed
 *    months ago — would otherwise reach `utilityProcess.fork`'s `cwd`, where a
 *    nonexistent path is not a wrong answer but a failed spawn, i.e. an app
 *    that does not start at all.
 *
 * A relative `server.cwd` resolves against the home directory, not
 * `process.cwd()`. The CLI can use the process's own directory because someone
 * typed `dorkos` in it; a Finder-launched app's is `/`, so home is the only
 * anchor that means anything here.
 *
 * @returns The directory to fork the server in, and the configured boundary.
 */
export function resolveServerCwd(): ServerWorkingDirectory {
  const home = app.getPath('home');
  const config = readUserConfig(resolveDataDirectory());

  const configuredBoundary = configString(config?.server?.boundary);
  const boundary = configuredBoundary ? path.resolve(home, configuredBoundary) : undefined;
  const boundaryRoot = boundary ?? home;

  const configuredCwd = configString(config?.server?.cwd);
  if (!configuredCwd) return { cwd: boundaryRoot, boundary };

  const candidate = path.resolve(home, configuredCwd);
  if (!isInside(candidate, boundaryRoot)) {
    log.warn(
      `[server] Ignoring server.cwd "${candidate}" from config.json: it is outside the ` +
        `boundary "${boundaryRoot}", so DorkOS could not open anything there. Starting in ` +
        `${boundaryRoot} instead.`
    );
    return { cwd: boundaryRoot, boundary };
  }
  if (!isExistingDirectory(candidate)) {
    log.warn(
      `[server] Ignoring server.cwd "${candidate}" from config.json: there is no such ` +
        `directory. Starting in ${boundaryRoot} instead.`
    );
    return { cwd: boundaryRoot, boundary };
  }
  return { cwd: candidate, boundary };
}
