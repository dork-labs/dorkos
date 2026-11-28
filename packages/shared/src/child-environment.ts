/**
 * The environment of every child process DorkOS starts that is not an agent
 * runtime. Agent runtimes take theirs from the server's `childEnvironment` in
 * `services/runtimes/shared/runtime-environment-config.ts`, which adds the
 * runtime kinds; a census test (`apps/server/src/__tests__/child-env-census.test.ts`)
 * fails any spawn that builds its environment another way.
 *
 * Every kind reads the real environment DorkOS started in. The project `.env`
 * file never reaches a child: it can't change how DorkOS or its agents run.
 *
 * | kind | env | used by |
 * | --- | --- | --- |
 * | `project-work` | real env minus every name DorkOS owns | the person's terminal, workspace hooks, the CLI's editor |
 * | `git` | real env minus every name DorkOS owns | git and gh: they need the person's ssh agent, credential helper and proxy |
 * | `browser` | real env minus every name DorkOS owns | Chrome and Playwright: a desktop browser needs the display and locale |
 * | `npm-install` | home, path, npm's cache and config, proxy and CA names | the marketplace's `npm install --ignore-scripts` |
 * | `os-helper` | home, path, locale, temp, and the desktop session | `open`, `xdg-open`, `ps`, `security`, `taskkill`, `ip` |
 * | `self-restart` | the real environment, whole | the server restarting itself: the CLI's own settings ride in it |
 *
 * @module child-environment
 */
import { isDorkosOwnedEnvName } from './project-environment.js';

/** A child kind this module builds. */
export type ProcessChildKind =
  'project-work' | 'git' | 'browser' | 'npm-install' | 'os-helper' | 'self-restart';

/** An environment-like record. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** What {@link childEnvironment} may be told besides the kind. */
export interface ProcessChildOptions {
  /** The real environment. Defaults to `process.env`, which holds no project value. */
  readonly parent?: EnvRecord;
  /** Values the caller sets on purpose, applied last (a terminal's `TERM`, a hook's ports). */
  readonly set?: Readonly<Record<string, string>>;
  /** The platform, for Windows' case-blind names. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** Names `npm install` needs: where home is, where npm keeps its cache and config, how it reaches the registry. */
const NPM_INSTALL_NAMES = [
  'PATH',
  'HOME',
  // Home on Windows, and what npm needs to start there.
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  // npm's cache and config folders.
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_GLOBALCONFIG',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  // Proxy and CA.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_NOPROXY',
  'NPM_CONFIG_CAFILE',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

/** Names a small operating-system helper needs to run and to reach the desktop session. */
const OS_HELPER_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // A helper's times (`ps` start times) must read in the server's own zone.
  'TZ',
  'TMPDIR',
  // Windows.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  // A Linux desktop session, for `xdg-open`.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
] as const;

/** Every kind's names, for the allow-list kinds; `null` means "the real env minus DorkOS's own". */
const ALLOW_LISTS: Readonly<Record<ProcessChildKind, readonly string[] | null | 'whole'>> = {
  'project-work': null,
  git: null,
  browser: null,
  'npm-install': NPM_INSTALL_NAMES,
  'os-helper': OS_HELPER_NAMES,
  'self-restart': 'whole',
};

/**
 * The names an allow-list kind passes, for tests and the census.
 *
 * @param kind - `npm-install` or `os-helper`.
 */
export function childEnvironmentNames(kind: 'npm-install' | 'os-helper'): readonly string[] {
  return kind === 'npm-install' ? NPM_INSTALL_NAMES : OS_HELPER_NAMES;
}

/**
 * Build a child process's environment from the real environment, by kind.
 * Never logs, never mutates its inputs.
 *
 * @param kind - What the child is; the module's table says what each gets.
 * @param options - The parent, values to set, and the platform.
 * @returns A fresh environment for `spawn`, `execFile` or `fork`.
 */
export function childEnvironment(
  kind: ProcessChildKind,
  options: ProcessChildOptions = {}
): Record<string, string> {
  // eslint-disable-next-line no-restricted-syntax -- the one ambient read: process.env holds the real environment only
  const parent = options.parent ?? process.env;
  const windows = (options.platform ?? process.platform) === 'win32';
  const list = ALLOW_LISTS[kind];
  const allowed = Array.isArray(list) ? new Set(list) : null;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (list === null && isDorkosOwnedEnvName(name)) continue;
    // Compared upper-case: npm's lower-case spellings (`npm_config_cache`, `https_proxy`) count too.
    if (allowed && !allowed.has(name.toUpperCase())) continue;
    result[name] = value;
  }
  for (const [name, value] of Object.entries(options.set ?? {})) {
    if (windows)
      for (const key of Object.keys(result))
        if (key.toUpperCase() === name.toUpperCase()) delete result[key];
    result[name] = value;
  }
  return result;
}
