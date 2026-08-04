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
