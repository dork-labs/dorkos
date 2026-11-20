/**
 * Load an in-process extension's compiled server bundle (ADR 0213) with the
 * same injected `require` an isolated one gets (`../isolation/child/load-bundle.ts`):
 * the modules DorkOS provides, and Node's built-ins. A bundle sits in
 * `~/.dork`, which has no `node_modules` to find them in, so a plain
 * `require` of the file would not resolve them in an installed DorkOS.
 *
 * @module services/extensions/server-bundle/load-in-process
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as extensionApi from '@dorkos/extension-api';
import * as extensionServerApi from '@dorkos/extension-api/server';
import { createInjectedRequire, loadBundle } from '../isolation/child/load-bundle.js';

/** The `require` every in-process bundle sees. */
const injectedRequire = createInjectedRequire(
  {
    express: () => express,
    '@dorkos/extension-api': () => extensionApi,
    '@dorkos/extension-api/server': () => extensionServerApi,
  },
  fileURLToPath(import.meta.url)
);

/**
 * Write a compiled server bundle to disk, where either way of starting it
 * reads it from, so stack traces and source maps name a real file.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param id - The extension id.
 * @param code - The compiled bundle.
 * @returns The bundle's path.
 */
export async function writeServerBundle(
  dorkHome: string,
  id: string,
  code: string
): Promise<string> {
  const dir = path.join(dorkHome, 'cache', 'extensions', 'server', '_run');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.js`);
  await fs.writeFile(file, code, 'utf-8');
  return file;
}

/**
 * Evaluate a compiled server bundle in this process.
 *
 * @param bundlePath - The bundle on disk, so stack traces and source maps name a real file.
 * @returns The bundle's `module.exports`.
 */
export function loadInProcessBundle(bundlePath: string): unknown {
  return loadBundle(bundlePath, injectedRequire);
}
