/**
 * Template catalog routes: add and remove a user template, kept in
 * `{dorkHome}/agent-templates.json` (`services/core/agent-templates/template-catalog.ts`).
 * Built-in templates cannot be deleted or overwritten. The catalog's read,
 * `GET /api/templates`, is the capability `templates.list`.
 *
 * @module routes/templates
 */
import { Hono } from 'hono';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { DEFAULT_TEMPLATES, TemplateEntrySchema } from '@dorkos/shared/template-catalog';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import {
  readUserTemplates,
  userTemplateCatalogPath,
  writeUserTemplates,
} from '../services/core/agent-templates/template-catalog.js';

/**
 * The template catalog's writes: add and remove a user template. Reading the
 * catalog is the capability `templates.list`, which the mount serves.
 *
 * @param dorkHome - Resolved DorkOS data directory path
 * @returns The routes, for `app.route('/api/templates', …)`.
 */
export function createTemplateRoutes(dorkHome: string): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const catalogPath = userTemplateCatalogPath(dorkHome);

  // POST /api/templates — add a user template
  router.post('/', async (c) => {
    try {
      const result = TemplateEntrySchema.safeParse({
        ...(readJsonBody(c) as Record<string, unknown> | undefined),
        builtin: false,
      });
      if (!result.success) {
        return validationProblem(c, result.error);
      }

      const entry = result.data;

      // Check for ID conflict with built-in templates
      const builtinConflict = DEFAULT_TEMPLATES.find((t) => t.id === entry.id);
      if (builtinConflict) {
        return problem(c, 'conflict', {
          detail: `A built-in template is called '${entry.id}'. Pick another id.`,
        });
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
        return problem(c, 'conflict', {
          detail: `A template called '${entry.id}' already exists. Pick another id.`,
        });
      }

      return c.json(entry, 201);
    } catch (err) {
      logger.error('[templates] POST / failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t save the template. Try again.' });
    }
  });

  // DELETE /api/templates/:id — remove a user template
  router.delete('/:id', async (c) => {
    try {
      const id = c.req.param('id');

      // Cannot delete built-in templates
      const isBuiltin = DEFAULT_TEMPLATES.some((t) => t.id === id);
      if (isBuiltin) {
        return problem(c, 'forbidden', { detail: 'Built-in templates can’t be deleted.' });
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
        return problem(c, 'not_found', { detail: `No template is called '${id}'.` });
      }

      return c.json({ deleted: id });
    } catch (err) {
      logger.error('[templates] DELETE /:id failed', { err });
      return problem(c, 'internal_error', { detail: 'Couldn’t delete the template. Try again.' });
    }
  });

  return router;
}
