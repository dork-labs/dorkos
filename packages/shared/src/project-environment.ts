/**
 * The names DorkOS reads from its environment, and the one way the project
 * `.env` file's two allowed settings reach the server.
 *
 * The project `.env` file can't change how DorkOS or its agents run. The CLI
 * reads it, keeps only {@link PROJECT_ENV_ALLOWED}, and never writes a project
 * value into `process.env`: `process.env` stays the environment DorkOS started
 * in. The server takes the allowed settings once, from memory, through
 * {@link handProjectSettings} and {@link takeProjectSettings}.
 *
 * The name lists below are the one copy: the CLI's loader, the census in
 * `packages/cli/src/lib/__tests__/project-env-census.test.ts` and the
 * `project-work` child environment (`./child-environment.ts`) all read them.
 *
 * @module project-environment
 */

/** The settings DorkOS reads that a project `.env` may still set. Reviewed one by one. */
export const PROJECT_ENV_ALLOWED = ['LOG_LEVEL', 'DO_NOT_TRACK'] as const;

/** One of the {@link PROJECT_ENV_ALLOWED} names. */
export type ProjectSettingName = (typeof PROJECT_ENV_ALLOWED)[number];

/**
 * Prefixes that are DorkOS's own, whether a name exists yet or not: every
 * `DORKOS_*` and `DORK_*` name, and the tunnel's and Nango's families.
 */
const DORKOS_OWNED_PREFIX = /^(DORK(OS)?|TUNNEL|NANGO)_/;

/**
 * The names without a DorkOS prefix that are DorkOS's own: its tokens, keys and
 * switches. A child that runs project work never sees them. The server's schema
 * (`apps/server/src/env.ts`) and its direct reads name them; the census fails
 * a new one until it is listed here or in {@link SYSTEM_NAMES_DORKOS_READS}.
 */
export const DORKOS_OWNED_UNPREFIXED: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'NODE_ENV',
  'CLIENT_DIST_PATH',
  'MCP_API_KEY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_SDK_DISABLED',
  'NGROK_AUTHTOKEN',
  'BETTER_AUTH_SECRET',
  'COMMUNITY_DATABASE_URL',
  'VITE_PORT',
]);

/**
 * Names DorkOS reads that belong to the computer and the person, not to
 * DorkOS: where home and the config folders are, the shell, Node's own
 * settings. A project `.env` can't set them for DorkOS, but a child keeps the
 * real values, because a terminal or a hook without them does not work.
 */
export const SYSTEM_NAMES_DORKOS_READS: ReadonlySet<string> = new Set([
  'HOME',
  'PATH',
  'SHELL',
  'TERM',
  'EDITOR',
  'NO_COLOR',
  'COMSPEC',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_DOWNLOAD_DIR',
  'FLY_CONFIG_DIR',
  'GH_CONFIG_DIR',
  'NODE_OPTIONS',
  'NODE_PATH',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'OPENCODE_DB',
  'RIPGREP_CONFIG_PATH',
]);

/**
 * Whether a name is DorkOS's own: a prefixed name or one in
 * {@link DORKOS_OWNED_UNPREFIXED}. Compared upper-case, since Windows names
 * ignore case.
 *
 * @param name - The variable's name.
 */
export function isDorkosOwnedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return DORKOS_OWNED_PREFIX.test(upper) || DORKOS_OWNED_UNPREFIXED.has(upper);
}

/**
 * Whether a project `.env` may set this name for DorkOS: only the
 * {@link PROJECT_ENV_ALLOWED} settings. Nothing else in the file is used.
 *
 * @param name - The variable's name.
 */
export function isProjectSettingName(name: string): name is ProjectSettingName {
  return (PROJECT_ENV_ALLOWED as readonly string[]).includes(name);
}

/** The settings the project `.env` gave, frozen. */
export type ProjectSettings = Readonly<Partial<Record<ProjectSettingName, string>>>;

/** Where the CLI leaves the settings for the server it imports into the same process. */
const HANDOFF = Symbol.for('dorkos.project-settings');

type HandoffHolder = { [HANDOFF]?: ProjectSettings };

/**
 * Leave the project `.env` settings for the server, in memory, before the CLI
 * imports it. Never through `process.env`.
 *
 * @param settings - The allowed settings the file gave.
 */
export function handProjectSettings(settings: ProjectSettings): void {
  (globalThis as HandoffHolder)[HANDOFF] = Object.freeze({ ...settings });
}

/**
 * Take the settings {@link handProjectSettings} left, once: the hand-off is
 * cleared, so nothing else in the process can read it later. Empty when the
 * server was not started by the CLI (the desktop app, `pnpm dev`).
 *
 * @returns The frozen settings.
 */
export function takeProjectSettings(): ProjectSettings {
  const holder = globalThis as HandoffHolder;
  const settings = holder[HANDOFF] ?? Object.freeze({});
  delete holder[HANDOFF];
  return settings;
}
