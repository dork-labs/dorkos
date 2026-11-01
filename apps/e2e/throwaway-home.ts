import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway server's own `HOME` (DOR-3587).
 *
 * `DORK_HOME` moves what DorkOS owns, but the server also reads other programs'
 * folders from the home directory, and its first boot copies the Claude sign-ins
 * it finds into its data directory. So every server this harness starts gets a
 * home inside its `DORK_HOME`, which is also what the server's own guard asks of
 * a test runtime before it runs its first-boot seeds (`first-boot-seed-guard.ts`).
 *
 * Only the server gets it. `pnpm`, `turbo` and the Playwright runner keep the real
 * home, because they read their settings, store and browsers from it.
 *
 * @module throwaway-home
 */

/**
 * The environment that gives a server a home of its own: `HOME`, and every
 * variable the server's carve-outs read before it.
 *
 * @param home - The folder to use as the server's home.
 * @returns The variables to set on the server.
 */
export function isolatedHomeEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    // OpenCode's database path, read before its data dir when it is set.
    OPENCODE_DB: join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
}

/**
 * Where the server's home sits inside its data directory.
 *
 * @param dorkHome - The server's `DORK_HOME`.
 */
export function throwawayHomeOf(dorkHome: string): string {
  return join(dorkHome, 'home');
}

/**
 * Where Playwright keeps its browsers, spelled out because Playwright derives
 * the default from `HOME`. A server with a throwaway home would otherwise look
 * for Chromium in that empty folder.
 *
 * @returns The folder to pass as `PLAYWRIGHT_BROWSERS_PATH`.
 */
export function playwrightBrowsersPath(): string {
  // eslint-disable-next-line no-restricted-syntax -- this package has no env.ts; Playwright's own variable
  const { PLAYWRIGHT_BROWSERS_PATH: named, XDG_CACHE_HOME: xdgCache } = process.env;
  if (named) return named;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(xdgCache || join(homedir(), '.cache'), 'ms-playwright');
}

/**
 * The shell that makes a server's home, and the Claude folder its seed will look
 * in. Run after its `DORK_HOME` exists.
 *
 * @param dorkHome - The server's `DORK_HOME`.
 */
export function makeThrowawayHome(dorkHome: string): string {
  return `mkdir -m 700 -p ${join(throwawayHomeOf(dorkHome), '.claude')}`;
}

/**
 * The shell that starts a server from source on its throwaway home. `env` sits
 * after `pnpm exec`, so pnpm itself still runs on the real home.
 *
 * @param dorkHome - The server's `DORK_HOME`.
 */
export function bootServerOnThrowawayHome(dorkHome: string): string {
  const assignments = Object.entries({
    ...isolatedHomeEnv(throwawayHomeOf(dorkHome)),
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
  })
    // Double quotes: this lands inside the leg's single-quoted `sh -c`.
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `pnpm --filter @dorkos/server exec env ${assignments} tsx src/index.ts`;
}
