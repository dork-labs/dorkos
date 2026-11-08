import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundaryRootFor, mainCheckoutOf } from './boundary-root';

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
 * The checkout root, which every server this harness boots from source is
 * boundary-scoped to.
 *
 * The server refuses any agent path outside `DORKOS_BOUNDARY`, and that defaults
 * to the **home directory**. So the fixtures' own scratch dir under
 * `apps/e2e/.temp` is out of bounds on a throwaway home, and on any checkout
 * parked outside `$HOME`: every seeded agent answers `Path outside boundary` and
 * specs fail for a reason no diff explains.
 *
 * Naming the boundary makes that true by construction instead of by coincidence.
 * The checkout is the right root because the server's own default working
 * directory is already the repo root (`resolve-root.ts`), so nothing the suite
 * legitimately reaches falls outside it.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The boundary itself: the checkout, widened only in a linked worktree (see `boundary-root.ts`). */
const BOUNDARY_ROOT = boundaryRootFor(REPO_ROOT, mainCheckoutOf(REPO_ROOT));

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
 * The shell that prepares a server's home and its local marketplace source.
 * Run after its `DORK_HOME` exists.
 *
 * A missing `marketplaces.json` seeds the product's live GitHub sources. Their
 * two 15-second fetches held `/api/marketplace/packages` for 30 seconds in CI,
 * past both the connector-card and responsive-layout specs' deadlines. Seed
 * here so every API leg, including first-run, starts from local disk. Specs
 * can still register their own sources; a small listing keeps package cards
 * in the responsive sample without depending on the public registry.
 *
 * @param dorkHome - The server's `DORK_HOME`.
 */
export function makeThrowawayHome(dorkHome: string): string {
  const marketplaces = JSON.stringify({
    version: 1,
    sources: [
      {
        name: 'e2e-local-marketplace',
        source: pathToFileURL(join(import.meta.dirname, 'fixtures', 'local-marketplace')).href,
        enabled: true,
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }).replace(/[\\"$`]/g, '\\$&');
  return (
    `mkdir -m 700 -p ${join(throwawayHomeOf(dorkHome), '.claude')} && ` +
    `printf "%s\\n" "${marketplaces}" > ${join(dorkHome, 'marketplaces.json')}`
  );
}

/**
 * The shell that starts a server from source on its throwaway home. `env` sits
 * after `pnpm exec`, so pnpm itself still runs on the real home.
 *
 * It names the boundary too, so no leg can move its home without it: the boundary
 * defaults to the home folder, and an empty home holds none of the fixtures. See
 * {@link REPO_ROOT}.
 *
 * @param dorkHome - The server's `DORK_HOME`.
 */
export function bootServerOnThrowawayHome(dorkHome: string): string {
  const assignments = Object.entries({
    ...isolatedHomeEnv(throwawayHomeOf(dorkHome)),
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    DORKOS_BOUNDARY: BOUNDARY_ROOT,
  })
    // Double quotes: this lands inside the leg's single-quoted `sh -c`.
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `pnpm --filter @dorkos/server exec env ${assignments} tsx src/index.ts`;
}
