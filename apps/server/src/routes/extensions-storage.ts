import type { Request, Response } from 'express';
import { Router } from 'express';

import fs from 'fs/promises';
import { z } from 'zod';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';

import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';
import { resolveBlobPath } from '../services/extensions/extension-data-paths.js';
import { readActivityActor } from '../services/activity/activity-actor.js';

const SetSecretBodySchema = z.object({
  value: z.string().min(1),
});
const SetSettingBodySchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
});
/** Storage routes share the original manager, identity validation and activity attribution. */
export function registerExtensionStorageRoutes(
  router: Router,
  input: {
    extensionManager: ExtensionManager;
    dorkHome: string;
    getCwd: () => string | null;
    safeExtId: RegExp;
  }
): void {
  const { extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID } = input;

  registerDataRoutes(router, input);

  // GET /api/extensions/:id/secrets -- List declared secrets with isSet status (never returns values)
  router.get('/:id/secrets', (req, res) =>
    handleExtensionRoute3({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );

  // PUT /api/extensions/:id/secrets/:key -- Set a secret value (write-only)
  router.put('/:id/secrets/:key', (req, res) =>
    handleExtensionRoute4({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );

  // DELETE /api/extensions/:id/secrets/:key -- Remove a secret
  router.delete('/:id/secrets/:key', (req, res) =>
    handleExtensionRoute5({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );

  // GET /api/extensions/:id/settings -- List declared settings with current values
  router.get('/:id/settings', (req, res) =>
    handleExtensionRoute6({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );

  // PUT /api/extensions/:id/settings/:key -- Store a setting value
  router.put('/:id/settings/:key', (req, res) =>
    handleExtensionRoute7({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );

  // DELETE /api/extensions/:id/settings/:key -- Reset setting to default
  router.delete('/:id/settings/:key', (req, res) =>
    handleExtensionRoute8({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );
}

type RouteContext = {
  extensionManager: ExtensionManager;
  dorkHome: string;
  getCwd: () => string | null;
  safeExtId: RegExp;
};
async function handleExtensionRoute1(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID } = context;

  try {
    const { id } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    const dataPath = resolveBlobPath(id, extensionManager, dorkHome, getCwd);
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
}
async function handleExtensionRoute2(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID } = context;

  try {
    const { id } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    const dataPath = resolveBlobPath(id, extensionManager, dorkHome, getCwd);
    if (!dataPath) {
      return res.status(404).json({ error: `Extension '${id}' not found` });
    }

    await writeFileAtomic(dataPath, JSON.stringify(req.body, null, 2));

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error(`[Extensions] Failed to write data for ${req.params.id}`, err);
    res.status(500).json({ error: 'Failed to write extension data' });
  }
}
async function handleExtensionRoute3(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, safeExtId: SAFE_EXT_ID } = context;

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
}
async function handleExtensionRoute4(
  context: RouteContext,
  req: Request<{ id: string; key: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, safeExtId: SAFE_EXT_ID } = context;

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
      return res.status(400).json({ error: `Secret '${key}' not declared in extension manifest` });
    }

    const store = new ExtensionSecretStore(id, dorkHome);
    await store.set(key, parsed.data.value);

    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      await activityService.emit({
        // No person bar on this route, so this genuinely varies: an agent that
        // identified itself is named, and the feed stops crediting the person
        // with a machine's write (DOR-1801).
        ...readActivityActor(req, res),
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
}
async function handleExtensionRoute5(
  context: RouteContext,
  req: Request<{ id: string; key: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, safeExtId: SAFE_EXT_ID } = context;

  try {
    const { id, key } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

    const record = extensionManager.get(id);
    if (!record) {
      return res.status(404).json({ error: `Extension '${id}' not found` });
    }

    const store = new ExtensionSecretStore(id, dorkHome);
    // Asked BEFORE the delete, because `delete` is idempotent and says nothing
    // about whether anything was there. A feed line reading "Removed secret X"
    // for a secret that was never set is the same small lie this route family
    // was fixed for in DOR-1801 — one about the verb rather than the actor.
    const wasSet = await store.has(key);
    await store.delete(key);

    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService && wasSet) {
      await activityService.emit({
        // Ungated like its `PUT` twin, and attributed the same way (DOR-1829).
        ...readActivityActor(req, res),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: record.manifest.name,
        summary: `Removed secret "${key}" from extension ${record.manifest.name}`,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error(`[Extensions] Failed to delete secret for ${req.params.id}`, err);
    res.status(500).json({ error: 'Failed to delete secret' });
  }
}
async function handleExtensionRoute6(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, safeExtId: SAFE_EXT_ID } = context;

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
}
async function handleExtensionRoute7(
  context: RouteContext,
  req: Request<{ id: string; key: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, safeExtId: SAFE_EXT_ID } = context;

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
      return res.status(400).json({ error: `Setting '${key}' not declared in extension manifest` });
    }

    const store = new ExtensionSettingsStore(dorkHome, id);
    await store.set(key, parsed.data.value);

    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      await activityService.emit({
        // Ungated like the secrets route beside it, and attributed the same way.
        ...readActivityActor(req, res),
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
}
async function handleExtensionRoute8(
  context: RouteContext,
  req: Request<{ id: string; key: string }>,
  res: Response
) {
  const { extensionManager, dorkHome, safeExtId: SAFE_EXT_ID } = context;

  try {
    const { id, key } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });

    const record = extensionManager.get(id);
    if (!record) {
      return res.status(404).json({ error: `Extension '${id}' not found` });
    }

    const store = new ExtensionSettingsStore(dorkHome, id);
    // Read first, for the reason the secrets route above states: resetting a
    // setting that was already at its default changed nothing, and a feed that
    // reports it is padding.
    const hadStoredValue = (await store.get(key)) !== null;
    await store.delete(key);

    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService && hadStoredValue) {
      await activityService.emit({
        // Ungated like its `PUT` twin, and attributed the same way (DOR-1829).
        ...readActivityActor(req, res),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: record.manifest.name,
        summary: `Reset setting "${key}" to its default for extension ${record.manifest.name}`,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error(`[Extensions] Failed to delete setting for ${req.params.id}`, err);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
}

function registerDataRoutes(router: Router, context: RouteContext): void {
  const { extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID } = context;
  // GET /api/extensions/:id/data -- Read extension's persistent data
  router.get('/:id/data', (req, res) =>
    handleExtensionRoute1({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );

  // PUT /api/extensions/:id/data -- Write extension's persistent data
  //
  // **Deliberately writes no Activity, unlike every other write on this router**
  // (DOR-1829 considered it and declined). The secrets and settings routes each
  // record one line per deliberate act by a person or an agent. This one is the
  // extension API's `saveData`, called by extension CODE at whatever rate that
  // code likes: the shipped `hello-world` extension writes its visit counter on
  // every single activation, so an unconditional emit here would put a row in the
  // operator's feed each time they open a page. A feed nobody can read is worth
  // less than a quieter one, and the write itself is bounded — an extension can
  // only ever overwrite its OWN blob, under its own scope-resolved directory.
  // If this ever needs recording, it needs collapsing (one line per extension per
  // window) rather than one line per call, and that is its own piece of work.
  router.put('/:id/data', (req, res) =>
    handleExtensionRoute2({ extensionManager, dorkHome, getCwd, safeExtId: SAFE_EXT_ID }, req, res)
  );
}
