/**
 * The files an agent's own file tools must never read or write, as one list
 * every runtime can read (runtime-parity plan, PR 1, DOR-3594).
 *
 * ## Why one list
 *
 * Secret files (DorkOS's keys and database, sign-ins, `~/.ssh`, `.env`) and
 * the files that grant power (DorkOS's config, installed plugins, other agents'
 * homes) are the same files whatever runtime a turn runs on. Only the way a
 * runtime is told about them differs: Claude Code takes deny rules in its
 * settings, other runtimes take a refusal in their own approval step. So the
 * paths live here, and each runtime keeps a thin adapter that turns them into
 * its own form. Claude Code's is `claude-code/secret-files/secret-read-deny.ts`
 * and `claude-code/messaging/directory-grants.ts`; no other runtime reads this
 * list yet (DOR-3595).
 *
 * ## The shape of an entry
 *
 * Each entry names a path relative to a {@link ProtectedRoot}, whether it is
 * one file or a folder and all under it, and whether reads or writes are
 * refused. A folder's path never ends in `/**`: the adapter adds whatever its
 * runtime needs. A `*` inside a name is a wildcard over that name
 * (`config.json*` is the config and its backups beside it); a runtime whose
 * matcher can't spell that must match more, never less.
 *
 * Changing an entry changes what every runtime holds, so the tests pin the list.
 *
 * @module services/runtimes/shared/policy/protected-paths
 */

/**
 * Where a protected path is measured from:
 *
 * - `data`: DorkOS's data folder (`~/.dork` by default).
 * - `account`: a Claude Code account folder (`CLAUDE_CONFIG_DIR`), the launch's
 *   own and every other one DorkOS knows of.
 * - `home`: the person's home folder.
 * - `anywhere`: at any depth, wherever it sits on the machine.
 * - `agent-folder`: at any depth inside the agent's own folder and the turn's
 *   working folder.
 * - `agent-home`: inside each agent home in the data folder's `agents/`.
 */
export type ProtectedRoot =
  'data' | 'account' | 'home' | 'anywhere' | 'agent-folder' | 'agent-home';

/** One path an agent's file tools are kept off. */
export interface ProtectedPath {
  /** Where {@link ProtectedPath.path} is measured from. */
  readonly root: ProtectedRoot;
  /** The path relative to its root, `/`-separated; `*` matches within a name. */
  readonly path: string;
  /** One file (or every file the name's `*` matches), or a folder and all under it. */
  readonly kind: 'file' | 'folder';
  /**
   * What is refused: `read` keeps a secret from being read (writes to it are a
   * separate entry, if any), `write` keeps a file that grants power from being
   * changed.
   */
  readonly deny: 'read' | 'write';
}

/** Build a group of entries that share a root and what they deny. */
function group(
  root: ProtectedRoot,
  deny: ProtectedPath['deny'],
  entries: readonly (readonly [path: string, kind: ProtectedPath['kind']])[]
): readonly ProtectedPath[] {
  return entries.map(([entryPath, kind]) => ({ root, path: entryPath, kind, deny }));
}

/** DorkOS's own secrets, in its data folder. */
export const DATA_FOLDER_SECRET_PATHS = group('data', 'read', [
  ['host.key', 'file'],
  // The config (cloud and tunnel tokens among it), its backups beside it
  // (`config.json.bak`, `config-<time>.json.bak`), and full database and
  // settings snapshots.
  ['config.json*', 'file'],
  ['config-*.json.bak', 'file'],
  ['backups', 'folder'],
  ['mcp-local-token', 'file'],
  ['better-auth-secret', 'file'],
  // The key the CLI calls this server with.
  ['api-key', 'file'],
  // The database: sign-in sessions and connected-app tokens, with its -wal/-shm,
  // under its current and its old name (`dorkos.db`).
  ['dork*.db*', 'file'],
  // Chat bot tokens, stored as written (`relay/adapter-config.ts`).
  ['relay/adapters.json', 'file'],
  // The web-push private key.
  ['push', 'folder'],
  ['extension-secrets', 'folder'],
  // Secrets moved out of agent folders (DOR-3292).
  ['secrets', 'folder'],
  // The agent browser's signed-in state, and its profiles' cookies.
  ['browser/storage-state.json', 'file'],
  ['browser/profile', 'folder'],
  ['browser-profiles', 'folder'],
  ['local-browser/saved-logins', 'folder'],
]);

