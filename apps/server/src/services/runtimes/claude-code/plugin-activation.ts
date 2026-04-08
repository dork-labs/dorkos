/**
 * Plugin runtime activation for the Claude Agent SDK.
 *
 * Builds the `options.plugins` array passed to the Claude Agent SDK
 * `query()` call from the user's currently enabled installed plugins.
 * Each enabled plugin in `<dorkHome>/marketplace/packages/<name>/`
 * becomes a `{ type: 'local', path: '<absolute_path>' }` entry. The SDK
 * auto-loads skills, commands, agents, hooks, and MCP servers from each
 * plugin directory — DorkOS owns the install half, the SDK owns the
 * runtime half. See ADR-0239.
 *
 * Plugins whose install directory no longer exists (uninstalled between
 * install and session start) are silently filtered out with a warning;
 * the session still starts without the missing plugin rather than
 * failing outright.
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
 * exists under `<dorkHome>/marketplace/packages/<name>/`, and returns an
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
  const packagesDir = path.join(opts.dorkHome, 'marketplace', 'packages');
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
