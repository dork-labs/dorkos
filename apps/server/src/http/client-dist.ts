/**
 * Where the client build is, for the one server that serves it.
 *
 * Serving the client is production-only (`http/client-files.ts`): in
 * development the app is on the Vite dev server and this server answers only
 * its routes. Read by the front door, which serves the build, and by the
 * sign-in callbacks, which decide whether the app can show their landing page
 * (`http/sign-in-landing-response.ts`).
 *
 * @module http/client-dist
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';

/** Where the client build is when nothing names it: beside this package, from source or dist. */
const DEFAULT_CLIENT_DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../client/dist'
);

/** The client build this server serves, or `undefined` when it serves none (development). */
export function clientDistPath(): string | undefined {
  return env.NODE_ENV === 'production' ? (env.CLIENT_DIST_PATH ?? DEFAULT_CLIENT_DIST) : undefined;
}

/**
 * Whether a production server has a client build to serve. A headless install
 * can run without one, and then a page in the app is a 404.
 *
 * @param distPath - The build directory {@link clientDistPath} named.
 */
export function clientBuildPresent(distPath: string): boolean {
  return existsSync(path.join(distPath, 'index.html'));
}
