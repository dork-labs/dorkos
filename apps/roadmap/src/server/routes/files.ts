/**
 * File serving route for spec artifacts.
 *
 * Mounts at `/api/roadmap/files`. Only serves files under the `specs/`
 * directory to prevent path traversal attacks.
 *
 * @module server/routes/files
 */
import { Router } from 'express';
import { readFile } from 'fs/promises';
import path from 'path';

const ALLOWED_PREFIX = 'specs/';

/**
 * Create the files router scoped to a project root directory.
 *
 * @param projectRoot - Absolute path to the project root
 */
export function createFilesRouter(projectRoot: string): Router {
  const router = Router();

  // GET /api/roadmap/files/* — read a spec file
  // Use req.path (relative to this router mount) to extract the file path,
  // avoiding Express 4 vs 5 wildcard param type incompatibilities.
  router.get('/*', async (req, res) => {
    // req.path starts with '/', strip leading slash to get the relative path
    const relativePath = req.path.slice(1);

    // Must start with specs/ prefix
    if (!relativePath || !relativePath.startsWith(ALLOWED_PREFIX)) {
      return res.status(403).json({ error: 'Access denied: only specs/ files are accessible' });
    }

    // Resolve and verify path stays within project root
    const resolved = path.resolve(projectRoot, relativePath);
    const normalizedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(normalizedRoot + path.sep)) {
      return res.status(403).json({ error: 'Access denied: path traversal detected' });
    }

    try {
      const content = await readFile(resolved, 'utf-8');
      res.json({ content });
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
  });

  return router;
}
