/**
 * The DorkOS package manifest filename, located inside the `.dork/` directory
 * at the root of every marketplace package.
 */
export const PACKAGE_MANIFEST_FILENAME = 'manifest.json';

/**
 * The DorkOS package manifest path relative to the package root.
 */
export const PACKAGE_MANIFEST_PATH = '.dork/manifest.json';

/**
 * The Claude Code plugin manifest path. Required for all packages of type
 * `plugin`, `skill-pack`, and `adapter`. Optional for `agent` packages.
 */
export const CLAUDE_PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/**
 * The agent identity manifest path, relative to a package root. A `type: 'agent'`
 * package normally has this scaffolded by the installer, but a package could ship
 * its own — which is exactly the vector the packaged-MCP-servers guard closes
 * (a shipped `agent.json` declaring `mcpServers` would auto-inject a command).
 */
export const AGENT_MANIFEST_PATH = '.dork/agent.json';

/**
 * The marketplace registry filename.
 */
export const MARKETPLACE_JSON_FILENAME = 'marketplace.json';

/**
 * The DorkOS package manifest schema version this code understands.
 * Increment when introducing breaking changes to the schema.
 */
export const PACKAGE_MANIFEST_VERSION = 1;

/**
 * The installed-files record an install writes into the package root: every
 * file the install put there, with its content hash. DorkOS removes or
 * replaces only files this record proves are the package's (ADR 260923-163513).
 * Written and owned by the installer; a package may never ship it.
 */
export const INSTALLED_FILES_PATH = '.dork/installed-files.json';

/**
 * The install provenance sidecar the installer writes after an install. Kept
 * here as a POSIX path for the reserved-path check; the server spells its own
 * copy with `path.join`. A package may never ship it.
 */
export const INSTALL_METADATA_POSIX_PATH = '.dork/install-metadata.json';

/**
 * Where an uninstalled agent package's `agent.json` is parked, so a reinstall
 * of the same package can keep the agent's identity (ADR 260923-163516).
 * Installer-owned; never scanned by mesh; a package may never ship it.
 */
export const UNINSTALLED_AGENT_PATH = '.dork/uninstalled-agent.json';

/**
 * A package's own data directory, the path `${CLAUDE_PLUGIN_DATA}` resolves to
 * (ADR 260923-163515). Always the person's: a package may never ship into it.
 */
export const PACKAGE_DATA_DIR = '.dork/data';

/** The per-package secrets file. Always the person's; a package may never ship it. */
export const PACKAGE_SECRETS_PATH = '.dork/secrets.json';

/**
 * The default locations a package's install preview reads what the package
 * runs from: hooks, MCP and language servers, monitors, commands on the PATH,
 * extensions, scheduled tasks, skills and commands (their frontmatter hooks and
 * allowed tools), and npm dependencies. A person approves the NEW version's copy
 * of each on update, so a `userEditable` entry may never reach one: an edited
 * copy would survive and run unapproved (DOR-2245, DOR-2195). The server's
 * preview readers take their defaults from here, so the two lists cannot
 * drift. Folders are listed whole; plugin.json can declare other locations,
 * which `validatePackage` checks against `userEditable` too.
 */
export const EFFECT_BEARING_PATHS = {
  hooks: 'hooks',
  hooksFile: 'hooks/hooks.json',
  mcpServersFile: '.mcp.json',
  lspServersFile: '.lsp.json',
  monitors: 'monitors',
  monitorsFile: 'monitors/monitors.json',
  executables: 'bin',
  extensions: '.dork/extensions',
  tasks: '.dork/tasks',
  skills: 'skills',
  rootSkill: 'SKILL.md',
  commands: 'commands',
  npmManifest: 'package.json',
} as const;

/**
 * Suffixes of the copies an update saves beside a file: `.dork-old` for the
 * person's edited copy, `.dork-new` for a package's changed default. Either may
 * be followed by `.<n>` when the plain name is taken. A package may never ship one.
 */
export const KEPT_COPY_SUFFIXES = ['.dork-old', '.dork-new'] as const;

/**
 * An agent package's identity files. They are the agent's, never the package's:
 * never recorded as package files, and a shipped copy only seeds an install
 * where the file is absent (ADR 260923-163516).
 */
export const AGENT_IDENTITY_FILES = [
  AGENT_MANIFEST_PATH,
  '.dork/SOUL.md',
  '.dork/NOPE.md',
  '.dork/MEMORY.md',
] as const;
