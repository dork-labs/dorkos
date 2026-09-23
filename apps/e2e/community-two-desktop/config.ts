import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything the two-Desktop Community acceptance run reads from its
 * environment, resolved once and validated before anything is built, launched
 * or created.
 *
 * The run builds and launches two packaged apps, starts two Community servers
 * and creates Postgres databases in Docker, so it refuses to do any of that
 * unless the person asked for it by name: {@link OPT_IN_VARIABLE} must be `1`.
 * Nothing in `pnpm test`, `pnpm verify` or CI sets it.
 *
 * @module community-two-desktop/config
 */

/** The variable that must be exactly `1` before the run does anything. */
export const OPT_IN_VARIABLE = 'DORKOS_TWO_DESKTOP_ACCEPTANCE';

/** The repository root, derived from this file's own location. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The resolved settings for one run. */
export interface RunConfig {
  /** The packaged DorkOS executable both people launch. */
  executablePath: string;
  /** Build the packaged app and the Community server before running. */
  build: boolean;
  /** Borrow this existing Postgres container instead of creating a throwaway one. */
  postgresContainer: string | null;
  /** Where each run's evidence folder is written. */
  outputRoot: string;
  /** Where each person's temporary home directory is created. */
  homeRoot: string;
  /** Keep the temporary homes after the run, for diagnosis. */
  keepHomes: boolean;
  /** The Playwright browser channel for the people's browsers (`''` = bundled Chromium). */
  browserChannel: string;
}

/**
 * Refuse unless the run was asked for explicitly.
 *
 * @param env - The environment to read.
 * @throws When the opt-in variable is anything but `1`.
 */
export function assertOptedIn(env: NodeJS.ProcessEnv): void {
  if (env[OPT_IN_VARIABLE] !== '1')
    throw new Error(
      `Refusing to run: this builds and launches two packaged DorkOS apps and uses Docker. ` +
        `Set ${OPT_IN_VARIABLE}=1 to run it on purpose.`
    );
}

/**
 * Resolve the run's settings from its environment and arguments.
 *
 * @param env - The environment to read.
 * @param argv - Command-line arguments after the script name.
 * @param platform - The host platform and architecture, injectable for tests.
 * @throws When the run was not opted into, or no packaged app can exist here.
 */
export function readRunConfig(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  platform: { os: NodeJS.Platform; arch: string } = { os: process.platform, arch: process.arch }
): RunConfig {
  assertOptedIn(env);
  const customApp = env.DORKOS_TWO_DESKTOP_APP?.trim();
  if (!customApp && (platform.os !== 'darwin' || platform.arch !== 'arm64'))
    throw new Error(
      'The default packaged app is the macOS Apple Silicon build. On another machine, ' +
        'set DORKOS_TWO_DESKTOP_APP to a packaged DorkOS executable.'
    );
  return {
    executablePath: path.resolve(
      customApp ||
        path.join(REPO_ROOT, 'apps/desktop/release/mac-arm64/DorkOS.app/Contents/MacOS/DorkOS')
    ),
    build: argv.includes('--build') || env.DORKOS_TWO_DESKTOP_BUILD === '1',
    postgresContainer: env.DORKOS_TWO_DESKTOP_PG_CONTAINER?.trim() || null,
    outputRoot: path.resolve(
      env.DORKOS_TWO_DESKTOP_OUT?.trim() || path.join(REPO_ROOT, '.temp/community-two-desktop')
    ),
    // Homes live outside the repository on purpose: an ancestor package.json
    // with "type": "module" changes how the packaged server loads extension code.
    homeRoot: path.resolve(env.DORKOS_TWO_DESKTOP_HOME_ROOT?.trim() || os.tmpdir()),
    keepHomes: env.DORKOS_TWO_DESKTOP_KEEP_HOMES === '1',
    browserChannel: env.DORKOS_TWO_DESKTOP_BROWSER_CHANNEL ?? 'chrome',
  };
}
