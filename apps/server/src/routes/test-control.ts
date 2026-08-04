import { Router } from 'express';
import path from 'path';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getBoundary } from '../lib/boundary.js';
import { scenarioStore } from '../services/runtimes/test-mode/scenario-store.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { getRoomService, getBridgeStore, getRoomAuthors } from '../services/rooms/index.js';
import { readOwnerAccount } from '../services/core/auth/index.js';

/**
 * Control routes for TestModeRuntime. Only mounted when DORKOS_TEST_RUNTIME=true.
 * Returns 404 for any /api/test/* path in production (route not registered).
 */
export const testControlRouter = Router();

const scenarioSchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

testControlRouter.post('/scenario', (req, res) => {
  const result = scenarioSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  const { name, sessionId } = result.data;
  try {
    if (sessionId) {
      scenarioStore.setForSession(sessionId, name);
    } else {
      scenarioStore.setDefault(name);
    }
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
  res.json({ ok: true, scenario: name });
});

testControlRouter.post('/reset', async (_req, res) => {
  scenarioStore.reset();
  // Dynamic import keeps TestModeRuntime out of production module graphs:
  // app.ts mounts this router conditionally but imports it statically, so a
  // static class import here would defeat the index.ts env-var gating. The
  // try/catch shapes an import failure into this route's own 500 with the real
  // message. It is not what keeps the request from hanging: Express 5 forwards a
  // rejected handler promise to the error handler on its own (Express 4, which
  // this comment used to name, did not — there the catch was load-bearing).
  try {
    const { TestModeRuntime } = await import('../services/runtimes/test-mode/test-mode-runtime.js');
    // Reset EVERY test-mode instance, not just the default 'test-mode' type —
    // a DORKOS_TEST_RUNTIME_SECONDARY server registers a second instance
    // ('test-mode-b') whose tracked sessions would otherwise leak across
    // tests. This router is only mounted when DORKOS_TEST_RUNTIME=true, so at
    // least one instance is always registered.
    for (const runtime of runtimeRegistry.listRuntimes()) {
      if (runtime instanceof TestModeRuntime) runtime.resetTrackedSessions();
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Reset failed' });
  }
  res.json({ ok: true });
});

/**
 * The local no-op "sign-in" page the test-mode connector provider's authorize
 * URLs point at (`services/connectors/providers/test-mode.ts`). A real vendor
 * consent screen is exactly what the e2e must NOT depend on, but the browser
 * still clicks a real link that opens a real tab — this page is where it lands.
 * Connect flows in test mode succeed on poll regardless; nothing here records
 * anything.
 */
testControlRouter.get('/connect-approved', (_req, res) => {
  res
    .type('html')
    .send(
      '<!doctype html><html><head><title>Signed in</title></head>' +
        '<body><main><h1>Signed in</h1><p>You can close this tab and go back to DorkOS.</p></main></body></html>'
    );
});

/**
 * Fixture directory for the seeded test agent, derived from the RESOLVED
 * directory boundary so it is in-bounds by construction.
 *
 * It used to be spelled `os.homedir()/tmp/dorkos-e2e-agent`, which was in-bounds
 * only by coincidence: an unconfigured boundary happens to default to the home
 * directory. Under a configured `DORKOS_BOUNDARY` (the Docker deployment) that
 * seeded an agent outside the boundary, which every cockpit surface would then
 * refuse — and it reached into the operator's real home to do it, which
 * `os.homedir()` is banned in server code for (Hard Rule 3).
 *
 * `getBoundary()` returns a realpath-resolved root, so the path handed back is
 * already canonical — the same form `validateBoundary()` normalizes to before
 * it checks containment. Under an unconfigured boundary that need not be the
 * literal `~/...` string the old constant produced (a symlinked home resolves
 * through), but it names the same directory and is the more robust of the two.
 *
 * Resolved per request rather than at module load: `app.ts` imports this router
 * statically, which runs before `initBoundary()` does at startup.
 */
function e2eAgentDir(): string {
  return path.join(getBoundary(), 'tmp', 'dorkos-e2e-agent');
}

/**
 * Seed a test agent at a fixed path inside the directory boundary.
 * Overwrites any existing manifest so tests always start with a clean agent.
 * Returns { agentDir } so the test can navigate to /?dir=<agentDir>.
 */
testControlRouter.post('/seed-agent', async (_req, res) => {
  const manifest: AgentManifest = {
    id: ulid(),
    name: 'E2E Test Agent',
    description: 'Seeded by test setup — uses TestModeRuntime',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-e2e',
    personaEnabled: false,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
  };
  const agentDir = e2eAgentDir();
  await writeManifest(agentDir, manifest);
  res.json({ ok: true, agentDir });
});

const seedBridgeSchema = z.object({
  /** The bound agent's directory, from `POST /api/test/seed-agent`. */
  agentPath: z.string().min(1),
});

/**
 * Seed a bridged **channel** — the platform faked one layer up, at the adapter
 * boundary, so there is no grammY `Bot` and no live Telegram (the same fake the
 * server-side integration suite uses). It mints the room and its `room_bridges`
 * row through the real `RoomService.createBridgedRoom`, stamps a
 * `mentions-only` visibility so the header badge renders, and writes one
 * external-author entry through the real `postExternal` so an origin mark
 * renders beside a message from outside the machine. The e2e (`tests/relay/
 * bridged-channel.spec.ts`) then drives the cockpit-observable half: see the
 * badge and the mark, post from the composer, watch the post land.
 *
 * Only reachable under `DORKOS_TEST_RUNTIME` (this whole router is), and it
 * uses a fresh chat id per call so re-runs never collide on the bridge's
 * `(adapterId, chatId)` unique index.
 */
testControlRouter.post('/seed-bridge', async (req, res) => {
  const result = seedBridgeSchema.safeParse(req.body);
  if (!result.success) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: z.flattenError(result.error) });
  }
  try {
    // Register the seeded agent into the mesh cache so the room roster can
    // resolve it by path (ADR-0043's file-first write-through). `seed-agent`
    // only writes the manifest to disk; the cockpit normally syncs on its own
    // navigation, which this seam does not go through.
    const meshCore = req.app.locals.meshCore as
      | { syncFromDisk(path: string): Promise<unknown> }
      | undefined;
    if (meshCore) await meshCore.syncFromDisk(result.data.agentPath);

    const rooms = getRoomService();
    const bridges = getBridgeStore();
    // The operator is the install owner when there is one (onboarding creates
    // it), and the unbound local human otherwise — the same resolution the
    // production bridge lifecycle uses, so `createBridgedRoom`'s owner check
    // passes on a real (onboarded) server the same way it does in prod.
    const authors = getRoomAuthors();
    const owner = readOwnerAccount();
    const operatorAuthorId = owner ? authors.bindOwner(owner.id).id : authors.localHuman().id;
    const adapterId = 'tg-e2e';
    const chatId = ulid();

    const opened = rooms.createBridgedRoom({
      adapterId,
      chatId,
      bindingId: `bind-e2e-${chatId}`,
      chatType: 'group',
      channelType: 'group',
      title: 'E2E Ops Channel',
      agentPath: result.data.agentPath,
      operatorAuthorId,
    });

    // §8: the header badge reads the bridge row's visibility, sourced from the
    // platform's `getMe` in production — stamped directly here.
    bridges.setVisibility(opened.id, 'mentions-only', new Date().toISOString());

    // One message from outside the machine, so an origin mark ("· Telegram")
    // renders. `postExternal` mints the external author on the `platform:` key
    // that carries the origin (spec §4.3).
    rooms.postExternal(opened.id, {
      identity: {
        platformType: 'telegram',
        instanceId: adapterId,
        platformUserId: '145223',
        displayName: 'Miguel',
      },
      text: 'Hi from Telegram — can the team see this?',
    });

    res.json({ ok: true, roomId: opened.id, slug: opened.slug, chatId });
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'seed-bridge failed' });
  }
});
