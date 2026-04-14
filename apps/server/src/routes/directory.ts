import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { BrowseDirectoryQuerySchema } from '@dorkos/shared/schemas';
import { AGENT_NAME_REGEX } from '@dorkos/shared/validation';
import { validateBoundary, getBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

const CreateDirectoryBodySchema = z.object({
  parentPath: z.string().min(1),
  folderName: z.string().min(1),
});

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
      if (err.code === 'NULL_BYTE')
        return res.status(400).json({ error: err.message, code: err.code });
      return res.status(403).json({ error: err.message, code: err.code });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    logger.error('[directory] GET / validateBoundary failed', { err, targetPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Read directory entries (directories only)
  let dirents: import('fs').Dirent[];
  try {
    dirents = (await fs.readdir(resolved, { withFileTypes: true })) as import('fs').Dirent[];
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    if (code === 'ENOTDIR') return res.status(400).json({ error: 'Not a directory' });
    logger.error('[directory] GET / readdir failed', { err, resolved });
    return res.status(500).json({ error: 'Internal server error' });
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
  const hasParent =
    parent !== resolved && (parent === boundary || parent.startsWith(boundary + path.sep));

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

// POST /api/directory - Create a new directory within the boundary
router.post('/', async (req, res) => {
  const parsed = CreateDirectoryBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }

  const { parentPath, folderName } = parsed.data;

  // Validate folder name is kebab-case
  if (!AGENT_NAME_REGEX.test(folderName)) {
    return res.status(400).json({
      error:
        'Invalid folder name. Lowercase letters, numbers, and hyphens only. Must start with a letter.',
    });
  }

  // Validate parentPath is within boundary
  let resolvedParent: string;
  try {
    resolvedParent = await validateBoundary(parentPath);
  } catch (err: unknown) {
    if (err instanceof BoundaryError) {
      if (err.code === 'NULL_BYTE')
        return res.status(400).json({ error: err.message, code: err.code });
      return res.status(403).json({ error: err.message, code: err.code });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json({ error: 'Parent directory not found' });
    if (code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
    logger.error('[directory] POST / validateBoundary failed', { err, parentPath });
    return res.status(500).json({ error: 'Internal server error' });
  }

  const newDirPath = path.join(resolvedParent, folderName);

  // Check if directory already exists
  try {
    await fs.access(newDirPath);
    return res.status(409).json({ error: 'Directory already exists' });
  } catch {
    // Expected — directory does not exist yet
  }

  try {
    await fs.mkdir(newDirPath, { recursive: true });
  } catch (err) {
    logger.error('[directory] POST / mkdir failed', { err, newDirPath });
    return res.status(500).json({ error: 'Failed to create directory' });
  }
  res.status(201).json({ path: newDirPath });
});

export default router;
