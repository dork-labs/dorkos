/**
 * Load an in-process extension's compiled server bundle (ADR 0213) with the
 * same injected `require` an isolated one gets (`../isolation/child/load-bundle.ts`):
 * the modules DorkOS provides, and Node's built-ins. A bundle sits in
 * `~/.dork`, which has no `node_modules` to find them in, so a plain
 * `require` of the file would not resolve them in an installed DorkOS.
 *
 * @module services/extensions/server-bundle/load-in-process
 */
import { fileURLToPath } from 'node:url';
import * as extensionApi from '@dorkos/extension-api';
import * as extensionServerApi from '@dorkos/extension-api/server';
import { createInjectedRequire, loadBundle } from '../isolation/child/load-bundle.js';

/** The `require` every in-process bundle sees. */
const injectedRequire = createInjectedRequire(
  {
    '@dorkos/extension-api': () => extensionApi,
    '@dorkos/extension-api/server': () => extensionServerApi,
  },
  fileURLToPath(import.meta.url)
);

/**
 * Evaluate a compiled server bundle in this process.
 *
 * @param bundlePath - The bundle on disk, so stack traces and source maps name a real file.
 * @returns The bundle's `module.exports`.
 */
export function loadInProcessBundle(bundlePath: string): unknown {
  return loadBundle(bundlePath, injectedRequire);
}
