/**
 * Git settings that stop a repository's own configuration from running a
 * program (DOR-2326).
 *
 * A folder can be shaped like a git repository without anyone meaning it to
 * be one: a package can ship `HEAD`, `objects/`, `refs/` and a `config` at its
 * root, and `git status` run there then reads that `config` as the
 * repository's own. Settings such as `core.fsmonitor` name a program git
 * runs, so reading a folder became running code.
 *
 * Git reads settings passed on its command line (`-c`) or in its environment
 * (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, git
 * 2.31+) ahead of a repository's own, so these override whatever the folder
 * says:
 *
 * - `safe.bareRepository=explicit`: git will not treat a folder it merely
 *   finds (by walking up from where it runs) as a bare repository. The folder
 *   above is exactly such a repository.
 * - `core.fsmonitor=` (empty): no file-system monitor program. Git on a
 *   large repository whose owner set one up checks for changes the slow way
 *   instead; correctness is the same.
 * - `core.hooksPath` pointed at nothing: no hook program. Only for git that
 *   DorkOS runs itself ({@link internalGitConfig}); agent sessions keep a
 *   person's own hooks ({@link SESSION_GIT_CONFIG} says why).
 *
 * Programs a repository can name that the last two do not cover (filters,
 * diff and merge drivers, credential helpers, `core.sshCommand`) are what
 * `safe.bareRepository` is for: git never reads a folder it only stumbled on.
 * That setting needs git 2.38, and the environment form git 2.31, so on older
 * git the backstop is the marketplace's own check, which refuses any package
 * shaped like a git repository. {@link gitProtectionLevel} says how much a
 * given git honours, and {@link gitProtectionCheck} turns that into the
 * startup warning, the deep health line and `dorkos doctor`'s line.
 *
 * @module shared/git-hardening
 */

import type { CheckResult } from './health-schemas.js';

/** One `git -c key=value` setting. */
export interface GitConfigEntry {
  /** The setting's name, such as `core.fsmonitor`. */
  key: string;
  /** Its value. */
  value: string;
}

/**
 * Settings every agent session's git gets (Claude Code, Codex, OpenCode).
 *
 * Hooks are deliberately left alone here. An agent commits and checks out in
 * a person's own repositories, where their hooks (formatters, linters,
 * pre-commit checks) are part of how they work, and turning them off would
 * silently skip those checks for everything an agent does. Hooks run on
 * commit, checkout and merge rather than on reading a folder, and a package
 * cannot plant one: an agent that ships a `.git` is refused.
 */
export const SESSION_GIT_CONFIG: readonly GitConfigEntry[] = [
  { key: 'safe.bareRepository', value: 'explicit' },
  // Empty, not `false`: before 2.36 this setting is a program's path, and
  // `false` would run the program named `false`. Empty means none on every git.
  { key: 'core.fsmonitor', value: '' },
];

/**
 * Settings for git that DorkOS runs itself, against folders it did not
 * create: everything in {@link SESSION_GIT_CONFIG}, and no hooks. DorkOS never
 * needs a repository's hooks to read status, list files or fetch a package.
 *
 * @param platform - Where git runs; Windows has no `/dev/null`, and git there
 *   reads `NUL` as the empty device.
 * @returns The settings, in order.
 */
export function internalGitConfig(platform: NodeJS.Platform = process.platform): GitConfigEntry[] {
  return [
    ...SESSION_GIT_CONFIG,
    { key: 'core.hooksPath', value: platform === 'win32' ? 'NUL' : '/dev/null' },
  ];
}

/**
 * The settings as `-c key=value` arguments, to put before git's subcommand.
 * Works on every git version.
 *
 * @param entries - The settings.
 * @returns The arguments.
 */
export function gitConfigArgs(entries: readonly GitConfigEntry[]): string[] {
  return entries.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);
}

/**
 * `env` with `entries` appended to git's environment settings
 * (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`), after
 * any the environment already carries, which keep their places. Read by git
 * 2.31 and later; the only way to reach git that DorkOS does not start itself,
 * such as an agent session's.
 *
 * @param env - The environment to extend; not changed.
 * @param entries - The settings to add.
 * @returns A new environment.
 */
