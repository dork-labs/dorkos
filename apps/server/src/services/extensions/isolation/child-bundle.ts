/**
 * Find a file DorkOS forks as its own process: an isolated extension's, or the shell guard's.
 *
 * - **Shipped builds.** The CLI and desktop builds emit the child as one `.cjs` file beside the
 *   server bundle, so it sits next to the module this was bundled into. In the packaged desktop app
 *   that folder is inside `app.asar`, so the file is unpacked (`electron-builder.yml`), and the
 *   unpacked twin is used whenever it exists.
 * - **Development** (the server under `tsx`, or its `tsc` output). There is no sibling file, so the
 *   child's source is bundled once per server process into a cache folder. The file name carries
 *   the bundle's content hash, so an edited child never runs stale.
 *
 * `.cjs`, not `.js`: the CLI package is `"type": "module"`, and a child is CommonJS.
 *
 * @module services/extensions/isolation/child-bundle
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One development bundle per output folder and name, per server process. */
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
 * Bundle a child's source into the cache, keyed by content.
 *
 * @param source - The child's entry.
 * @param fileName - The shipped file's name, which the cached file's name is made from.
 * @param devCacheDir - Where the bundle goes.
 */
async function bundleForDev(
  source: string,
  fileName: string,
  devCacheDir: string
): Promise<string> {
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
  if (!output) throw new Error(`Bundling ${fileName} produced no output.`);
  const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  await fs.mkdir(devCacheDir, { recursive: true });
  const file = path.join(devCacheDir, `${path.basename(fileName, '.cjs')}-${hash}.cjs`);
  if (!existsSync(file)) {
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, output.contents);
    await fs.rename(temp, file);
  }
  return file;
}

/** What {@link resolveChildBundle} needs. */
export interface ChildBundle {
  /** The name the production builds emit beside the server bundle. */
  fileName: string;
  /** The child's source, relative to the calling module, as `.ts` and as `.js`. */
  sources: readonly string[];
  /** Where a development bundle goes. */
  devCacheDir: string;
  /** The calling module's URL. */
  moduleUrl: string;
  /** What to call it in an error. */
  description: string;
}

/**
 * The file to fork: the shipped sibling, or a development bundle.
 *
 * @param child - See {@link ChildBundle}.
 * @returns An absolute path.
 */
export async function resolveChildBundle(child: ChildBundle): Promise<string> {
  const here = path.dirname(fileURLToPath(child.moduleUrl));
  const unpacked = unpackedPath(path.join(here, child.fileName));
  if (existsSync(unpacked)) return unpacked;
  const source = child.sources.map((name) => path.join(here, name)).find((one) => existsSync(one));
  if (!source) {
    throw new Error(`${child.description} (${child.fileName}) is missing from this build.`);
  }
  const key = path.join(child.devCacheDir, child.fileName);
  const cached = devBuilds.get(key);
  if (cached) {
    const file = await cached.catch(() => null);
    if (file && existsSync(file)) return file;
  }
  const build = bundleForDev(source, child.fileName, child.devCacheDir);
  devBuilds.set(key, build);
  build.catch(() => devBuilds.delete(key));
  return build;
}
