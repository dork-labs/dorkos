import { Router } from 'express';
import path from 'path';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getBoundary } from '../lib/boundary.js';
import { scenarioStore } from '../services/runtimes/test-mode/scenario-store.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

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
  };
  const agentDir = e2eAgentDir();
  await writeManifest(agentDir, manifest);
  res.json({ ok: true, agentDir });
});
