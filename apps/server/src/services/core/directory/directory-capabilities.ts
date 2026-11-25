/**
 * The folder picker's reads as capabilities (ADR 261123-170830): browse the
 * folders inside the boundary (`GET /api/directory`) and the default working
 * directory (`GET /api/directory/default`), served by the capability mount and
 * reachable by agents through `dorkos call`.
 *
 * Both are reads of what the boundary already lets every caller reach, so they
 * sit on the `observe` tier with no permission area. Making a folder
 * (`POST /api/directory`) is still a hand route in `routes/directory.ts`.
 *
 * @module services/core/directory/directory-capabilities
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BrowseDirectoryQuerySchema, BrowseDirectoryResponseSchema } from '@dorkos/shared/schemas';

import {
  getBoundary,
  resolveAgentsRoot,
  validateBoundaryOrDorkHome,
} from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDomain,
} from '../capabilities/index.js';
import { boundaryToolError } from './path-refusal.js';

/** A refusal for a folder the system answered with an errno, or `null` for another failure. */
function folderToolError(err: unknown): CapabilityToolError | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') {
    return new CapabilityToolError({ error: 'That folder doesn’t exist.', code: 'FOLDER_MISSING' });
  }
  if (code === 'EACCES') {
    return new CapabilityToolError({
      error: 'DorkOS isn’t allowed to read that folder.',
      code: 'FOLDER_NOT_READABLE',
    });
  }
  return null;
}

/** Reading the folder failed for a reason that is not the caller's. */
function unreadable(): CapabilityToolError {
  return new CapabilityToolError({
    error: 'Couldn’t read that folder. Try again.',
    code: 'FOLDER_UNREADABLE',
  });
}

/**
 * The folders in one folder inside the boundary, and the way up when there is
 * one. Hidden folders are left out unless asked for.
 *
 * @param input - The folder (the boundary's root when absent) and `showHidden`.
 */
async function browseDirectory(input: z.infer<typeof BrowseDirectoryQuerySchema>) {
  const boundary = getBoundary();
  const targetPath = input.path || boundary;

  let resolved: string;
  try {
    // Widened to validateBoundaryOrDorkHome (not validateBoundary) so browsing
    // {dorkHome}/agents/* resolves under a boundary-scoped install (e.g.
    // DORKOS_BOUNDARY=/workspace in a container), as the session routes do (DOR-437).
    resolved = await validateBoundaryOrDorkHome(targetPath);
  } catch (err: unknown) {
    const refusal = boundaryToolError(err) ?? folderToolError(err);
    if (refusal) throw refusal;
    logger.error('[directory] browse validateBoundary failed', { err, targetPath });
    throw unreadable();
  }

  let dirents: import('fs').Dirent[];
  try {
    dirents = (await fs.readdir(resolved, { withFileTypes: true })) as import('fs').Dirent[];
  } catch (err: unknown) {
    const refusal = folderToolError(err);
    if (refusal) throw refusal;
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new CapabilityToolError({
        error: 'That path is a file, not a folder.',
        code: 'PATH_IS_A_FILE',
      });
    }
    logger.error('[directory] browse readdir failed', { err, resolved });
    throw unreadable();
  }

  const entries = dirents
    .filter((d) => d.isDirectory())
    .filter((d) => input.showHidden || !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(resolved, d.name), isDirectory: true }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The agents root gets the same "navigate up" treatment as the boundary
  // (DOR-437): an up-button that stays live up to that root and stops there,
  // never one that offers a breadcrumb the next request refuses.
  const agentsRoot = await resolveAgentsRoot();
  const parent = path.dirname(resolved);
  const hasParent =
    parent !== resolved &&
    (parent === boundary ||
      parent.startsWith(boundary + path.sep) ||
      parent === agentsRoot ||
      parent.startsWith(agentsRoot + path.sep));

  return { path: resolved, entries, parent: hasParent ? parent : null };
}

/** `directory.browse`: the folders in one folder inside the boundary. */
export const directoryBrowseCapability = defineCapability({
  id: 'directory.browse',
  title: 'Browse folders',
  description:
    'List the folders inside one folder DorkOS may use, sorted by name, with the folder above ' +
    'when it is still inside. Pass `path` (an absolute folder; the boundary root when left ' +
    'out) and `showHidden` to include folders whose name starts with a dot. Files are not listed.',
  tier: 'observe',
  area: null,
  areaNote: 'reading folder names inside the boundary',
  input: BrowseDirectoryQuerySchema,
  output: BrowseDirectoryResponseSchema,
  surfaces: { http: { method: 'get', path: '/api/directory' } },
  invoke: async (_deps, input) => browseDirectory(input),
});

/** `directory.default`: the server's default working directory. */
export const directoryDefaultCapability = defineCapability({
  id: 'directory.default',
  title: 'Get the default folder',
  description:
    'The folder new chats start in when none is named: the server’s default working ' +
    'directory, already clamped to the folders DorkOS may use.',
  tier: 'observe',
  area: null,
  areaNote: 'reading one folder path',
  input: z.object({}),
  output: z.object({ path: z.string() }),
  surfaces: { http: { method: 'get', path: '/api/directory/default' } },
  // The CLI-resolved, boundary-validated default (lib/resolve-root.js), not the
  // raw process.cwd(): the two differ whenever the process starts outside the
  // boundary, and routes that enforce it would refuse the raw one.
  invoke: async () => ({ path: DEFAULT_CWD }),
});

/** The folder picker's reads; on every server, since every server has a boundary. */
export const directoryDomain: CapabilityDomain = {
  name: 'directory',
  capabilities: [directoryBrowseCapability, directoryDefaultCapability],
};
