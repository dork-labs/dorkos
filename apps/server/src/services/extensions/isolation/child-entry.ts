/**
 * Find the file DorkOS forks for an isolated extension (DOR-2686, spec §3).
 *
 * - **Shipped builds.** The CLI and desktop builds emit the child bootstrap as
 *   `extension-child.cjs` beside the server bundle, so it sits next to the
 *   module this file was bundled into. In the packaged desktop app that
 *   folder is inside `app.asar`; the file is unpacked (`electron-builder.yml`)
 *   because Node's permission model grants real paths, and a path inside an
 *   archive is not one. The unpacked twin is used whenever it exists.
 * - **Development** (the server under `tsx`, or its `tsc` output). There is no
 *   sibling file, so the bootstrap source is bundled with the esbuild the
 *   extension compiler already uses, once per server process, into
 *   `{dorkHome}/cache/extensions/isolation/`. The file name carries the
 *   bundle's content hash, so an edited bootstrap never runs stale.
 *
 * `.cjs`, not `.js`: the CLI package is `"type": "module"`, and the bootstrap
 * is CommonJS.
 *
 * @module services/extensions/isolation/child-entry
 */
import path from 'node:path';
import { resolveChildBundle } from './child-bundle.js';

export { unpackedPath } from './child-bundle.js';

/** The file name the production builds emit beside the server bundle. */
export const CHILD_ENTRY_FILE = 'extension-child.cjs';

/**
 * The bootstrap file to fork: the shipped sibling, or a development bundle.
 *
 * @param dorkHome - DorkOS's data directory (for the development bundle).
 * @param moduleUrl - Where to look for the sibling; this module's URL by default.
 * @returns An absolute path.
 */
export function resolveChildEntry(
  dorkHome: string,
  moduleUrl: string = import.meta.url
): Promise<string> {
  return resolveChildBundle({
    fileName: CHILD_ENTRY_FILE,
    sources: [path.join('child', 'bootstrap.ts'), path.join('child', 'bootstrap.js')],
    devCacheDir: path.join(dorkHome, 'cache', 'extensions', 'isolation'),
    moduleUrl,
    description: 'The extension child',
  });
}
