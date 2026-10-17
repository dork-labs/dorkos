/**
 * The two files the desktop app ships beside its server bundle, each a
 * self-contained bundle of its own. Called by `build-server.ts` after the
 * server bundle; each removes `dist/server` when it fails, because
 * electron-builder would package whatever is left there.
 *
 * - **The extension child** (DOR-2686): the file DorkOS forks for every
 *   extension that runs separately, with Node's permission model on and read
 *   access to nothing but this file and the extension's own. One CommonJS
 *   file (express and the extension API inlined), where
 *   `isolation/child-entry.ts` looks for it, unpacked from app.asar because
 *   the permission model grants real files, not archive entries.
 * - **The live docs markdown worker** (DOR-2984): started as a worker thread
 *   for every markdown <-> Yjs conversion. One ESM file with Blintz and Yjs
 *   inlined, where `services/docs/collab/worker-entry.ts` looks for it,
 *   unpacked from app.asar. A smoke run proves it loads Blintz and
 *   round-trips a doc.
 *
 * Same entries and names as the CLI build; scripts/__tests__/
 * extension-child-build-entry.test.ts and
 * docs-markdown-worker-build-entry.test.ts pin both.
 *
 * @module desktop/scripts/build-side-bundles
 */
import { execFileSync } from 'child_process';
import { build, type Message, type Plugin } from 'esbuild';
import { rmSync } from 'fs';
import path from 'path';
import {
  MARKDOWN_WORKER_BANNER,
  MARKDOWN_WORKER_FILE,
  MARKDOWN_WORKER_SOURCE,
} from '../../server/src/services/docs/collab/worker-build';

/** What the side bundles need from the build that calls them. */
export interface SideBundleBuild {
  /** The repo root. */
  root: string;
  /** The desktop package's `dist/`. */
  out: string;
  /** The same source-resolution plugin the server bundle uses. */
  plugin: Plugin;
  /** The caller's warning gate. */
  assertNoUnexpectedWarnings: (warnings: Message[]) => Promise<void>;
}

/** Run one side bundle's gates, removing `dist/server` if any fails. */
async function gated(out: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    rmSync(path.join(out, 'server'), { recursive: true, force: true });
    throw err;
  }
}

/**
 * Emit `dist/server/extension-child.cjs` and `dist/server/docs-markdown-worker.mjs`.
 *
 * @param options - Where to read and write, and the caller's gates.
 * @throws When either bundle warns or fails its check.
 */
export async function buildSideBundles(options: SideBundleBuild): Promise<void> {
  const { root, out, plugin, assertNoUnexpectedWarnings } = options;

  const childOutfile = path.join(out, 'server/extension-child.cjs');
  const childResult = await build({
    entryPoints: [
      path.join(root, 'apps/server/src/services/extensions/isolation/child/bootstrap.ts'),
    ],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'cjs',
    outfile: childOutfile,
    plugins: [plugin],
  });
  await gated(out, async () => {
    await assertNoUnexpectedWarnings(childResult.warnings);
    execFileSync(process.execPath, ['--check', childOutfile], { stdio: 'inherit' });
  });

  const workerOutfile = path.join(out, 'server', MARKDOWN_WORKER_FILE);
  const workerResult = await build({
    entryPoints: [path.join(root, MARKDOWN_WORKER_SOURCE)],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'esm',
    outfile: workerOutfile,
    banner: { js: MARKDOWN_WORKER_BANNER },
    plugins: [plugin],
  });
  await gated(out, async () => {
    await assertNoUnexpectedWarnings(workerResult.warnings);
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts/smoke-docs-markdown-worker.mjs'), workerOutfile],
      { stdio: 'inherit' }
    );
  });
}
