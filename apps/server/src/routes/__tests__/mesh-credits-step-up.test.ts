/** An agent’s lasting credits consent needs the owner’s per-action confirmation. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import { createMeshRoutes } from '../mesh.js';
import * as modelGate from '../../services/core/cloud/credits-model-gate.js';
import {
  creditsAllowedForAgent,
  setCreditsAllowedForAgent,
} from '../../services/core/cloud/credits-defaults.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('agent credits confirmation', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-credits-step-up-'));
  const file = path.join(home, '.dork', 'agent.json');
  const initial = {
    id: 'agent-1',
    name: 'Northwind',
    description: 'Check stock.',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-11-16T00:00:00Z',
    registeredBy: 'user',
  };
  let agent = { ...initial, account: null as string | null };
  const update = vi.fn(async (_id: string, fields: Record<string, unknown>) => {
    agent = { ...agent, ...fields };
    writeFileSync(file, JSON.stringify(agent));
    return agent;
  });
  const meshCore = {
    get: (id: string) => (id === agent.id ? agent : undefined),
    getProjectPath: () => home,
    update,
  } as unknown as MeshCore;
  const owner = frontDoorStepUpHarness(() => [
    { path: '/api/mesh', routes: createMeshRoutes({ meshCore }) },
  ]);
  beforeEach(() => {
    mkdirSync(path.dirname(file), { recursive: true });
    agent = { ...initial, account: null };
    writeFileSync(file, JSON.stringify(agent));
    update.mockClear();
    setCreditsAllowedForAgent(agent.id, false);
    vi.spyOn(modelGate, 'creditsAgentPatchRefusal').mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  it.each(['direct', 'own-tunnel', 'managed'] as const)('holds credits-on from %s', async (via) => {
    const before = readFileSync(file);
    const held = await owner
      .call('patch', '/api/mesh/agents/agent-1', via)
      .send({ account: 'dorkos-credits' });
    expect(held.status).toBe(428);
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(creditsAllowedForAgent(agent.id)).toBe(false);
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(update).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      status: 200,
      result: { account: 'dorkos-credits' },
    });
    expect(update).toHaveBeenCalledOnce();
    expect(creditsAllowedForAgent(agent.id)).toBe(true);
  });
  it('refuses credits-on from Wi-Fi without a hold', async () => {
    const response = await owner
      .call('patch', '/api/mesh/agents/agent-1', 'wifi')
      .send({ account: 'dorkos-credits' });
    expect(response.status).toBe(403);
    expect(response.body.heldActionId).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(creditsAllowedForAgent(agent.id)).toBe(false);
  });
  it('refuses a manifest changed while the action waited', async () => {
    const held = await owner
      .call('patch', '/api/mesh/agents/agent-1', 'own-tunnel')
      .send({ account: 'dorkos-credits' });
    expect(held.status).toBe(428);
    writeFileSync(file, JSON.stringify({ ...agent, model: 'different-work' }));
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      status: 409,
      result: { code: 'AGENT_CHANGED' },
    });
    expect(update).not.toHaveBeenCalled();
    expect(creditsAllowedForAgent(agent.id)).toBe(false);
  });
  it('turns credits off without a hold', async () => {
    setCreditsAllowedForAgent(agent.id, true);
    const response = await owner
      .call('patch', '/api/mesh/agents/agent-1', 'own-tunnel')
      .send({ account: null });
    expect(response.status).toBe(200);
    expect(creditsAllowedForAgent(agent.id)).toBe(false);
  });
  it('changes ordinary agent details without a hold', async () => {
    expect(
      (
        await owner
          .call('patch', '/api/mesh/agents/agent-1', 'own-tunnel')
          .send({ description: 'Check orders.' })
      ).status
    ).toBe(200);
  });
});
