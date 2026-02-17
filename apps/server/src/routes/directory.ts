import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { BrowseDirectoryQuerySchema } from '@dorkos/shared/schemas';
import { validateBoundary, getBoundary, BoundaryError } from '../lib/boundary.js';

const router = Router();

// GET /api/directory - Browse directories (restricted to configured boundary)
router.get('/', async (req, res) => {
  const parsed = BrowseDirectoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const { path: userPath, showHidden } = parsed.data;

  const boundary = getBoundary();
  const targetPath = userPath || boundary;

  let resolved: string;
  try {
    resolved = await validateBoundary(targetPath);
  } catch (err: unknown) {
    if (err instanceof BoundaryError) {
      if (err.code === 'NULL_BYTE') return res.status(400).json({ error: err.message, code: err.code });
      return res.status(403).json({ error: err.message, code: err.code });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    throw err;
  }

  // Read directory entries (directories only)
  let dirents: import('fs').Dirent[];
  try {
    dirents = (await fs.readdir(resolved, { withFileTypes: true })) as import('fs').Dirent[];
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    if (code === 'ENOTDIR') return res.status(400).json({ error: 'Not a directory' });
    throw err;
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

  const parent = path.dirname(resolved);
  const hasParent = parent !== resolved && (parent === boundary || parent.startsWith(boundary + path.sep));

  res.json({
    path: resolved,
    entries,
    parent: hasParent ? parent : null,
  });
});

// GET /api/directory/default - Get the server's default working directory
router.get('/default', (_req, res) => {
  res.json({ path: process.cwd() });
});

export default router;
