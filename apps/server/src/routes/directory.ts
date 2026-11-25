import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { AGENT_NAME_REGEX } from '@dorkos/shared/validation';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';

const CreateDirectoryBodySchema = z.object({
  parentPath: z.string().min(1),
  folderName: z.string().min(1),
});

const router = new Hono<ApiEnv>();

/** The operating system would not let DorkOS read the folder. */
const NOT_ALLOWED_TO_READ = 'DorkOS isn’t allowed to read that folder.';

/** Making the folder failed for a reason that is not the caller's. */
const FOLDER_NOT_MADE = 'Couldn’t make that folder. Try again.';

// POST /api/directory - Create a new directory within the boundary
router.post('/', async (c) => {
  const parsed = CreateDirectoryBodySchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error);
  }

  const { parentPath, folderName } = parsed.data;

  // Validate folder name is kebab-case
  if (!AGENT_NAME_REGEX.test(folderName)) {
    return problem(c, 'invalid_request', {
      detail: 'Use lowercase letters, numbers and hyphens, starting with a letter.',
    });
  }

  // Validate parentPath is within boundary
  let resolvedParent: string;
  try {
    resolvedParent = await validateBoundary(parentPath);
  } catch (err: unknown) {
    if (err instanceof BoundaryError) return boundaryProblem(c, err);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return problem(c, 'not_found', { detail: 'The folder to make it in doesn’t exist.' });
    }
    if (code === 'EACCES') return problem(c, 'forbidden', { detail: NOT_ALLOWED_TO_READ });
    logger.error('[directory] POST / validateBoundary failed', { err, parentPath });
    return problem(c, 'internal_error', { detail: FOLDER_NOT_MADE });
  }

  const newDirPath = path.join(resolvedParent, folderName);

  // Check if directory already exists
  try {
    await fs.access(newDirPath);
    return problem(c, 'already_exists', { detail: 'A folder with that name is already there.' });
  } catch {
    // Expected — directory does not exist yet
  }

  try {
    await fs.mkdir(newDirPath, { recursive: true });
  } catch (err) {
    logger.error('[directory] POST / mkdir failed', { err, newDirPath });
    return problem(c, 'internal_error', { detail: FOLDER_NOT_MADE });
  }
  return c.json({ path: newDirPath }, 201);
});

export default router;
