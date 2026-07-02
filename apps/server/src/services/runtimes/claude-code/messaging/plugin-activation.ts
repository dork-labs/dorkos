/**
 * Plugin runtime activation for the Claude Agent SDK.
 *
 * Builds the `options.plugins` array passed to the Claude Agent SDK
 * `query()` call from the user's currently enabled installed plugins.
 * Each enabled plugin in `<dorkHome>/plugins/<name>/`
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

import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace/constants';
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

/**
 * Options for {@link buildPluginsForCwd}.
 */
export interface BuildCwdPluginsOptions {
  /** Session working directory whose project-scoped installs to merge in. */
  cwd: string;
  /** The globally-installed plugin entries (from {@link buildClaudeAgentSdkPluginsArray}). */
  globalPlugins: ClaudeAgentSdkPlugin[];
  /** Logger for merge diagnostics. */
  logger: Logger;
}

/**
 * Build the effective plugins array for a session launching at `cwd`: the
 * global set plus any project-scoped installs under `<cwd>/.dork/plugins/`.
 *
 * A project-scoped install of the same package overrides its global
 * counterpart, mirroring how scoped installs shadow global ones in the
 * marketplace scanner's merged view. The install directory name IS the
 * package name (`computeInstallRoot`), so basename comparison against the
 * global entries is exact, not heuristic.
 *
 * Directories without a package manifest are skipped, so a partial install
 * or an unrelated file in `.dork/plugins/` never blocks a session. A missing
 * `.dork/plugins/` directory (the common case) returns the global set as-is.
 *
 * @param opts - Session cwd, global plugin entries, and logger.
 * @returns The merged plugin entries for this cwd (possibly empty).
 */
export async function buildPluginsForCwd(
  opts: BuildCwdPluginsOptions
): Promise<ClaudeAgentSdkPlugin[]> {
  const localPluginsDir = path.join(opts.cwd, '.dork', 'plugins');

  let entryNames: string[];
  try {
    const entries = await readdir(localPluginsDir, { withFileTypes: true });
    entryNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return opts.globalPlugins;
  }

  const localNames = new Set<string>();
  const local: ClaudeAgentSdkPlugin[] = [];
  for (const name of entryNames) {
    const pluginPath = path.join(localPluginsDir, name);
    try {
      await access(path.join(pluginPath, PACKAGE_MANIFEST_PATH));
    } catch {
      continue;
    }
    localNames.add(name);
    local.push({ type: 'local', path: pluginPath });
  }
  if (local.length === 0) return opts.globalPlugins;

  const merged = opts.globalPlugins.filter((p) => !localNames.has(path.basename(p.path)));
  merged.push(...local);
  opts.logger.debug('plugin-activation: merged project-scoped plugins', {
    cwd: opts.cwd,
    localCount: local.length,
    overriddenCount: opts.globalPlugins.length - (merged.length - local.length),
  });
  return merged;
}
