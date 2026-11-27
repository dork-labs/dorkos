/**
 * Extension management routes -- discovery, enable/disable, bundle serving, and data storage.
 *
 * The two WRITE routes here (`/:id/enable`, `/:id/disable`) run the same person
 * bar as the approval routes mounted alongside them, because they move the same
 * `operator-only` config section; restarting and removing one are capabilities
 * the mount serves behind that bar (`services/extensions/http-capabilities/`,
 * DOR-4978) — see
 * {@link module:routes/extensions-person-bar} for the three bars, the residual
 * they leave in the login-off posture, and why the narrowing direction is barred
 * too (DOR-1507).
 *
 * The secrets and settings routes are NOT behind that bar — they hold an
 * extension's own per-extension data rather than a leaf of `extensions` in
 * `~/.dork/config.json` — so an agent may legitimately write them. They, and
 * the data route, are bound to the caller instead (DOR-3066,
 * {@link module:routes/extension-write-binding}). A person setting a secret
 * waits for the owner to confirm it's them (DOR-4355); an agent's goes on, and
 * removing one stays immediate. Every route
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
import { noteStepUpRisksBeforeServing } from '../services/extensions/step-up/step-up-extension-risk.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { registerExtensionApprovalRoutes } from './extensions-approval.js';
import { registerExtensionStepUpRoutes } from './extensions-step-up.js';
import { registerTrustedSourceRoutes } from './extensions-trusted-sources.js';
import { registerExtensionInboxRoutes } from './extensions-inbox.js';
import { registerExtensionStartWorkRoute } from './extensions-start-work.js';
import { registerExtensionRoomRoutes } from './extensions-rooms.js';
import { registerExtensionPrefsRoutes } from './extensions-prefs.js';
import { liveForwardDeps, registerExtensionForwardRoutes } from './extensions-forward.js';
import type { PersonForwardDeps } from '../services/extensions/forward/person-forward.js';
import { refusedNotAPerson } from './extensions-person-bar.js';
import { answerExtensionList } from '../services/extensions/listing/extension-list-pages.js';
import {
  EXTENSION_TOGGLE_BAR,
  SAFE_EXT_ID,
} from '../services/extensions/http-capabilities/extension-door-words.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { markedExtensionSecretRefusal } from './extension-secret-agent-gate.js';

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
  /** Mesh, when it is running: the agent a mini app forwards to (DOR-3325). */
  mesh?: PersonForwardDeps['mesh'];
}

/** The answer for an id outside {@link SAFE_EXT_ID}. */
const invalidId = (c: Context<ApiEnv>) =>
  problem(c, 'invalid_request', { detail: 'Use an extension id in lowercase, like my-extension.' });

/** The answer for an extension this computer does not have. */
const noSuchExtension = (c: Context<ApiEnv>, id: string) =>
  problem(c, 'not_found', { detail: `No extension named ${id} is installed.` });

