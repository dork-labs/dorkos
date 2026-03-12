import { Router } from 'express';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { scenarioStore } from '../services/runtimes/test-mode/scenario-store.js';

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
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
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

testControlRouter.post('/reset', (_req, res) => {
  scenarioStore.reset();
  res.json({ ok: true });
});

// Fixed agent directory within the home directory (always within the default boundary).
const E2E_AGENT_DIR = path.join(os.homedir(), 'tmp', 'dorkos-e2e-agent');

/**
 * Seed a test agent at a fixed path within the home directory boundary.
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
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-e2e',
    personaEnabled: false,
    enabledToolGroups: {},
  };
  await writeManifest(E2E_AGENT_DIR, manifest);
  res.json({ ok: true, agentDir: E2E_AGENT_DIR });
});