/** The sign-in files inside every Claude Code account folder, backups included. */
export const ACCOUNT_FOLDER_SECRET_PATHS = group('account', 'read', [
  ['.credentials*', 'file'],
  ['.claude.json*', 'file'],
  ['backups', 'folder'],
]);

/**
 * Sign-ins named wherever they sit: any Claude account (an odd or added-later
 * folder too), and the Codex and OpenCode sign-ins in their default and moved
 * homes.
 */
export const ANYWHERE_SECRET_PATHS = group('anywhere', 'read', [
  ['.credentials*', 'file'],
  ['.claude.json*', 'file'],
  ['.codex/auth.json', 'file'],
  ['opencode/auth.json', 'file'],
]);

/**
 * The person's own keys and tokens in their home folder: only well-known spots
 * that hold a credential, the default Claude account's sign-in, and the default
 * data folder's secrets, whatever account and data folder a launch uses.
 */
export const HOME_SECRET_PATHS: readonly ProtectedPath[] = [
  ...group('home', 'read', [
    ['.ssh', 'folder'],
    ['.aws', 'folder'],
    ['.config/gh/hosts.yml', 'file'],
    ['.netrc', 'file'],
    ['.npmrc', 'file'],
    ['.docker/config.json', 'file'],
    ['.config/gcloud', 'folder'],
    ['.claude.json*', 'file'],
    ['.claude/.credentials*', 'file'],
    ['.claude/backups', 'folder'],
  ]),
  ...DATA_FOLDER_SECRET_PATHS.map((entry): ProtectedPath => ({
    ...entry,
    root: 'home',
    path: `.dork/${entry.path}`,
  })),
];

/**
 * Files in the agent's own folder whose names say they hold a secret: the
 * secret-files scan's list (`core/secret-file-scan/scan-folder.ts`), at any
 * depth (DOR-3292). Templates stay readable, so `.env.*` is the usual names
 * rather than a wildcard (`.env.example` is not a secret), and an SSH key is
 * named whole so its `.pub` half still reads.
 */
export const AGENT_FOLDER_SECRET_PATHS = group(
  'agent-folder',
  'read',
  [
    '.env',
    '.env.local',
    '.env.*.local',
    '.env.development',
    '.env.dev',
    '.env.production',
    '.env.prod',
    '.env.staging',
    '.env.test',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.jks',
    '*.keystore',
    '*.tfvars',
    '*.tfstate',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    'id_dsa',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.envrc',
    '.dev.vars',
    '.git-credentials',
    '.pgpass',
    'application_default_credentials.json',
    // Not a bare `credentials`: a rule names a folder too, and refused every file
    // under a `credentials/` docs folder on the real CLI (DOR-3510). The scan
    // still flags a bare one.
    '.aws/credentials',
    'credentials.json',
    '*service-account*.json',
    '.docker/config.json',
    '.kube/config',
  ].map((name) => [name, 'file'] as const)
);

/**
 * What in the data folder only a person may change, never an agent's file
 * tools:
 *
 * - `permissions/` holds the permission levels a person set for agents (the
 *   floor `person-set-agent-permissions.json`, DOR-3107). An agent that could
 *   rewrite it could raise its own level.
 * - `session-relay/` holds the pins that say which hub and which keys this
 *   computer trusts (and, with B4, `approval-keys.json`).
 * - `extension-snapshots/` holds the approved files an extension runs from,
 *   and `cache/extensions/` the bundles built from them (DOR-3068). An agent
 *   that could rewrite either could run code nobody approved.
 * - `marketplace/` holds what DorkOS's installer recorded, `project-installs.json`
 *   among it: which plugin came from where (DOR-3068).
 * - `plugins/` holds the plugins installed for every project. A plugin's
 *   commands name the tools they may use and its hooks run code (DOR-3068).
 * - The config (`config.json`, its backups and temp files beside it) and the
 *   timestamped backups hold every extension approval and every other
 *   `operator-only` setting (DOR-3068); `marketplaces.json` holds the package
 *   sources the person trusts.
 */
