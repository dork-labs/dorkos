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
 * - `core.fsmonitor=false`: no file-system monitor program.
 * - `core.hooksPath` pointed at nothing: no hook program. Only for git that
 *   DorkOS runs itself ({@link internalGitConfig}); agent sessions keep a
 *   person's own hooks ({@link SESSION_GIT_CONFIG} says why).
 *
 * Programs a repository can name that these do not cover (filters, diff and
 * merge drivers, credential helpers, `core.sshCommand`) need the repository's
 * own `.git` or `.gitattributes` to be written, which a package cannot do:
 * the marketplace refuses an agent that ships a `.git` or a git-shaped root.
 *
 * @module shared/git-hardening
 */

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
  { key: 'core.fsmonitor', value: 'false' },
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
