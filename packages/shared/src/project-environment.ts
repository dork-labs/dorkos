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

/** What the CLI hands the server about the project `.env`. Values only for the allowed settings. */
export interface ProjectHandoff {
  /** The allowed settings the file gave, frozen. */
  readonly settings: ProjectSettings;
  /**
   * When the file named `BETTER_AUTH_SECRET` and the real environment did not
   * (before this release DorkOS signed sign-ins with that value): the value's
   * SHA-256, hex, so the server can tell a stored secret that equals it
   * without ever holding the value. Absent otherwise.
   */
  readonly authSecretDigest?: string;
}

/** Where the CLI leaves the hand-off for the server it imports into the same process. */
const HANDOFF = Symbol.for('dorkos.project-settings');

type HandoffHolder = { [HANDOFF]?: ProjectHandoff };

/**
 * Leave the project `.env` hand-off for the server, in memory. Never through
 * `process.env`.
 *
 * @param handoff - The allowed settings, and the session secret's digest when the file gave the one in use.
 */
export function handProjectSettings(handoff: ProjectHandoff): void {
  (globalThis as HandoffHolder)[HANDOFF] = Object.freeze({
    settings: Object.freeze({ ...handoff.settings }),
    ...(handoff.authSecretDigest ? { authSecretDigest: handoff.authSecretDigest } : {}),
  });
}

/**
 * Read the hand-off {@link handProjectSettings} left. It holds no secret (two
 * settings and at most a digest), so it stays put: the CLI's bundle and the
 * server's may each carry a copy of this module, and one reading it must not
 * hide it from the other. `undefined` while none has been left (yet), and
 * always when the CLI did not start the server (the desktop app, `pnpm dev`).
 *
 * @returns The frozen hand-off, or `undefined`.
 */
export function readProjectSettings(): ProjectHandoff | undefined {
  return (globalThis as HandoffHolder)[HANDOFF];
}