export function withGitConfigEnv<T extends Record<string, string | undefined>>(
  env: T,
  entries: readonly GitConfigEntry[]
): T & Record<string, string> {
  const next: Record<string, string | undefined> = { ...env };
  if (entries.length === 0) return next as T & Record<string, string>;
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const start = Number.isNaN(existing) || existing < 0 ? 0 : existing;
  next.GIT_CONFIG_COUNT = String(start + entries.length);
  entries.forEach(({ key, value }, i) => {
    next[`GIT_CONFIG_KEY_${start + i}`] = key;
    next[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return next as T & Record<string, string>;
}

/** A git version as `[major, minor]`. */
export type GitVersion = readonly [major: number, minor: number];

/** The first git that reads settings from its environment (`GIT_CONFIG_COUNT`). */
export const GIT_ENV_CONFIG_MIN_VERSION: GitVersion = [2, 31];

/** The first git that knows `safe.bareRepository`. */
export const GIT_SAFE_BARE_REPOSITORY_MIN_VERSION: GitVersion = [2, 38];

/**
 * Parse `git --version` output into `[major, minor]`, tolerating the suffixes
 * vendors add: `git version 2.39.5 (Apple Git-154)`,
 * `git version 2.43.0.windows.1`.
 *
 * @param stdout - What `git --version` printed.
 * @returns The version, or `undefined` when there is none in it.
 */
export function parseGitVersion(stdout: string): [number, number] | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(stdout);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** Whether `version` is `min` or later. */
function atLeast(version: GitVersion, min: GitVersion): boolean {
  return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}

/**
 * How much of this protection a git honours.
 *
 * - `full` (2.38+): everything above, for DorkOS's own git and agent sessions.
 * - `partial` (2.31–2.37): no file-system monitor or hook program runs, but
 *   git still reads a git-shaped folder it stumbles on, so other programs that
 *   folder's settings name can run.
 * - `none` (before 2.31): agent sessions get none of it, because their
 *   settings travel in the environment. DorkOS's own git passes them on its
 *   command line and is `partial`.
 *
 * @param version - The installed git's version.
 * @returns The level agent sessions get.
 */
export function gitProtectionLevel(version: GitVersion): 'full' | 'partial' | 'none' {
  if (atLeast(version, GIT_SAFE_BARE_REPOSITORY_MIN_VERSION)) return 'full';
  if (atLeast(version, GIT_ENV_CONFIG_MIN_VERSION)) return 'partial';
  return 'none';
}

/**
 * The `dorkos doctor` and health line for the installed git: whether it gives
 * DorkOS's own git and every agent session's git all of this protection.
 *
 * @param versionOutput - What `git --version` printed, or `undefined` when git
 *   could not be run.
 * @returns `pass` on git 2.38 or later, `warn` below it, `info` when git is
 *   missing or its version unreadable.
 */
export function gitProtectionCheck(versionOutput: string | undefined): CheckResult {
  if (versionOutput === undefined) {
    return {
      label: 'Git is not installed',
      status: 'info',
      detail: 'Agents that use git need it. There is nothing to protect until it is installed.',
    };
  }
  const version = parseGitVersion(versionOutput);
  if (!version) {
    return { label: "Could not read git's version", status: 'info', detail: versionOutput.trim() };
  }
  const found = `git ${version[0]}.${version[1]}`;
  const [min0, min1] = GIT_SAFE_BARE_REPOSITORY_MIN_VERSION;
  const fix = `Update git to ${min0}.${min1} or later, then restart DorkOS.`;
  switch (gitProtectionLevel(version)) {
    case 'full':
      return { label: `${found} protects your agents' git`, status: 'pass' };
    case 'partial':
      return {
        label: `${found} only partly protects your agents' git`,
        status: 'warn',
        detail:
          'A folder set up to look like a git repository can still make git run some ' +
          'programs when an agent looks inside it.',
        fix,
      };
    case 'none':
      return {
        label: `${found} is too old to protect your agents' git`,
        status: 'warn',
        detail:
          'A folder set up to look like a git repository can make git run a program when ' +
          'an agent looks inside it.',
        fix,
      };
  }
}
