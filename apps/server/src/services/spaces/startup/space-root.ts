import { fileURLToPath } from 'node:url';

/**
 * The space server's own folder: where `migrations/`, the built web pages (`dist/`) and its
 * `package.json` sit, beside `src/` and the built `dist-server/`. Every path the server works out
 * from its own location starts here, so moving the source (server-merge step 7) changes this one
 * line rather than every file that finds a folder. It holds only where this file runs from
 * source or from the space build's `dist-server/`, never from a bundle or another build.
 */
export const SPACE_ROOT: Readonly<URL> = Object.freeze(
  // From source this file sits in apps/server/src/services/spaces/startup/, and the package's
  // folders are still in apps/space/; built, dist-server/ sits inside that package folder.
  import.meta.url.endsWith('.ts')
    ? new URL('../../../../../space/', import.meta.url)
    : new URL('../../', import.meta.url)
);

/** The SQL migrations the server applies, in `migrations/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('migrations/', SPACE_ROOT));

/** The built web pages the server serves, in `dist/`. */
export const WEB_DIR = fileURLToPath(new URL('dist/', SPACE_ROOT));
