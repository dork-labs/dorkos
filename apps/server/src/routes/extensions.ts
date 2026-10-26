/**
 * Extension management routes -- discovery, enable/disable, bundle serving, and data storage.
 *
 * The two WRITE routes here (`/:id/enable`, `/:id/disable`) run the same person
 * bar as the approval routes mounted alongside them, because they move the same
 * `operator-only` config section — see
 * {@link module:routes/extensions-person-bar} for the three bars, the residual
 * they leave in the login-off posture, and why the narrowing direction is barred
 * too (DOR-1507).
 *
 * The secrets and settings routes are NOT behind that bar — they hold an
 * extension's own per-extension data rather than a leaf of `extensions` in
 * `~/.dork/config.json` — so an agent may legitimately write them. They, and
 * the data route, are bound to the caller instead (DOR-3066,
 * {@link module:routes/extension-write-binding}). Every route
 * here that records an Activity event therefore reads WHO asked
 * (`readActivityActor`) instead of asserting it was the person; they all claimed
 * `user` / `'You'` before DOR-1801, so an agent setting an API key showed up in
 * the feed as the operator's own action.
 *
 * The two DELETE routes joined them in DOR-1829: removing a secret is at least as
 * worth recording as setting one, and they were silent. `PUT /:id/data` is the
 * one write here that stays silent on purpose — the reason is at that route.
 *
 * @module routes/extensions
 */
import type { ServerResponse } from 'node:http';
import fs from 'fs/promises';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { refusedExtensionWrite } from './extension-write-binding.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { eventFanOut } from '../services/core/event-fan-out.js';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';
import { resolveBlobPath } from '../services/extensions/extension-data-paths.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { registerExtensionApprovalRoutes } from './extensions-approval.js';
import { registerTrustedSourceRoutes } from './extensions-trusted-sources.js';
import { registerExtensionInboxRoutes } from './extensions-inbox.js';
import { registerExtensionStartWorkRoute } from './extensions-start-work.js';
import { registerExtensionRoomRoutes } from './extensions-rooms.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';

/** Connected SSE clients for extension lifecycle events. */
const sseClients = new Set<ServerResponse>();

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
 * What `/enable` and `/disable` say when a bar refuses them (DOR-1507).
 *
 * They write `extensions.enabled` / `extensions.disabled`, both `operator-only`
 * in `config-write-policy.ts`, straight through `configManager` — around the
 * door that enforces that classification. So they answer with that door's own
 * code and headline: one setting, one refusal, wherever a caller meets it.
 *
 * The messages talk about which code DorkOS runs rather than about a config
 * key, because that is what a person reading a refusal actually needs to know.
 * The three bars themselves live in
 * {@link module:routes/extensions-person-bar}, shared with the approval routes.
 */
