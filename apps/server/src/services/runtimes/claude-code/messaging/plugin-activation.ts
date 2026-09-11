/**
 * Global plugin runtime activation for the Claude Agent SDK.
 *
 * Builds the `options.plugins` array passed to the Claude Agent SDK `query()`
 * call from the user's GLOBALLY installed plugins. Each enabled plugin in
 * `<dorkHome>/plugins/<name>/` becomes a `{ type: 'local', path }` entry the SDK
 * auto-loads (skills, commands, agents, hooks, MCP servers).
 *
 * Scope note (ADR 260706-192819, amending ADR-0239): SDK injection is now
 * reserved for DorkOS-specific runtime concerns and this transitional GLOBAL
 * plugin path. PROJECT-scoped installs (`<cwd>/.dork/plugins/`) are no longer
 * injected here: they reach every harness (including Claude Code) as
 * harness-native projected files via `@dorkos/harness`, so the external `claude`
 * CLI and DorkOS sessions see the same thing. Global-scope projection is deferred
 * (DOR-174), so global installs keep SDK injection for now.
 *
 * Plugins whose install directory no longer exists (uninstalled between install
 * and session start) are silently filtered out with a warning; the session still
 * starts without the missing plugin rather than failing outright.
 *
 * This module lives inside the ESLint boundary that permits
 * `@anthropic-ai/claude-agent-sdk` imports (`services/runtimes/claude-code/`).
 *
 * @module services/runtimes/claude-code/plugin-activation
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';

/**
 * Shape of a Claude Agent SDK `options.plugins` entry. Matches the SDK's
 * `{ type: 'local', path }` discriminated union variant; remote plugins
 * are intentionally not used by DorkOS because we own the install.
 *
 * **This is a hand-mirror of `SdkPluginConfig`, and the two now differ.** At
 * 0.3.268 the SDK's version carries an optional third field,
 * `skipMcpDiscovery?: boolean` — "load this plugin's skills, hooks, agents and
 * commands, but do not read its `.mcp.json`". Every value built here is still
 * assignable to `options.plugins`, so nothing breaks; this is the first time the
 * shapes have diverged at all, which is exactly what a hand-mirror's note exists
 * to catch. It is deliberately NOT mirrored yet: the field draws the same line
 * ADR-0239 does, between the install half DorkOS owns and the runtime half the
 * SDK owns, and choosing a side of it is a decision about DorkOS's MCP surface
 * rather than a field to copy across on a version bump.
 */
export interface ClaudeAgentSdkPlugin {
  type: 'local';
  path: string;
}

/**
 * Options for {@link buildClaudeAgentSdkPluginsArray}.
 */
export interface BuildActivationOptions {
  /** Absolute path to the DorkOS data directory (never `os.homedir()`-derived). */
  dorkHome: string;
  /** Names of plugins the user has enabled. */
  enabledPluginNames: string[];
  /** Logger for warnings about missing directories. */
  logger: Logger;
}

/**
 * Build the `options.plugins` array for a Claude Agent SDK `query()` call.
 *
 * Iterates over `enabledPluginNames`, verifies each plugin directory still
 * exists under `<dorkHome>/plugins/<name>/`, and returns an
 * array of `{ type: 'local', path }` entries. Missing directories are
 * filtered out with a warning so a single uninstalled plugin never blocks
 * a session from starting.
 *
 * @param opts - Activation options (dork home, enabled names, logger).
 * @returns An array of SDK-compatible plugin entries (possibly empty).
 */
export async function buildClaudeAgentSdkPluginsArray(
  opts: BuildActivationOptions
): Promise<ClaudeAgentSdkPlugin[]> {
  const packagesDir = path.join(opts.dorkHome, 'plugins');
  const active: ClaudeAgentSdkPlugin[] = [];

  for (const name of opts.enabledPluginNames) {
    const pluginPath = path.join(packagesDir, name);
    try {
      await access(pluginPath);
      active.push({ type: 'local', path: pluginPath });
    } catch {
      opts.logger.warn('plugin-activation: enabled plugin directory missing', {
        packageName: name,
        expectedPath: pluginPath,
      });
    }
  }

  return active;
}
