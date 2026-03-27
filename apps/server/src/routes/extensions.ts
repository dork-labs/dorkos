/**
 * Extension management routes -- discovery, enable/disable, bundle serving, and data storage.
 *
 * @module routes/extensions
 */
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { logger } from '../lib/logger.js';

const CwdChangedBodySchema = z.object({
  cwd: z.string().nullable(),
});

/** Validates extension IDs match the manifest schema pattern (kebab-case alphanumeric). */
const SAFE_EXT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Create the extensions router.
 *
 * @param extensionManager - ExtensionManager instance for lifecycle operations
 * @param dorkHome - Resolved data directory for extension data storage paths
 * @param getCwd - Function returning the current working directory
 */
export function createExtensionsRouter(
  extensionManager: ExtensionManager,
  dorkHome: string,
  getCwd: () => string | null
): Router {
  const router = Router();

  // GET /api/extensions -- List all discovered extensions with status
  router.get('/', async (_req, res) => {
    try {
      const extensions = extensionManager.listPublic();
      res.json(extensions);
    } catch (err) {
      logger.error('[Extensions] Failed to list extensions', err);
      res.status(500).json({ error: 'Failed to list extensions' });
    }
  });

  // POST /api/extensions/:id/enable -- Enable an extension
  router.post('/:id/enable', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const result = await extensionManager.enable(id);
      if (!result) {
        return res.status(404).json({ error: `Extension '${id}' not found or cannot be enabled` });
      }
      res.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to enable ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to enable extension' });
    }
  });

  // POST /api/extensions/:id/disable -- Disable an extension
  router.post('/:id/disable', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const result = await extensionManager.disable(id);
      if (!result) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }
      res.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to disable ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to disable extension' });
    }
  });

  // POST /api/extensions/reload -- Re-scan filesystem and recompile changed
  router.post('/reload', async (_req, res) => {
    try {
      const extensions = await extensionManager.reload();
      res.json(extensions);
    } catch (err) {
      logger.error('[Extensions] Failed to reload extensions', err);
      res.status(500).json({ error: 'Failed to reload extensions' });
    }
  });

  // POST /api/extensions/cwd-changed -- Notify server that the active CWD changed
  router.post('/cwd-changed', async (req, res) => {
    try {
      const parsed = CwdChangedBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: parsed.error.flatten() });
      }

      const { cwd } = parsed.data;
      const diff = await extensionManager.updateCwd(cwd);
      const changed = diff.added.length > 0 || diff.removed.length > 0;

      if (changed) {
        logger.info(
          `[Extensions] CWD changed: +${diff.added.length} -${diff.removed.length} extensions`
        );
      }

      res.json({ changed, added: diff.added, removed: diff.removed });
    } catch (err) {
      logger.error('[Extensions] Failed to handle CWD change', err);
      res.status(500).json({ error: 'Failed to handle CWD change' });
    }
  });

  // GET /api/extensions/:id/bundle -- Serve compiled JS bundle
  router.get('/:id/bundle', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const bundle = await extensionManager.readBundle(id);
      if (!bundle) {
        return res.status(404).json({ error: `Bundle not available for '${id}'` });
      }
      res.set('Content-Type', 'application/javascript');
      res.set('Cache-Control', 'no-store');
      res.send(bundle);
    } catch (err) {
      logger.error(`[Extensions] Failed to serve bundle for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to serve bundle' });
    }
  });

  // GET /api/extensions/:id/data -- Read extension's persistent data
  router.get('/:id/data', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const dataPath = resolveDataPath(id, extensionManager, dorkHome, getCwd);
      if (!dataPath) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      try {
        const data = await fs.readFile(dataPath, 'utf-8');
        res.json(JSON.parse(data));
      } catch {
        // No data file -- return 204 No Content
        res.status(204).send();
      }
    } catch (err) {
      logger.error(`[Extensions] Failed to read data for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to read extension data' });
    }
  });

  // PUT /api/extensions/:id/data -- Write extension's persistent data
  router.put('/:id/data', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const dataPath = resolveDataPath(id, extensionManager, dorkHome, getCwd);
      if (!dataPath) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      // Create directory if it doesn't exist
      await fs.mkdir(path.dirname(dataPath), { recursive: true });

      // Write atomically: write to temp file, then rename
      const tempPath = dataPath + '.tmp';
      await fs.writeFile(tempPath, JSON.stringify(req.body, null, 2), 'utf-8');
      await fs.rename(tempPath, dataPath);

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to write data for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to write extension data' });
    }
  });

  return router;
}

/**
 * Resolve the data.json path for an extension based on its scope.
 *
 * Global extensions store data in `{dorkHome}/extension-data/{ext-id}/data.json`.
 * Local extensions store data in `{cwd}/.dork/extension-data/{ext-id}/data.json`.
 *
 * @param id - Extension identifier
 * @param manager - ExtensionManager for record lookup
 * @param dorkHome - Resolved data directory
 * @param getCwd - Function returning the current working directory
 */
function resolveDataPath(
  id: string,
  manager: ExtensionManager,
  dorkHome: string,
  getCwd: () => string | null
): string | null {
  const record = manager.get(id);
  if (!record) return null;

  if (record.scope === 'local') {
    const cwd = getCwd();
    if (!cwd) return null;
    return path.join(cwd, '.dork', 'extension-data', id, 'data.json');
  }

  return path.join(dorkHome, 'extension-data', id, 'data.json');
}
