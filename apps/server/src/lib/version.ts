import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { env } from '../env.js';

declare const __CLI_VERSION__: string | undefined;

const DEV_VERSION_PATTERN = /^0\.0\.0/;

/**
 * Resolved server version string.
 *
 * Priority: DORKOS_VERSION_OVERRIDE > __CLI_VERSION__ (esbuild) > package.json fallback.
 */
export const SERVER_VERSION: string = resolveVersion();

/** Whether the server is running a development build (not from CLI bundle). */
export const IS_DEV_BUILD: boolean = checkDevBuild(SERVER_VERSION);

function resolveVersion(): string {
  if (env.DORKOS_VERSION_OVERRIDE) return env.DORKOS_VERSION_OVERRIDE;
  if (typeof __CLI_VERSION__ !== 'undefined') return __CLI_VERSION__;
  // Dev fallback: read version from package.json on disk.
  // Avoids `createRequire` which conflicts with the esbuild banner in CLI builds.
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
}

function checkDevBuild(version: string): boolean {
  // Override explicitly opts out of dev mode
  if (env.DORKOS_VERSION_OVERRIDE) return false;
  // CLI bundle injects __CLI_VERSION__ — not a dev build
  if (typeof __CLI_VERSION__ !== 'undefined') return false;
  // Sentinel version from package.json
  return DEV_VERSION_PATTERN.test(version);
}
