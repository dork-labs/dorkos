/**
 * In-session capability tools: attribution coverage (spec `agent-trust` §3.1).
 *
 * The in-session `dorkos` server is the PRIMARY way an agent actuates DorkOS —
 * `config_patch`, `update_agent`, `marketplace_install` all ride it. Unlike the
 * external `/mcp` surface it runs in process, so there is no request and no
 * `X-DorkOS-Agent` header to resolve; identity comes from the session's working
 * directory instead. These tests hold that path to the same attribution
 * guarantee as the HTTP one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';

import { ActivityService } from '../../../../activity/activity-service.js';
import {
  composeRegistry,
  defineCapability,
  type CapabilityRegistry,
} from '../../../../core/capabilities/index.js';
import {
  createCapabilityAttributionObserver,
  createInSessionContextResolver,
  initAgentIdentityService,
  resetAgentIdentityService,
  resolveAgentTokenEnv,
} from '../../../../core/agent-identity/index.js';
import { capabilityMcpTools } from '../capability-mcp-tools.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

/** A registry exposing one in-session capability, wired to the Activity feed. */
function buildRegistry(activityService: ActivityService): CapabilityRegistry {
  return composeRegistry(
    [
      {
        name: 'demo',
        capabilities: [
          defineCapability({
            id: 'demo.patch',
            title: 'Patch a setting',
            description: 'Patches.',
            tier: 'act',
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            surfaces: { mcp: { toolName: 'demo_patch', servers: ['in-session'] } },
            invoke: async () => ({ ok: true }),
          }),
        ],
      },
    ],
    { logger: noopLogger },
    createCapabilityAttributionObserver(activityService)
  );
}

/** Invoke the projected `demo_patch` tool exactly as the SDK would. */
async function callTool(registry: CapabilityRegistry, agentPath: string | undefined) {
  const [projected] = capabilityMcpTools(
    registry,
    'in-session',
    createInSessionContextResolver(agentPath)
  );
  return (
    projected as unknown as { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  ).handler({}, {});
}

describe('in-session capability attribution', () => {
  let db: Db;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    resetAgentIdentityService();
    db = createTestDb();
    registry = buildRegistry(new ActivityService(db));
  });

  afterEach(() => {
    resetAgentIdentityService();
    vi.restoreAllMocks();
  });

  /** Activity writes are fire-and-forget; let the microtask queue drain. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('attributes an in-session invocation to the agent whose session it is', async () => {
    initAgentIdentityService(db);
    // The spawn seam mints this agent's token; the in-session server then
    // derives identity from the session cwd, with no token round-trip.
    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    await callTool(registry, AGENT_PATH);
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'agent',
      actorId: AGENT_PATH,
      actorLabel: 'Researcher',
      category: 'agent',
      eventType: 'capability.invoked',
      resourceType: 'capability',
      resourceId: 'demo.patch',
      resourceLabel: 'Patch a setting',
    });
  });

  it('still returns the capability result to the agent', async () => {
    initAgentIdentityService(db);
    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    const result = (await callTool(registry, AGENT_PATH)) as {
      content: Array<{ text: string }>;
    };

    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  // ── Unattributed in-session calls stay exactly as they were ──────────────

  it('writes nothing when the session has no agent path', async () => {
    initAgentIdentityService(db);
    await resolveAgentTokenEnv(AGENT_PATH, 'Researcher');

    await callTool(registry, undefined);
    await flush();

    expect(db.select().from(activityEvents).all()).toHaveLength(0);
  });

  it('writes nothing when the agent holds no live token', async () => {
    initAgentIdentityService(db);

    await callTool(registry, '/projects/never-minted');
    await flush();

    expect(db.select().from(activityEvents).all()).toHaveLength(0);
  });

  it('writes nothing when identity is unavailable entirely', async () => {
    // No `initAgentIdentityService` — e.g. a unit-test harness with no database.
    await callTool(registry, AGENT_PATH);
    await flush();

    expect(db.select().from(activityEvents).all()).toHaveLength(0);
  });
});
