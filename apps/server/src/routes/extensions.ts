/**
 * Extension management routes -- discovery, enable/disable, bundle serving, and data storage.
 *
 * @module routes/extensions
 */
import { Router } from 'express';
import type { Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { eventFanOut } from '../services/core/event-fan-out.js';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';

/** Connected SSE clients for extension lifecycle events. */
const sseClients = new Set<Response>();

/**
 * Broadcast an `extension_reloaded` event to all connected SSE clients.
 * Only call this after at least one extension has compiled successfully.
 *
 * @param extensionIds - IDs of the extensions that were reloaded
 */
export function broadcastExtensionReloaded(extensionIds: string[]): void {
  const data = JSON.stringify({
    type: 'extension_reloaded',
    extensionIds,
    timestamp: Date.now(),
  });

  // Broadcast to unified stream
  eventFanOut.broadcast('extension_reloaded', {
    type: 'extension_reloaded',
    extensionIds,
    timestamp: Date.now(),
  });

  // Backward compat: also broadcast to old SSE clients (deprecated endpoint)
  for (const client of sseClients) {
    try {
      client.write(`event: extension_reloaded\ndata: ${data}\n\n`);
    } catch {
      // Client disconnected — will be removed on close event
      sseClients.delete(client);
    }
  }
}

const CwdChangedBodySchema = z.object({
  cwd: z.string().nullable(),
});

const SetSecretBodySchema = z.object({
  value: z.string().min(1),
});

const SetSettingBodySchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
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

  // GET /api/extensions/events -- SSE stream for extension lifecycle events
  router.get('/events', (_req, res) => {
    logger.warn('[DEPRECATED] GET /api/extensions/events — use GET /api/events instead');
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    sseClients.add(res);

    // Send initial heartbeat so the client knows the connection is live
    res.write(':ok\n\n');

    // Clean up on disconnect
    res.on('close', () => {
      sseClients.delete(res);
    });
  });

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

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.extension_installed',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: result.extension.manifest.name,
          summary: `Installed extension ${result.extension.manifest.name}`,
        });
      }

      // Apply live across all connected clients — the bundle is already compiled
      // (enable() awaits it), so clients hot-load the extension's contributions
      // via the SSE `extension_reloaded` handler instead of requiring a page reload.
      broadcastExtensionReloaded([id]);

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
        // `disable()` returns null for two distinct reasons: the extension does
        // not exist, OR it exists but is a required core extension
        // (`canDisable: false`). Distinguish them so the client gets an honest
        // status — 409 Conflict for "exists but forbidden", not a misleading 404.
        if (extensionManager.get(id)) {
          return res
            .status(409)
            .json({ error: `Extension '${id}' is required and cannot be disabled` });
        }
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.extension_removed',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: result.extension.manifest.name,
          summary: `Removed extension ${result.extension.manifest.name}`,
        });
      }

      // Apply live across all connected clients — the SSE `extension_reloaded`
      // handler deactivates the extension and removes its contributions in place,
      // so disabling takes effect without a page reload.
      broadcastExtensionReloaded([id]);

      res.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to disable ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to disable extension' });
    }
  });

  // POST /api/extensions/:id/init-server -- Initialize server-side extension
  router.post('/:id/init-server', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      const result = await extensionManager.initializeServer(id);
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to init server for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to initialize server extension' });
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
          .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
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

  // GET /api/extensions/:id/secrets -- List declared secrets with isSet status (never returns values)
  router.get('/:id/secrets', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

      const record = extensionManager.get(id);
      if (!record) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      const declared = record.manifest.serverCapabilities?.secrets ?? [];
      const store = new ExtensionSecretStore(id, dorkHome);
      const result = await Promise.all(
        declared.map(async (s) => ({
          key: s.key,
          label: s.label,
          description: s.description,
          required: s.required ?? false,
          isSet: await store.has(s.key),
        }))
      );

      res.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to list secrets for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to list secrets' });
    }
  });

  // PUT /api/extensions/:id/secrets/:key -- Set a secret value (write-only)
  router.put('/:id/secrets/:key', async (req, res) => {
    try {
      const { id, key } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

      const parsed = SetSecretBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
      }

      const record = extensionManager.get(id);
      if (!record) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      // Validate key is declared in manifest
      const declared = record.manifest.serverCapabilities?.secrets ?? [];
      if (!declared.some((s) => s.key === key)) {
        return res
          .status(400)
          .json({ error: `Secret '${key}' not declared in extension manifest` });
      }

      const store = new ExtensionSecretStore(id, dorkHome);
      await store.set(key, parsed.data.value);

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: record.manifest.name,
          summary: `Updated secret "${key}" for extension ${record.manifest.name}`,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to set secret for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to set secret' });
    }
  });

  // DELETE /api/extensions/:id/secrets/:key -- Remove a secret
  router.delete('/:id/secrets/:key', async (req, res) => {
    try {
      const { id, key } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

      const record = extensionManager.get(id);
      if (!record) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      const store = new ExtensionSecretStore(id, dorkHome);
      await store.delete(key);
      res.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to delete secret for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to delete secret' });
    }
  });

  // GET /api/extensions/:id/settings -- List declared settings with current values
  router.get('/:id/settings', async (req, res) => {
    try {
      const { id } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

      const record = extensionManager.get(id);
      if (!record) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      const declared = record.manifest.serverCapabilities?.settings ?? [];
      const store = new ExtensionSettingsStore(dorkHome, id);
      const stored = await store.getAll();

      const result = declared.map((s) => {
        const hasStored = s.key in stored;
        return {
          key: s.key,
          type: s.type,
          label: s.label,
          description: s.description,
          placeholder: s.placeholder,
          group: s.group,
          value: hasStored ? stored[s.key] : (s.default ?? null),
          isDefault: !hasStored,
          ...(s.options && { options: s.options }),
          ...(s.min !== undefined && { min: s.min }),
          ...(s.max !== undefined && { max: s.max }),
        };
      });

      res.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to list settings for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to list settings' });
    }
  });

  // PUT /api/extensions/:id/settings/:key -- Store a setting value
  router.put('/:id/settings/:key', async (req, res) => {
    try {
      const { id, key } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

      const parsed = SetSettingBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
      }

      const record = extensionManager.get(id);
      if (!record) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      // Validate key is declared in manifest
      const declared = record.manifest.serverCapabilities?.settings ?? [];
      if (!declared.some((s) => s.key === key)) {
        return res
          .status(400)
          .json({ error: `Setting '${key}' not declared in extension manifest` });
      }

      const store = new ExtensionSettingsStore(dorkHome, id);
      await store.set(key, parsed.data.value);

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: record.manifest.name,
          summary: `Updated setting "${key}" for extension ${record.manifest.name}`,
        });
      }

      res.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to set setting for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to set setting' });
    }
  });

  // DELETE /api/extensions/:id/settings/:key -- Reset setting to default
  router.delete('/:id/settings/:key', async (req, res) => {
    try {
      const { id, key } = req.params;
      if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

      const record = extensionManager.get(id);
      if (!record) {
        return res.status(404).json({ error: `Extension '${id}' not found` });
      }

      const store = new ExtensionSettingsStore(dorkHome, id);
      await store.delete(key);
      res.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to delete setting for ${req.params.id}`, err);
      res.status(500).json({ error: 'Failed to delete setting' });
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
