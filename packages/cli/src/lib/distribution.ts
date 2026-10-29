/**
 * Which kind of DorkOS the CLI is, told to the server it starts as
 * `DORKOS_DISTRIBUTION` (read by the server's `apps/server/src/lib/distribution/`).
 *
 * Decided from where this CLI's own entry file lives, which is a fact of the
 * install, not a guess: Homebrew installs under a `Cellar/` folder, a package
 * manager installs under `node_modules/`, and a repo checkout runs
 * `packages/cli/dist/`. Anything else is `unknown`.
 *
 * The one inherited value kept is `docker`: the image sets it, then starts the
 * CLI. Every other inherited value is dropped, because an agent's shell
 * inherits its server's environment, and a CLI started there is its own install.
 *
 * @module lib/distribution
 */

/** What the CLI tells the server it is. */
export type CliDistribution = 'docker' | 'homebrew' | 'npm' | 'dev' | 'unknown';

/**
 * Decide the CLI's distribution.
 *
 * @param entryPath - Absolute path of the running CLI entry file.
 * @param inherited - `DORKOS_DISTRIBUTION` as this process received it.
 * @returns The value to hand the server.
 */
export function cliDistribution(entryPath: string, inherited: string | undefined): CliDistribution {
  if (inherited?.trim().toLowerCase() === 'docker') return 'docker';
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.includes('/Cellar/')) return 'homebrew';
  if (normalized.includes('/node_modules/')) return 'npm';
  if (normalized.includes('/packages/cli/dist/')) return 'dev';
  return 'unknown';
}

/**
 * Tell the server this CLI started it: where its entry file is and which
 * version it is (the agent CLI fallback reads both), and its distribution.
 *
 * @param env - The environment the server will read, normally `process.env`.
 * @param entryPath - Absolute path of the running CLI entry file.
 * @param version - The CLI's own version.
 */
export function stampCliLaunch(env: NodeJS.ProcessEnv, entryPath: string, version: string): void {
  env.DORKOS_CLI_ENTRYPOINT = entryPath;
  env.DORKOS_CLI_VERSION = version;
  env.DORKOS_DISTRIBUTION = cliDistribution(entryPath, env.DORKOS_DISTRIBUTION);
}
