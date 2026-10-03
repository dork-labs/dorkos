import type { Request, Response } from 'express';
import { registerExtensionStorageRoutes } from './extensions-storage.js';
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
 * `~/.dork/config.json` — so an agent may legitimately write them. Every route
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
import { Router } from 'express';

import { z } from 'zod';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { eventFanOut } from '../services/core/event-fan-out.js';

import { readActivityActor } from '../services/activity/activity-actor.js';
import { registerExtensionApprovalRoutes } from './extensions-approval.js';
import { registerTrustedSourceRoutes } from './extensions-trusted-sources.js';
import { registerExtensionInboxRoutes } from './extensions-inbox.js';
import { registerExtensionStartWorkRoute } from './extensions-start-work.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';

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

  registerDiscoveryRoutes(router, { extensionManager, dorkHome, getCwd });

  // POST /api/extensions/:id/disable -- Disable an extension
  router.post('/:id/disable', (req, res) =>
    handleExtensionRoute4({ extensionManager, dorkHome, getCwd }, req, res)
  );

  // POST /api/extensions/:id/init-server -- Initialize server-side extension
  router.post('/:id/init-server', (req, res) =>
    handleExtensionRoute5({ extensionManager, dorkHome, getCwd }, req, res)
  );

  // POST /api/extensions/reload -- Re-scan filesystem and recompile changed
  //
  // The scan reads every known project, so it runs after this answers: the
  // reply is the list as it stands, and clients hear what the scan changed
  // from the `extension_reloaded` broadcast.
  router.post('/reload', (_req, res) =>
    handleExtensionRoute6({ extensionManager, dorkHome, getCwd }, _req, res)
  );

  // POST /api/extensions/cwd-changed -- Notify server that the active CWD changed
  router.post('/cwd-changed', (req, res) =>
    handleExtensionRoute7({ extensionManager, dorkHome, getCwd }, req, res)
  );

  // GET /api/extensions/:id/bundle -- Serve compiled JS bundle
  router.get('/:id/bundle', (req, res) =>
    handleExtensionRoute8({ extensionManager, dorkHome, getCwd }, req, res)
  );
  registerExtensionStorageRoutes(router, {
    extensionManager,
    dorkHome,
    getCwd,
    safeExtId: SAFE_EXT_ID,
  });

  registerExtensionApprovalRoutes(router, extensionManager, SAFE_EXT_ID);
  registerTrustedSourceRoutes(router, extensionManager);
  registerExtensionInboxRoutes(router, extensionManager, dorkHome, SAFE_EXT_ID);
  registerExtensionStartWorkRoute(router, extensionManager, SAFE_EXT_ID);

  return router;
}

type RouteContext = {
  extensionManager: ExtensionManager;
  dorkHome: string;
  getCwd: () => string | null;
};
function handleExtensionRoute1(context: RouteContext, _req: Request, res: Response) {
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
}
async function handleExtensionRoute2(context: RouteContext, _req: Request, res: Response) {
  const { extensionManager } = context;

  try {
    const extensions = await extensionManager.readPublic({ includeShadowed: true });
    res.json(extensions);
  } catch (err) {
    logger.error('[Extensions] Failed to list extensions', err);
    res.status(500).json({ error: 'Failed to list extensions' });
  }
}
async function handleExtensionRoute3(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager } = context;

  try {
    const { id } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    // Identity before the state of the world, matching the order the tunnel
    // and approval routes use: a caller that may not do this at all is told
    // so, rather than being told whether the extension exists.
    if (refuseIfNotAPerson(req, res, EXTENSION_TOGGLE_BAR)) return undefined;
    const result = await extensionManager.enable(id);
    if (!result) {
      return res.status(404).json({ error: `Extension '${id}' not found or cannot be enabled` });
    }

    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      await activityService.emit({
        // Always the person today — the bar above refuses anything that named
        // itself an agent — and read from the caller anyway, so this router has
        // exactly one way of saying who acted and no route can drift back to
        // asserting it.
        ...readActivityActor(req, res),
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
}
async function handleExtensionRoute4(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager } = context;

  try {
    const { id } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    // Barred in this direction too, unlike `POST /api/tunnel/stop`, which runs
    // nothing because stopping only narrows exposure. `operator-only` is a rule
    // about PATHS and never about values (`config-write-policy.ts`, pinned by
    // its own drift guard), and silently switching off the extension somebody's
    // work depends on is not a favour. The approval routes beside this one gate
    // `revoke` for the same reason.
    if (refuseIfNotAPerson(req, res, EXTENSION_TOGGLE_BAR)) return undefined;
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

    await emitExtensionRemoval(req, res, result);

    // Apply live across all connected clients — the SSE `extension_reloaded`
    // handler deactivates the extension and removes its contributions in place,
    // so disabling takes effect without a page reload.
    broadcastExtensionReloaded([id]);

    res.json(result);
  } catch (err) {
    logger.error(`[Extensions] Failed to disable ${req.params.id}`, err);
    res.status(500).json({ error: 'Failed to disable extension' });
  }
}
async function handleExtensionRoute5(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager } = context;

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
}
async function handleExtensionRoute6(context: RouteContext, _req: Request, res: Response) {
  const { extensionManager } = context;

  try {
    extensionManager.requestRefresh();
    res.json(await extensionManager.readPublic());
  } catch (err) {
    logger.error('[Extensions] Failed to reload extensions', err);
    res.status(500).json({ error: 'Failed to reload extensions' });
  }
}
async function handleExtensionRoute7(context: RouteContext, req: Request, res: Response) {
  const { extensionManager } = context;

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
}
async function handleExtensionRoute8(
  context: RouteContext,
  req: Request<{ id: string }>,
  res: Response
) {
  const { extensionManager } = context;

  try {
    const { id } = req.params;
    if (!SAFE_EXT_ID.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    const parsed = z
      .object({ generation: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bundle generation' });
    const bundle = await extensionManager.readBundle(id, parsed.data.generation);
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
}

function registerDiscoveryRoutes(router: Router, context: RouteContext): void {
  const { extensionManager, dorkHome, getCwd } = context;
  // GET /api/extensions/events -- SSE stream for extension lifecycle events
  router.get('/events', (_req, res) =>
    handleExtensionRoute1({ extensionManager, dorkHome, getCwd }, _req, res)
  );

  // GET /api/extensions -- List all discovered extensions with status: every
  // copy that runs, then each older copy a newer one of the same trusted
  // source shadows, with `shadowedBy` set (spec `flow-multiproject` §9.2).
  router.get('/', (_req, res) =>
    handleExtensionRoute2({ extensionManager, dorkHome, getCwd }, _req, res)
  );

  // POST /api/extensions/:id/enable -- Enable an extension
  router.post('/:id/enable', (req, res) =>
    handleExtensionRoute3({ extensionManager, dorkHome, getCwd }, req, res)
  );
}

async function emitExtensionRemoval(
  req: Request<{ id: string }>,
  res: Response,
  result: NonNullable<Awaited<ReturnType<ExtensionManager['disable']>>>
): Promise<void> {
  const id = req.params.id;
  const activityService = req.app.locals.activityService as ActivityService | undefined;
  if (activityService) {
    await activityService.emit({
      // Person-barred like `/enable`, and read from the caller for the same
      // reason.
      ...readActivityActor(req, res),
      category: 'config',
      eventType: 'config.extension_removed',
      resourceType: 'extension',
      resourceId: id,
      resourceLabel: result.extension.manifest.name,
      summary: `Removed extension ${result.extension.manifest.name}`,
    });
  }
}
