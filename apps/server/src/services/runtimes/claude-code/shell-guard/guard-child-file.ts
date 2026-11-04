/**
 * Find the shell guard's child file (`extensions/isolation/child-bundle.ts`).
 *
 * @module services/runtimes/claude-code/shell-guard/guard-child-file
 */
import path from 'node:path';
import { resolveChildBundle } from '../../../extensions/isolation/child-bundle.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';

/** The file name the production builds emit beside the server bundle. */
export const GUARD_CHILD_FILE = 'shell-guard-child.cjs';

/** The file to fork: the shipped sibling, or a development bundle. */
export function resolveGuardChild(): Promise<string> {
  return resolveChildBundle({
    fileName: GUARD_CHILD_FILE,
    sources: ['guard-child.ts', 'guard-child.js'],
    devCacheDir: path.join(resolveDorkHome(), 'cache', 'shell-guard'),
    moduleUrl: import.meta.url,
    description: 'The shell guard’s child',
  });
}