/** A server fault, said in a sentence: what failed, and to try again. */
const failed = (c: Context<ApiEnv>, what: string) =>
  problem(c, 'internal_error', { detail: `Couldn’t ${what}. Try again.` });

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

  // GET /api/extensions -- Every discovered extension, a page at a time (DOR-4982;
  // the order: `services/extensions/listing/extension-list-pages.ts`).
  router.get('/', async (c) => {
    try {
      return await answerExtensionList(c, extensionManager);
    } catch (err) {
      logger.error('[Extensions] Failed to list extensions', err);
      return failed(c, 'list extensions');
    }
  });

  // POST /api/extensions/:id/enable -- Enable an extension
  router.post('/:id/enable', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      // Identity before the state of the world, matching the order the tunnel
      // and approval routes use: a caller that may not do this at all is told
      // so, rather than being told whether the extension exists.
      const refused = refusedNotAPerson(c, EXTENSION_TOGGLE_BAR);
      if (refused) return refused;
      // The same lasting setting `PATCH /api/config` holds for `extensions.enabled` (DOR-4355).
      return await runFrontDoorWrite(c, {
        kind: 'extensions.enable',
        target: id,
        input: {},
        reason: `Turn on the extension ${id}.`,
        subject: 'which extensions run',
        run: () => enableExtension(c, id),
      });
    } catch (err) {
      logger.error(`[Extensions] Failed to enable ${id}`, err);
      return failed(c, 'turn the extension on');
    }
  });

  /** Turn one extension on, once its bars and confirmation have passed. */
  async function enableExtension(c: Context<ApiEnv>, id: string): Promise<Response> {
    try {
      const result = await extensionManager.enable(id);
      if (!result) {
        return problem(c, 'not_found', { detail: `No extension named ${id} can be turned on.` });
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
      return failed(c, 'turn the extension on');
    }
  }

  // POST /api/extensions/:id/disable -- Disable an extension
  router.post('/:id/disable', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
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
          return problem(c, 'conflict', { detail: `${id} is required, so it stays on.` });
        }
        return noSuchExtension(c, id);
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
      return failed(c, 'turn the extension off');
    }
  });

  // POST /api/extensions/:id/init-server -- Initialize server-side extension
  router.post('/:id/init-server', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      if (!extensionManager.get(id)) return noSuchExtension(c, id);
      const result = await extensionManager.initializeServer(id);
      if (!result.ok) {
        logger.warn(`[Extensions] ${id} did not start: ${result.error}`);
        return problem(c, 'upstream_unavailable', {
          detail: 'Its server didn’t start. Check Settings.',
        });
      }
      return c.json({ ok: true });
    } catch (err) {
      logger.error(`[Extensions] Failed to init server for ${id}`, err);
      return failed(c, 'start the extension’s server');
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
      return failed(c, 'reload extensions');
    }
  });

  // POST /api/extensions/cwd-changed -- Notify server that the active CWD changed
  router.post('/cwd-changed', async (c) => {
    try {
      const parsed = CwdChangedBodySchema.safeParse(readJsonBody(c));
      if (!parsed.success) return validationProblem(c, parsed.error);

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
      return failed(c, 'load this folder’s extensions');
    }
  });

  // GET /api/extensions/:id/bundle -- Serve compiled JS bundle
  router.get('/:id/bundle', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const bundle = await extensionManager.readBundle(id);
      if (!bundle)
        return problem(c, 'not_found', { detail: `${id} has no app to load. Reload extensions.` });
      // Code is entering a page: note its risk first, so a later clear is
      // remembered against every browser that loaded it (Security, M1 on
      // #3401). A reading that could not be kept serves nothing (DOR-4906).
      if (!noteStepUpRisksBeforeServing(id)) {
        return problem(c, 'temporarily_unavailable', {
          detail: 'Couldn’t load the extension. Try again.',
        });
      }
      return c.body(bundle, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      logger.error(`[Extensions] Failed to serve bundle for ${id}`, err);
      return failed(c, 'load the extension');
    }
  });

  // GET /api/extensions/:id/data -- Read extension's persistent data
  router.get('/:id/data', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const dataPath = resolveBlobPath(id, extensionManager, dorkHome, getCwd);
      if (!dataPath) return noSuchExtension(c, id);

      try {
        const data = await fs.readFile(dataPath, 'utf-8');
        return c.json(JSON.parse(data));
      } catch {
        // No data file -- return 204 No Content
        return c.body(null, 204);
      }
    } catch (err) {
      logger.error(`[Extensions] Failed to read data for ${id}`, err);
      return failed(c, 'read the extension’s data');
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
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const dataPath = resolveBlobPath(id, extensionManager, dorkHome, getCwd);
      if (!dataPath) return noSuchExtension(c, id);

      await writeFileAtomic(dataPath, JSON.stringify(readJsonBody(c), null, 2));
      return c.json({ ok: true }, 200);
    } catch (err) {
      logger.error(`[Extensions] Failed to write data for ${id}`, err);
      return failed(c, 'save the extension’s data');
    }
  });

  // GET /api/extensions/:id/secrets -- List declared secrets with isSet status (never returns values)
  router.get('/:id/secrets', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);

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
      return failed(c, 'list the extension’s secrets');
    }
  });

  // PUT /api/extensions/:id/secrets/:key -- Set a secret value (write-only)
  router.put('/:id/secrets/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const parsed = SetSecretBodySchema.safeParse(readJsonBody(c));
      if (!parsed.success) return validationProblem(c, parsed.error);

      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);

      // Validate key is declared in manifest
      const declared = record.manifest.serverCapabilities?.secrets ?? [];
      if (!declared.some((s) => s.key === key)) {
        return problem(c, 'invalid_request', {
          detail: `${id} doesn’t declare a secret named ${key}.`,
        });
      }

      const { value } = parsed.data;
      const run = async () => {
        await new ExtensionSecretStore(id, dorkHome).set(key, value);
        await activity?.emit({
          // No person bar on this route, so this genuinely varies: an agent that
          // identified itself is named, and the feed stops crediting the person
          // with a machine's write (DOR-1801). A held write is confirmed by the
          // same browser that asked, so the asking request names who acted.
          ...readActivityActor(honoRequestFacts(c)),
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: record.manifest.name,
          summary: `Updated secret "${key}" for extension ${record.manifest.name}`,
        });
        return c.json({ ok: true });
      };
      // An agent may still set one (DOR-1801); a person's waits for the owner (DOR-4355).
      // The value stays out of the held input, so the sheet never carries it.
      const caller = honoRequestFacts(c);
      // Not from a turn that read outside words, or an agent DorkOS can't name (Security S3).
      const marked = markedExtensionSecretRefusal(c);
      if (marked) return problem(c, 'forbidden', { detail: marked.error });
      if (caller.agentIdentity !== undefined) return await run();
      return await runFrontDoorWrite(c, {
        kind: 'extensions.secret',
        target: id,
        input: { key },
        reason: `Save the secret ${key} for the extension ${id}.`,
        subject: 'the secrets extensions hold',
        run: async () => {
          try {
            return await run();
          } catch (err) {
            logger.error(`[Extensions] Failed to set secret for ${id}`, err);
            return failed(c, 'save the secret');
          }
        },
      });
    } catch (err) {
      logger.error(`[Extensions] Failed to set secret for ${id}`, err);
      return failed(c, 'save the secret');
    }
  });

  // DELETE /api/extensions/:id/secrets/:key -- Remove a secret
  router.delete('/:id/secrets/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);

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
      return failed(c, 'delete the secret');
    }
  });

  // GET /api/extensions/:id/settings -- List declared settings with current values
  router.get('/:id/settings', async (c) => {
    const id = c.req.param('id');
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);

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
      return failed(c, 'list the extension’s settings');
    }
  });

  // PUT /api/extensions/:id/settings/:key -- Store a setting value
  router.put('/:id/settings/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const parsed = SetSettingBodySchema.safeParse(readJsonBody(c));
      if (!parsed.success) return validationProblem(c, parsed.error);

      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);

      // Validate key is declared in manifest
      const declared = record.manifest.serverCapabilities?.settings ?? [];
      if (!declared.some((s) => s.key === key)) {
        return problem(c, 'invalid_request', {
          detail: `${id} doesn’t declare a setting named ${key}.`,
        });
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
      return failed(c, 'save the setting');
    }
  });

  // DELETE /api/extensions/:id/settings/:key -- Reset setting to default
  router.delete('/:id/settings/:key', async (c) => {
    const { id, key } = c.req.param();
    try {
      if (!SAFE_EXT_ID.test(id)) return invalidId(c);
      const refused = refusedExtensionWrite(c, id);
      if (refused) return refused;
      const record = extensionManager.get(id);
      if (!record) return noSuchExtension(c, id);

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
      return failed(c, 'delete the setting');
    }
  });

  registerExtensionApprovalRoutes(router, extensionManager, SAFE_EXT_ID, activity);
  registerExtensionStepUpRoutes(router, {
    manager: extensionManager,
    dorkHome,
    safeId: SAFE_EXT_ID,
    activity,
  });
  registerTrustedSourceRoutes(router, extensionManager, activity);
  registerExtensionInboxRoutes(router, extensionManager, dorkHome, SAFE_EXT_ID, activity);
  registerExtensionStartWorkRoute(router, extensionManager, SAFE_EXT_ID);
  registerExtensionRoomRoutes(router, extensionManager, SAFE_EXT_ID);
  registerExtensionPrefsRoutes(router, {
    manager: extensionManager,
    dorkHome,
    getCwd,
    safeId: SAFE_EXT_ID,
  });
  registerExtensionForwardRoutes(router, extensionManager, SAFE_EXT_ID, liveForwardDeps(deps.mesh));
  return router;
}
