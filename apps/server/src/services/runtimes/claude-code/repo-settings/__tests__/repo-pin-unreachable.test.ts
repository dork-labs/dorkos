/**
 * Only a launch raises a repo-pin card (DOR-3359, Security #dorkos 11:27 Oct 27):
 * no MCP tool, no `request_permission`, no capability route and no test seed
 * an agent can reach may create an approval under either repo-pin id, because
 * a card there carries a server-built title and a "trust this repo" answer.
 *
 * Every agent-reachable path resolves what it asks about through the capability
 * registry. The repo-pin ids are described for the card by a fallback, never
 * registered, so each path finds nothing and refuses. The test seed route,
 * which takes any id as a string, refuses them by name.
 *
 * @vitest-environment node
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { findRequestedAction } from '../../../../core/permissions/permission-capabilities.js';
import { createCapabilitiesInvokeRoutes } from '../../../../../routes/capabilities-invoke.js';
import { createTestControlRoutes } from '../../../../../routes/test-control.js';
import {
  REPO_CONFIG_CAPABILITY_IDS,
  REPO_TOOLS_CAPABILITY_ID,
  isRepoPinCapabilityId,
} from '../repo-config-approval.js';

const PIN_IDS = [REPO_CONFIG_CAPABILITY_IDS.hooks, REPO_TOOLS_CAPABILITY_ID];

describe('a repo-pin card is raised only by a launch', () => {
  const registry = composeCapabilityRegistryForDocs();

  it.each(PIN_IDS)('%s is not a capability anyone can invoke', (id) => {
    expect(registry.get(id)).toBeUndefined();
    // No MCP tool is named after it either, under any prefix.
    const bare = id.split('.').pop()!;
    expect(
      registry.capabilities.filter((capability) => capability.surfaces.mcp?.toolName === bare)
    ).toEqual([]);
  });

  it.each(PIN_IDS)('request_permission cannot name %s on any surface', (id) => {
    for (const surface of [null, 'in-session', 'external'] as const) {
      expect(findRequestedAction(registry, id, surface)).toBeUndefined();
      expect(findRequestedAction(registry, `mcp__dorkos__${id}`, surface)).toBeUndefined();
    }
  });

  it.each(PIN_IDS)('the capability route refuses %s before anything runs', async (id) => {
    const app = new Hono().route('/api/capabilities', createCapabilitiesInvokeRoutes(registry));
    const res = await app.request(`/api/capabilities/${id}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'UNKNOWN_CAPABILITY' });
  });

  /** Seed one card through the test route, as the app's chain would parse it. */
  async function seed(capabilityId: string) {
    const request = vi.fn(() => ({ approvalId: 'a', token: 't', expiresAt: '' }));
    const app = new Hono<{ Variables: { body: unknown } }>();
    app.use('*', async (c, next) => {
      c.set('body', await c.req.json());
      await next();
    });
    app.route(
      '/api/test',
      createTestControlRoutes({
        approvals: () => ({ request }) as never,
        meshCore: () => ({ getByPath: () => ({ name: 'ops' }) }) as never,
      }) as never
    );
    const res = await app.request('/api/test/seed-approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilityId, agentPath: '/a', area: 'rooms', summary: 's' }),
    });
    return { status: res.status, request };
  }

  it('control: the test seed route raises a card for an ordinary capability', async () => {
    const { status, request } = await seed('rooms.create');
    expect(status).toBe(200);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(PIN_IDS)('the test seed route refuses %s and raises nothing', async (id) => {
    const { status, request } = await seed(id);
    expect(status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it('knows exactly the two repo-pin ids', () => {
    expect(PIN_IDS.every(isRepoPinCapabilityId)).toBe(true);
    expect(isRepoPinCapabilityId(REPO_CONFIG_CAPABILITY_IDS.local)).toBe(false);
    expect(isRepoPinCapabilityId(REPO_CONFIG_CAPABILITY_IDS.mcpJson)).toBe(false);
  });
});