const EXTENSION_TOGGLE_BAR: PersonBarCopy = {
  error: OPERATOR_ONLY_CONFIG_ERROR,
  code: OPERATOR_ONLY_CONFIG_CODE,
  subject: 'which extensions are turned on',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Turning an extension on or off changes which code this copy of DorkOS runs, and ` +
    `that is something a person does in their own app — not something another site ` +
    `can ask for on their behalf.`,
  agent:
    `DorkOS changed nothing. Turning an extension on or off decides which code runs ` +
    `inside DorkOS, so it is a decision only a person makes. Ask them to open ` +
    `Settings > Extensions and make the change there.`,
};

/** What the `/api/extensions` routes read. */
export interface ExtensionsRouterDeps {
  /** The extension manager, for lifecycle operations. */
  manager: ExtensionManager;
  /** The resolved data directory, for extension data storage paths. */
  dorkHome: string;
  /** The current working directory, for a project extension's data. */
  getCwd: () => string | null;
  /** The Activity feed changes are recorded in, when the server has one. */
  activity?: Pick<ActivityService, 'emit'>;
}

/** The answer for an id outside {@link SAFE_EXT_ID}. */
const INVALID_ID = { error: 'Invalid extension ID' };

/**
 * A validation failure, in the shape these routes have always answered.
 *
 * @param c - The request's context.
 * @param error - What Zod refused.
 */
function validationFailed(c: Context<ApiEnv>, error: z.ZodError): Response {
  return c.json({ error: 'Validation failed', details: z.flattenError(error) }, 400);
}

/**
 * Create the `/api/extensions` routes.
 *
 * @param deps - See {@link ExtensionsRouterDeps}.
 * @returns The routes, for `app.route('/api/extensions', …)`.
 */
export function createExtensionsRoutes(deps: ExtensionsRouterDeps): Hono<ApiEnv> {
  const { manager: extensionManager, dorkHome, getCwd, activity } = deps;
  const router = new Hono<ApiEnv>();

  // GET /api/extensions/events -- SSE stream for extension lifecycle events
  router.get('/events', (c) =>
    streamToNodeResponse(c, (res, { signal }) => {
      logger.warn('[DEPRECATED] GET /api/extensions/events — use GET /api/events instead');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Send initial heartbeat so the client knows the connection is live
      res.write(':ok\n\n');
      sseClients.add(res);
      // Clean up on disconnect
      return new Promise<void>((resolve) => {
        const leave = (): void => {
          sseClients.delete(res);
          resolve();
        };
        if (signal.aborted) leave();
        else signal.addEventListener('abort', leave, { once: true });
      });
    })
  );

  // GET /api/extensions -- List all discovered extensions with status: every
  // copy that runs, then each older copy a newer one of the same trusted
  // source shadows, with `shadowedBy` set (spec `flow-multiproject` §9.2).
  router.get('/', (c) => {
    try {
      return c.json([...extensionManager.listPublic(), ...extensionManager.listShadowedPublic()]);
    } catch (err) {
      logger.error('[Extensions] Failed to list extensions', err);
      return c.json({ error: 'Failed to list extensions' }, 500);
    }
  });

  // POST /api/extensions/:id/enable -- Enable an extension
  router.post('/:id/enable', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      // Identity before the state of the world, matching the order the tunnel
      // and approval routes use: a caller that may not do this at all is told
      // so, rather than being told whether the extension exists.
      const refused = refusedNotAPerson(c, EXTENSION_TOGGLE_BAR);
      if (refused) return refused;
      const result = await extensionManager.enable(id);
      if (!result) {
        return c.json({ error: `Extension '${id}' not found or cannot be enabled` }, 404);
      }

      await activity?.emit({
        // Always the person today — the bar above refuses anything that named
        // itself an agent — and read from the caller anyway, so this router has
        // exactly one way of saying who acted and no route can drift back to
        // asserting it.
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_installed',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: result.extension.manifest.name,
        summary: `Installed extension ${result.extension.manifest.name}`,
      });

      // Apply live across all connected clients — the bundle is already compiled
      // (enable() awaits it), so clients hot-load the extension's contributions
      // via the SSE `extension_reloaded` handler instead of requiring a page reload.
      broadcastExtensionReloaded([id]);

      return c.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to enable ${id}`, err);
      return c.json({ error: 'Failed to enable extension' }, 500);
    }
  });

  // POST /api/extensions/:id/disable -- Disable an extension
  router.post('/:id/disable', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      // Barred in this direction too, unlike `POST /api/tunnel/stop`, which runs
      // nothing because stopping only narrows exposure. `operator-only` is a rule
      // about PATHS and never about values (`config-write-policy.ts`, pinned by
      // its own drift guard), and silently switching off the extension somebody's
      // work depends on is not a favour. The approval routes beside this one gate
      // `revoke` for the same reason.
      const refused = refusedNotAPerson(c, EXTENSION_TOGGLE_BAR);
      if (refused) return refused;
      const result = await extensionManager.disable(id);
      if (!result) {
        // `disable()` returns null for two distinct reasons: the extension does
        // not exist, OR it exists but is a required core extension
        // (`canDisable: false`). Distinguish them so the client gets an honest
        // status — 409 Conflict for "exists but forbidden", not a misleading 404.
        if (extensionManager.get(id)) {
          return c.json({ error: `Extension '${id}' is required and cannot be disabled` }, 409);
        }
        return c.json({ error: `Extension '${id}' not found` }, 404);
      }

      await activity?.emit({
        // Person-barred like `/enable`, and read from the caller for the same
        // reason.
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_removed',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: result.extension.manifest.name,
        summary: `Removed extension ${result.extension.manifest.name}`,
      });

      // Apply live across all connected clients — the SSE `extension_reloaded`
      // handler deactivates the extension and removes its contributions in place,
      // so disabling takes effect without a page reload.
      broadcastExtensionReloaded([id]);

      return c.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to disable ${id}`, err);
      return c.json({ error: 'Failed to disable extension' }, 500);
    }
  });

  // POST /api/extensions/:id/init-server -- Initialize server-side extension
  router.post('/:id/init-server', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const result = await extensionManager.initializeServer(id);
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to init server for ${id}`, err);
      return c.json({ error: 'Failed to initialize server extension' }, 500);
    }
  });

  // POST /api/extensions/reload -- Re-scan filesystem and recompile changed
  //
  // The scan reads every known project, so it runs after this answers: the
  // reply is the list as it stands, and clients hear what the scan changed
  // from the `extension_reloaded` broadcast.
  router.post('/reload', (c) => {
    try {
      extensionManager.requestRefresh();
      return c.json(extensionManager.listPublic());
    } catch (err) {
      logger.error('[Extensions] Failed to reload extensions', err);
      return c.json({ error: 'Failed to reload extensions' }, 500);
    }
  });

  // POST /api/extensions/cwd-changed -- Notify server that the active CWD changed
  router.post('/cwd-changed', async (c) => {
    try {
      const parsed = CwdChangedBodySchema.safeParse(readJsonBody(c));
      if (!parsed.success) return validationFailed(c, parsed.error);

      const diff = await extensionManager.updateCwd(parsed.data.cwd);
      const changed = diff.added.length > 0 || diff.removed.length > 0;
      if (changed) {
        logger.info(
          `[Extensions] CWD changed: +${diff.added.length} -${diff.removed.length} extensions`
        );
      }
      return c.json({ changed, added: diff.added, removed: diff.removed });
    } catch (err) {
      logger.error('[Extensions] Failed to handle CWD change', err);
      return c.json({ error: 'Failed to handle CWD change' }, 500);
    }
  });

  // GET /api/extensions/:id/bundle -- Serve compiled JS bundle
  router.get('/:id/bundle', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const bundle = await extensionManager.readBundle(id);
      if (!bundle) return c.json({ error: `Bundle not available for '${id}'` }, 404);
      return c.body(bundle, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      logger.error(`[Extensions] Failed to serve bundle for ${id}`, err);
      return c.json({ error: 'Failed to serve bundle' }, 500);
    }
  });

  // GET /api/extensions/:id/data -- Read extension's persistent data
  router.get('/:id/data', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const dataPath = resolveBlobPath(id, extensionManager, dorkHome, getCwd);
      if (!dataPath) return c.json({ error: `Extension '${id}' not found` }, 404);

      try {
        const data = await fs.readFile(dataPath, 'utf-8');
        return c.json(JSON.parse(data));
      } catch {
        // No data file -- return 204 No Content
        return c.body(null, 204);
      }
    } catch (err) {
      logger.error(`[Extensions] Failed to read data for ${id}`, err);
      return c.json({ error: 'Failed to read extension data' }, 500);
    }
  });

  // PUT /api/extensions/:id/data -- Write extension's persistent data
  //
  // Bound to the caller (DOR-3066): an extension may write its own blob only,
  // and a write with no extension stamp needs a person or an agent
  // (`extension-write-binding.ts`).
  //
  // **Deliberately writes no Activity, unlike every other write on this router**
  // (DOR-1829 considered it and declined). The secrets and settings routes each
  // record one line per deliberate act by a person or an agent. This one is the
  // extension API's `saveData`, called by extension CODE at whatever rate that
  // code likes: the shipped `hello-world` extension writes its visit counter on
  // every single activation, so an unconditional emit here would put a row in the
  // operator's feed each time they open a page. A feed nobody can read is worth
  // less than a quieter one, and the write itself is bounded — the data lands
  // under the extension's own scope-resolved directory.
  // If this ever needs recording, it needs collapsing (one line per extension per
  // window) rather than one line per call, and that is its own piece of work.
  router.put('/:id/data', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const dataPath = resolveBlobPath(id, extensionManager, dorkHome, getCwd);
      if (!dataPath) return c.json({ error: `Extension '${id}' not found` }, 404);

      await writeFileAtomic(dataPath, JSON.stringify(readJsonBody(c), null, 2));
      return c.json({ ok: true }, 200);
    } catch (err) {
      logger.error(`[Extensions] Failed to write data for ${id}`, err);
      return c.json({ error: 'Failed to write extension data' }, 500);
    }
  });

  // GET /api/extensions/:id/secrets -- List declared secrets with isSet status (never returns values)
  router.get('/:id/secrets', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);

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
      return c.json(result);
    } catch (err) {
      logger.error(`[Extensions] Failed to list secrets for ${id}`, err);
      return c.json({ error: 'Failed to list secrets' }, 500);
    }
  });

  // PUT /api/extensions/:id/secrets/:key -- Set a secret value (write-only)
  router.put('/:id/secrets/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const parsed = SetSecretBodySchema.safeParse(readJsonBody(c));
      if (!parsed.success) return validationFailed(c, parsed.error);

      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);

      // Validate key is declared in manifest
      const declared = record.manifest.serverCapabilities?.secrets ?? [];
      if (!declared.some((s) => s.key === key)) {
        return c.json({ error: `Secret '${key}' not declared in extension manifest` }, 400);
      }

      const store = new ExtensionSecretStore(id, dorkHome);
      await store.set(key, parsed.data.value);

      await activity?.emit({
        // No person bar on this route, so this genuinely varies: an agent that
        // identified itself is named, and the feed stops crediting the person
        // with a machine's write (DOR-1801).
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: record.manifest.name,
        summary: `Updated secret "${key}" for extension ${record.manifest.name}`,
      });

      return c.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to set secret for ${id}`, err);
      return c.json({ error: 'Failed to set secret' }, 500);
    }
  });

  // DELETE /api/extensions/:id/secrets/:key -- Remove a secret
  router.delete('/:id/secrets/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);

      const store = new ExtensionSecretStore(id, dorkHome);
      // Asked BEFORE the delete, because `delete` is idempotent and says nothing
      // about whether anything was there. A feed line reading "Removed secret X"
      // for a secret that was never set is the same small lie this route family
      // was fixed for in DOR-1801 — one about the verb rather than the actor.
      const wasSet = await store.has(key);
      await store.delete(key);

      if (wasSet) {
        await activity?.emit({
          // Ungated like its `PUT` twin, and attributed the same way (DOR-1829).
          ...readActivityActor(honoRequestFacts(c)),
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: record.manifest.name,
          summary: `Removed secret "${key}" from extension ${record.manifest.name}`,
        });
      }

      return c.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to delete secret for ${id}`, err);
      return c.json({ error: 'Failed to delete secret' }, 500);
    }
  });

  // GET /api/extensions/:id/settings -- List declared settings with current values
  router.get('/:id/settings', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);

      const declared = record.manifest.serverCapabilities?.settings ?? [];
      const store = new ExtensionSettingsStore(dorkHome, id);
      const stored = await store.getAll();

      return c.json(
        declared.map((s) => {
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
        })
      );
    } catch (err) {
      logger.error(`[Extensions] Failed to list settings for ${id}`, err);
      return c.json({ error: 'Failed to list settings' }, 500);
    }
  });

  // PUT /api/extensions/:id/settings/:key -- Store a setting value
  router.put('/:id/settings/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const parsed = SetSettingBodySchema.safeParse(readJsonBody(c));
      if (!parsed.success) return validationFailed(c, parsed.error);

      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);

      // Validate key is declared in manifest
      const declared = record.manifest.serverCapabilities?.settings ?? [];
      if (!declared.some((s) => s.key === key)) {
        return c.json({ error: `Setting '${key}' not declared in extension manifest` }, 400);
      }

      const store = new ExtensionSettingsStore(dorkHome, id);
      await store.set(key, parsed.data.value);

      await activity?.emit({
        // Ungated like the secrets route beside it, and attributed the same way.
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: record.manifest.name,
        summary: `Updated setting "${key}" for extension ${record.manifest.name}`,
      });

      return c.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to set setting for ${id}`, err);
      return c.json({ error: 'Failed to set setting' }, 500);
    }
  });

  // DELETE /api/extensions/:id/settings/:key -- Reset setting to default
  router.delete('/:id/settings/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return c.json(INVALID_ID, 400);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);

      const store = new ExtensionSettingsStore(dorkHome, id);
      // Read first, for the reason the secrets route above states: resetting a
      // setting that was already at its default changed nothing, and a feed that
      // reports it is padding.
      const hadStoredValue = (await store.get(key)) !== null;
      await store.delete(key);

      if (hadStoredValue) {
        await activity?.emit({
          // Ungated like its `PUT` twin, and attributed the same way (DOR-1829).
          ...readActivityActor(honoRequestFacts(c)),
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: record.manifest.name,
          summary: `Reset setting "${key}" to its default for extension ${record.manifest.name}`,
        });
      }

      return c.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to delete setting for ${id}`, err);
      return c.json({ error: 'Failed to delete setting' }, 500);
    }
  });

  registerExtensionApprovalRoutes(router, extensionManager, SAFE_EXT_ID, activity);
  registerTrustedSourceRoutes(router, extensionManager, activity);
  registerExtensionInboxRoutes(router, extensionManager, dorkHome, SAFE_EXT_ID, activity);
  registerExtensionStartWorkRoute(router, extensionManager, SAFE_EXT_ID);
  registerExtensionRoomRoutes(router, extensionManager, SAFE_EXT_ID);

  return router;
}
