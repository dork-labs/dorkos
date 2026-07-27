import { app } from 'electron';
import path from 'node:path';

/**
 * Where the desktop app's server keeps its data.
 *
 * @module main/dork-home
 */

/**
 * Resolve the data directory the server child will open.
 *
 * The point of having this in one place is agreement: anything the main process
 * reads out of the data directory before the server starts — `config.json`, for
 * the pinned port — must come from the directory the child then writes to.
 * It therefore follows `buildServerEnv` in `server-spawn.ts`, which is what
 * actually decides, rather than the server's `resolveDorkHome()`, which the two
 * modes reach differently:
 *
 * - **Packaged** — always `~/.dork`, via Electron's `app.getPath('home')`. The
 *   shell pins it for the child whatever the launching environment exported,
 *   and `getPath` goes through CoreFoundation rather than `$HOME`, which is
 *   what makes it right under a relocated home (see `scripts/smoke-packaged.ts`).
 * - **Dev** — `DORK_HOME` is passed through untouched, so the child resolves it
 *   exactly as the server does: an explicit override first, then the
 *   project-local `<cwd>/.temp/.dork` every other dev workflow here uses. `cwd`
 *   is `apps/desktop`, because that is where electron-vite runs and what the
 *   forked child inherits.
 *
 * @returns Absolute path to the data directory.
 */
export function resolveDataDirectory(): string {
  if (app.isPackaged) return path.join(app.getPath('home'), '.dork');
  if (process.env.DORK_HOME) return process.env.DORK_HOME;
  return path.join(process.cwd(), '.temp', '.dork');
}
