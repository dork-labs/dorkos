import os from 'os';
import path from 'path';

/**
 * Resolve the DorkOS data directory for the Obsidian plugin's in-process
 * runtime (ADR-0043 agent storage, model cache, etc.).
 *
 * The plugin is a packaged, always-production entry point — like the CLI
 * (`packages/cli/src/cli.ts`), not the dev server (`apps/server/src/lib/dork-home.ts`,
 * whose `NODE_ENV !== 'production'` branch assumes a monorepo checkout and a
 * meaningful `process.cwd()`, neither of which holds inside Obsidian's
 * Electron renderer). Mirrors the CLI's own `DORK_HOME || ~/.dork` idiom
 * (`packages/cli/src/cli.ts:256`) so the plugin's cache and agent storage
 * land in the same place a human would expect: `~/.dork`.
 */
export function resolvePluginDorkHome(): string {
  return process.env.DORK_HOME || path.join(os.homedir(), '.dork');
}
