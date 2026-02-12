import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BrowseDirectoryQuerySchema } from '@lifeos/shared/schemas';

const router = Router();
const HOME = os.homedir();

// GET /api/directory - Browse directories (restricted to home directory)
router.get('/', async (req, res) => {
  const parsed = BrowseDirectoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const { path: userPath, showHidden } = parsed.data;

  const targetPath = userPath || HOME;

  // Reject null bytes
  if (targetPath.includes('\0')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  let resolved: string;
  try {
    resolved = await fs.realpath(targetPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    throw err;
  }

  // Security: restrict to home directory
  if (!resolved.startsWith(HOME)) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }

  // Read directory entries (directories only)
  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true }) as import('fs').Dirent[];
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    if (code === 'ENOTDIR') return res.status(400).json({ error: 'Not a directory' });
    throw err;
  }

  const entries = dirents
    .filter(d => d.isDirectory())
    .filter(d => showHidden || !d.name.startsWith('.'))
    .map(d => ({
      name: d.name,
      path: path.join(resolved, d.name),
      isDirectory: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(resolved);
  const hasParent = parent !== resolved && parent.startsWith(HOME);

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
