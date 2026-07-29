/**
 * Template catalog routes — CRUD for agent project templates.
 *
 * Merges built-in DEFAULT_TEMPLATES with user-defined templates stored
 * in `{dorkHome}/agent-templates.json`. Built-in templates cannot be
 * deleted or overwritten.
 *
 * @module routes/templates
 */
import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { withFileLock } from '@dorkos/shared/atomic-write';
import {
  DEFAULT_TEMPLATES,
  TemplateCatalogSchema,
  TemplateEntrySchema,
} from '@dorkos/shared/template-catalog';
import type { TemplateCatalog, TemplateEntry } from '@dorkos/shared/template-catalog';
import { logger } from '../lib/logger.js';

/** Filename for user-defined templates within the dorkHome directory. */
const USER_CATALOG_FILENAME = 'agent-templates.json';

/**
 * Read user templates from disk. Returns an empty array if the file
 * is missing or malformed.
 */
async function readUserTemplates(catalogPath: string): Promise<TemplateEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(catalogPath, 'utf-8');
  } catch {
    // File doesn't exist yet — not an error
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const result = TemplateCatalogSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn('[templates] Malformed catalog file, treating as empty', {
        path: catalogPath,
        errors: z.flattenError(result.error),
      });
      return [];
    }
    return result.data.templates;
  } catch {
    logger.warn('[templates] Failed to parse catalog JSON, treating as empty', {
      path: catalogPath,
    });
    return [];
  }
}

/**
 * Serialize user templates through the enclosing lock's writer.
 *
 * The write must be atomic as well as serialised (DOR-697): the old plain
 * `fs.writeFile` truncated in place, so a reader catching the mid-truncation
 * state parse-failed to `[]` — and because {@link readUserTemplates} treats
 * every read failure as an empty catalog, the *next* write would then silently
 * erase every user template.
 *
 * @param write - The atomic writer supplied by the enclosing `withFileLock`.
 * @param templates - The user templates to persist.
 */
async function writeUserTemplates(
  write: (data: string) => Promise<void>,
  templates: TemplateEntry[]
): Promise<void> {
  const catalog: TemplateCatalog = { version: 1, templates };
  await write(JSON.stringify(catalog, null, 2));
}

/**
 * Create the templates router for template catalog CRUD.
 *
 * @param dorkHome - Resolved DorkOS data directory path
 * @returns Express Router with template endpoints
 */
export function createTemplateRouter(dorkHome: string): Router {
  const router = Router();
  const catalogPath = path.join(dorkHome, USER_CATALOG_FILENAME);

  // GET /api/templates — merged catalog (builtin + user)
  router.get('/', async (_req, res) => {
    try {
      const userTemplates = await readUserTemplates(catalogPath);
      const templates = [...DEFAULT_TEMPLATES, ...userTemplates];
      return res.json({ version: 1, templates });
    } catch (err) {
      logger.error('[templates] GET / failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/templates — add a user template
  router.post('/', async (req, res) => {
    try {
      const result = TemplateEntrySchema.safeParse({ ...req.body, builtin: false });
      if (!result.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(result.error) });
      }

      const entry = result.data;

      // Check for ID conflict with built-in templates
      const builtinConflict = DEFAULT_TEMPLATES.find((t) => t.id === entry.id);
      if (builtinConflict) {
        return res
          .status(409)
          .json({ error: `Template ID '${entry.id}' conflicts with a built-in template` });
      }

      // Read-modify-write: the conflict check reads the same file the write
      // mutates, so both sit inside the per-path lock (DOR-697). Two POSTs
      // landing at once used to each read the old catalog and the second
      // write silently dropped the first template while both returned 201.
      const added = await withFileLock(catalogPath, async (write) => {
        const userTemplates = await readUserTemplates(catalogPath);
        if (userTemplates.some((t) => t.id === entry.id)) {
          return false;
        }
        userTemplates.push(entry);
        await writeUserTemplates(write, userTemplates);
        return true;
      });

      if (!added) {
        return res.status(409).json({ error: `Template ID '${entry.id}' already exists` });
      }

      return res.status(201).json(entry);
    } catch (err) {
      logger.error('[templates] POST / failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/templates/:id — remove a user template
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;

      // Cannot delete built-in templates
      const isBuiltin = DEFAULT_TEMPLATES.some((t) => t.id === id);
      if (isBuiltin) {
        return res.status(403).json({ error: `Cannot delete built-in template '${id}'` });
      }

      // Same read-modify-write shape as POST: lookup and removal must be one
      // critical section against the same catalog file (DOR-697).
      const removed = await withFileLock(catalogPath, async (write) => {
        const userTemplates = await readUserTemplates(catalogPath);
        const index = userTemplates.findIndex((t) => t.id === id);
        if (index === -1) {
          return false;
        }
        userTemplates.splice(index, 1);
        await writeUserTemplates(write, userTemplates);
        return true;
      });

      if (!removed) {
        return res.status(404).json({ error: `Template '${id}' not found` });
      }

      return res.json({ deleted: id });
    } catch (err) {
      logger.error('[templates] DELETE /:id failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
