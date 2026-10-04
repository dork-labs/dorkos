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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The file name the production builds emit beside the server bundle. */
export const CHILD_ENTRY_FILE = 'extension-child.cjs';

/** One development bundle per data directory, per server process. */
const devBuilds = new Map<string, Promise<string>>();

/**
 * The unpacked twin of a path inside an Electron `app.asar`, when it exists.
 *
 * @param file - A path that may sit inside `app.asar`.
 */
export function unpackedPath(file: string): string {
  const unpacked = file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
}

/**
 * The bootstrap's source next to this module (`.ts` under `tsx`, `.js` in the
 * `tsc` output), or `null` in a bundled build.
 *
 * @param here - This module's folder.
 */
function bootstrapSource(here: string): string | null {
  for (const name of ['bootstrap.ts', 'bootstrap.js']) {
    const candidate = path.join(here, 'child', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Bundle the bootstrap source into the cache, keyed by content.
 *
 * @param source - The bootstrap entry.
 * @param dorkHome - DorkOS's data directory.
 */
async function bundleForDev(source: string, dorkHome: string): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.22',
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('Bundling the extension child produced no output.');
  const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  const dir = path.join(dorkHome, 'cache', 'extensions', 'isolation');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `extension-child-${hash}.cjs`);
  if (!existsSync(file)) {
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, output.contents);
    await fs.rename(temp, file);
  }
  return file;
}

/**
 * The bootstrap file to fork: the shipped sibling, or a development bundle.
 *
 * @param dorkHome - DorkOS's data directory (for the development bundle).
 * @param moduleUrl - Where to look for the sibling; this module's URL by default.
 * @returns An absolute path.
 */
export async function resolveChildEntry(
  dorkHome: string,
  moduleUrl: string = import.meta.url
): Promise<string> {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const shipped = path.join(here, CHILD_ENTRY_FILE);
  const unpacked = unpackedPath(shipped);
  if (existsSync(unpacked)) return unpacked;
  const source = bootstrapSource(here);
  if (!source) {
    throw new Error(`The extension child (${CHILD_ENTRY_FILE}) is missing from this build.`);
  }
  const cached = devBuilds.get(dorkHome);
  if (cached) {
    const file = await cached.catch(() => null);
    if (file && existsSync(file)) return file;
  }
  const build = bundleForDev(source, dorkHome);
  devBuilds.set(dorkHome, build);
  build.catch(() => devBuilds.delete(dorkHome));
  return build;
}