export const PERSON_ONLY_DATA_PATHS = group('data', 'write', [
  ['permissions', 'folder'],
  ['session-relay', 'folder'],
  ['extension-snapshots', 'folder'],
  ['cache/extensions', 'folder'],
  ['marketplace', 'folder'],
  ['plugins', 'folder'],
  ['config.json*', 'file'],
  ['config-*.json.bak', 'file'],
  ['marketplaces.json*', 'file'],
]);

/**
 * The data folder's files that grant or prove something, kept from writes
 * even before they exist: the config (the approval record among it), the key
 * the secrets are encrypted with, the local tokens, and the package sources.
 */
export const DATA_GRANT_FILE_PATHS = group('data', 'write', [
  ['config.json', 'file'],
  ['host.key', 'file'],
  ['mcp-local-token', 'file'],
  ['better-auth-secret', 'file'],
  ['marketplaces.json', 'file'],
]);

/**
 * The plugins installed into a project, at any depth: `<project>/.dork/plugins/`
 * (DOR-3068). A project's own `.dork/extensions/` is deliberately NOT here:
 * agents build mini apps by editing exactly those files, and the approval asks
 * again when the folder changes.
 */
export const PROJECT_PLUGIN_PATHS = group('anywhere', 'write', [['.dork/plugins', 'folder']]);

/**
 * The files in each agent home that grant power, kept from every agent's file
 * tools so one agent can't raise another's level, forge an approval or edit
 * its hooks (DOR-3068 S1, DOR-3483): the settings, the skills, commands and
 * subagents whose frontmatter widens tools, `.agents/` (where Harness Sync
 * keeps the real skills), `.mcp.json` and `.dork/agent.json`. `CLAUDE.md`
 * stays writable: that is instructions, not code.
 */
export const AGENT_HOME_SELF_GRANT_PATHS = group('agent-home', 'write', [
  ['.claude/settings.json', 'file'],
  ['.claude/settings.local.json', 'file'],
  ['.claude/skills', 'folder'],
  ['.claude/commands', 'folder'],
  ['.claude/agents', 'folder'],
  ['.agents', 'folder'],
  ['.mcp.json', 'file'],
  ['.dork/agent.json', 'file'],
]);

/**
 * The home folder's own copies of what grants power, whatever account and data
 * folder a launch uses: the default Claude account and its `.claude.json`, and
 * the default data folder's {@link DATA_GRANT_FILE_PATHS}.
 */
export const HOME_SELF_GRANT_PATHS: readonly ProtectedPath[] = [
  ...group('home', 'write', [
    ['.claude', 'folder'],
    ['.claude.json', 'file'],
  ]),
  ...DATA_GRANT_FILE_PATHS.map((entry): ProtectedPath => ({
    ...entry,
    root: 'home',
    path: `.dork/${entry.path}`,
  })),
];

/** Every protected path, for a runtime that reads them all. */
export const PROTECTED_PATHS: readonly ProtectedPath[] = [
  ...DATA_FOLDER_SECRET_PATHS,
  ...ACCOUNT_FOLDER_SECRET_PATHS,
  ...ANYWHERE_SECRET_PATHS,
  ...HOME_SECRET_PATHS,
  ...AGENT_FOLDER_SECRET_PATHS,
  ...PERSON_ONLY_DATA_PATHS,
  ...DATA_GRANT_FILE_PATHS,
  ...PROJECT_PLUGIN_PATHS,
  ...AGENT_HOME_SELF_GRANT_PATHS,
  ...HOME_SELF_GRANT_PATHS,
];

/**
 * An entry as a glob relative to its root: the path itself for a file, and
 * the path with `/**` for a folder.
 *
 * @param entry - A protected path.
 */
export function protectedPathGlob(entry: ProtectedPath): string {
  return entry.kind === 'folder' ? `${entry.path}/**` : entry.path;
}
