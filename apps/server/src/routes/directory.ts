import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { BrowseDirectoryQuerySchema } from '@dorkos/shared/schemas';
import { AGENT_NAME_REGEX } from '@dorkos/shared/validation';
import {
  validateBoundary,
  validateBoundaryOrDorkHome,
  resolveAgentsRoot,
  getBoundary,
  BoundaryError,
} from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';

const CreateDirectoryBodySchema = z.object({
  parentPath: z.string().min(1),
  folderName: z.string().min(1),
});

const router = new Hono<ApiEnv>();

// GET /api/directory - Browse directories (restricted to configured boundary)
router.get('/', async (c) => {
  const parsed = BrowseDirectoryQuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
  }
  const { path: userPath, showHidden } = parsed.data;

  const boundary = getBoundary();
  const targetPath = userPath || boundary;

  let resolved: string;
  try {
    // Widened to validateBoundaryOrDorkHome (not validateBoundary) so browsing
    // {dorkHome}/agents/* resolves under a boundary-scoped install (e.g.
    // DORKOS_BOUNDARY=/workspace in a container) — the same treatment the
    // session routes got in PR #412 (DOR-437).
    resolved = await validateBoundaryOrDorkHome(targetPath);
  } catch (err: unknown) {
    if (err instanceof BoundaryError) {
      if (err.code === 'NULL_BYTE') return c.json({ error: err.message, code: err.code }, 400);
      return c.json({ error: err.message, code: err.code }, 403);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return c.json({ error: 'Directory not found' }, 404);
    if (code === 'EACCES') return c.json({ error: 'Permission denied' }, 403);
    logger.error('[directory] GET / validateBoundary failed', { err, targetPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  // Read directory entries (directories only)
  let dirents: import('fs').Dirent[];
  try {
    dirents = (await fs.readdir(resolved, { withFileTypes: true })) as import('fs').Dirent[];
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return c.json({ error: 'Directory not found' }, 404);
    if (code === 'EACCES') return c.json({ error: 'Permission denied' }, 403);
    if (code === 'ENOTDIR') return c.json({ error: 'Not a directory' }, 400);
    logger.error('[directory] GET / readdir failed', { err, resolved });
    return c.json({ error: 'Internal server error' }, 500);
  }

  const entries = dirents
    .filter((d) => d.isDirectory())
    .filter((d) => showHidden || !d.name.startsWith('.'))
    .map((d) => ({
      name: d.name,
      path: path.join(resolved, d.name),
      isDirectory: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The agents root gets the same "navigate up" treatment as the project
  // boundary (DOR-437): a resolved path that landed under {dorkHome}/agents
  // (via validateBoundaryOrDorkHome, above) needs an up-button that stays
  // live up to that root and stops there — otherwise a boundary-scoped
  // install strands the picker on a dead up-button inside the one subtree
  // this route can actually reach, or worse, offers a breadcrumb one level
  // up that immediately 403s.
  const agentsRoot = await resolveAgentsRoot();
  const parent = path.dirname(resolved);
  const hasParent =
    parent !== resolved &&
    (parent === boundary ||
      parent.startsWith(boundary + path.sep) ||
      parent === agentsRoot ||
      parent.startsWith(agentsRoot + path.sep));

  return c.json({
    path: resolved,
    entries,
    parent: hasParent ? parent : null,
  });
});

// GET /api/directory/default - Get the server's default working directory
router.get('/default', (c) => {
  // Use the CLI-resolved, boundary-validated default cwd (lib/resolve-root.js),
  // not the raw process.cwd() — the two diverge whenever the process starts
  // outside the configured boundary (e.g. a container with no WORKDIR): the
  // CLI clamps DORKOS_DEFAULT_CWD back to the boundary root, but process.cwd()
  // never changes without an explicit chdir. Returning the unclamped value
  // handed clients a directory that boundary-enforced routes (POST
  // /api/terminal, session creation) would then reject with 403.
  return c.json({ path: DEFAULT_CWD });
});

// POST /api/directory - Create a new directory within the boundary
router.post('/', async (c) => {
  const parsed = CreateDirectoryBodySchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }

  const { parentPath, folderName } = parsed.data;

  // Validate folder name is kebab-case
  if (!AGENT_NAME_REGEX.test(folderName)) {
    return c.json(
      {
        error:
          'Invalid folder name. Lowercase letters, numbers, and hyphens only. Must start with a letter.',
      },
      400
    );
  }

  // Validate parentPath is within boundary
  let resolvedParent: string;
  try {
    resolvedParent = await validateBoundary(parentPath);
  } catch (err: unknown) {
    if (err instanceof BoundaryError) {
      if (err.code === 'NULL_BYTE') return c.json({ error: err.message, code: err.code }, 400);
      return c.json({ error: err.message, code: err.code }, 403);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return c.json({ error: 'Parent directory not found' }, 404);
    if (code === 'EACCES') return c.json({ error: 'Permission denied' }, 403);
    logger.error('[directory] POST / validateBoundary failed', { err, parentPath });
    return c.json({ error: 'Internal server error' }, 500);
  }

  const newDirPath = path.join(resolvedParent, folderName);

  // Check if directory already exists
  try {
    await fs.access(newDirPath);
    return c.json({ error: 'Directory already exists' }, 409);
  } catch {
    // Expected — directory does not exist yet
  }

  try {
    await fs.mkdir(newDirPath, { recursive: true });
  } catch (err) {
    logger.error('[directory] POST / mkdir failed', { err, newDirPath });
    return c.json({ error: 'Failed to create directory' }, 500);
  }
  return c.json({ path: newDirPath }, 201);
});

export default router;
