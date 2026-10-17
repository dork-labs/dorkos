/**
 * Find the file the server starts its markdown worker from (DOR-2984).
 *
 * - **Shipped builds.** The CLI and desktop builds bundle the worker on its own
 *   as `docs-markdown-worker.mjs` beside the server bundle, so it sits next to
 *   the module this file was bundled into. In the packaged desktop app that
 *   folder is inside `app.asar`; the file is unpacked (`electron-builder.yml`),
 *   and the unpacked twin is used whenever it exists.
 * - **The server's `tsc` output.** `markdown-worker.js` sits beside this file
 *   and its imports resolve from the server's own `node_modules`, so it runs
 *   as it is.
 * - **Development and tests** (the server under `tsx` or vitest). A worker
 *   cannot run TypeScript, so the source is bundled with the esbuild the
 *   server already depends on, once per server process, into
 *   `{dorkHome}/cache/docs/`. The file name carries the bundle's content hash,
 *   so an edited worker never runs stale. This is the same bundle the shipped
 *   builds make, which is what lets the tests prove the shipped worker works.
 *
 * @module services/docs/collab/worker-entry
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackedPath } from '../../extensions/isolation/child-entry.js';
import { MARKDOWN_WORKER_BANNER, MARKDOWN_WORKER_FILE } from './worker-build.js';

export { MARKDOWN_WORKER_FILE } from './worker-build.js';

/** One development bundle per data directory, per server process. */
const devBuilds = new Map<string, Promise<string>>();

/**
 * Bundle the worker source into the cache, keyed by content.
 *
 * @param source - The worker entry (`markdown-worker.ts`).
 * @param dorkHome - DorkOS's data directory.
 */
async function bundleForDev(source: string, dorkHome: string): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.22',
    banner: { js: MARKDOWN_WORKER_BANNER },
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error('Bundling the markdown worker produced no output.');
  const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, 16);
  const dir = path.join(dorkHome, 'cache', 'docs');
  await fs.mkdir(dir, { recursive: true });
  const name = `markdown-worker-${hash}.mjs`;
  const file = path.join(dir, name);
  if (!existsSync(file)) {
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, output.contents);
    await fs.rename(temp, file);
  }
  // Bundles of earlier edits are never run again.
  for (const old of await fs.readdir(dir).catch(() => [] as string[])) {
    if (/^markdown-worker-[0-9a-f]{16}\.mjs$/.test(old) && old !== name) {
      await fs.rm(path.join(dir, old), { force: true }).catch(() => undefined);
    }
  }
  return file;
}

/**
 * The worker file to start: the shipped sibling, the compiled sibling, or a
 * development bundle.
 *
 * @param dorkHome - DorkOS's data directory (for the development bundle).
 * @param moduleUrl - Where to look for the siblings; this module's URL by default.
 * @returns An absolute path.
 * @throws When this build carries no worker at all.
 */
export async function resolveMarkdownWorkerEntry(
  dorkHome: string,
  moduleUrl: string = import.meta.url
): Promise<string> {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const shipped = unpackedPath(path.join(here, MARKDOWN_WORKER_FILE));
  if (existsSync(shipped)) return shipped;
  const compiled = path.join(here, 'markdown-worker.js');
  if (existsSync(compiled)) return compiled;
  const source = path.join(here, 'markdown-worker.ts');
  if (!existsSync(source)) {
    throw new Error(`The markdown worker (${MARKDOWN_WORKER_FILE}) is missing from this build.`);
  }
  const cached = devBuilds.get(dorkHome);
  if (cached) {
    const file = await cached.catch(() => null);
    if (file && existsSync(file)) return file;
  }
  const bundle = bundleForDev(source, dorkHome);
  devBuilds.set(dorkHome, bundle);
  bundle.catch(() => devBuilds.delete(dorkHome));
  return bundle;
}
