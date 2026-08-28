/**
 * The renderer supervisor's last-resort page, and therefore a file the build
 * has to package.
 *
 * One constant, two consumers that would otherwise drift silently:
 * `src/main/renderer-health/` loads it when it has given up on healing
 * the window, and `electron.vite.config.ts` emits it beside the compiled main
 * process so `join(__dirname, …)` resolves the same in dev and packaged. This
 * is the same arrangement — and the same reasoning — as `tray-images.ts`:
 * renaming the file in one place and not the other packages green and produces
 * an app whose recovery page is a `file not found`, on the one screen a person
 * only ever sees when everything else already failed.
 *
 * @module shared/fallback-page
 */

/**
 * Name of the fallback page: in {@link FALLBACK_PAGE_SOURCE_DIR} at build
 * time, and beside the compiled main process at runtime.
 */
export const FALLBACK_PAGE_FILE = 'fallback.html';

/**
 * Directory the fallback page is authored in, relative to `apps/desktop/` —
 * beside the supervisor that loads it, which is also where the build reads it
 * from.
 */
export const FALLBACK_PAGE_SOURCE_DIR = 'src/main/renderer-health';
