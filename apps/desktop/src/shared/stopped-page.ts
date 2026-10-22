/**
 * The "DorkOS stopped" page, and therefore a file the build has to package
 * (DOR-3229).
 *
 * One constant, two consumers, the same arrangement as `fallback-page.ts`:
 * `src/main/server-stopped/` loads it when restarting the server has given up,
 * and `electron.vite.config.ts` emits it beside the compiled main process so
 * `join(__dirname, …)` resolves the same in dev and packaged.
 *
 * @module shared/stopped-page
 */

/** Name of the stopped page, in {@link STOPPED_PAGE_SOURCE_DIR} and beside the compiled main process. */
export const STOPPED_PAGE_FILE = 'server-stopped.html';

/** Directory the stopped page is authored in, relative to `apps/desktop/`. */
export const STOPPED_PAGE_SOURCE_DIR = 'src/main/server-stopped';
