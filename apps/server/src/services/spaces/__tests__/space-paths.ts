/**
 * Where the space server's tests find what sits outside the server's source: the migrations,
 * the web page source, the browser tests, the package folder and the repository. Server-merge
 * step 7 moves the source away from the rest, so a test that reaches past `src/` goes through
 * here rather than counting `../` from its own file.
 */
import { SPACE_ROOT } from '../startup/space-root.js';

export { MIGRATIONS_DIR, SPACE_ROOT, WEB_DIR } from '../startup/space-root.js';

/** The server's source folder. */
export const SPACE_SRC = new URL('../', import.meta.url);

/**
 * The source of the space's web page in `apps/client` (server-merge step 7e), which
 * `apps/client/vite.space.config.ts` builds into `dist/`.
 */
export const SPACE_WEB_SRC = new URL('../client/src/space/', SPACE_ROOT);

/** The repository root. */
export const REPO_ROOT = new URL('../../', SPACE_ROOT);
