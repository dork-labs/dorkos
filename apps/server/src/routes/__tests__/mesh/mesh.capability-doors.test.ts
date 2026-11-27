/**
 * The agent registry's doors on the capability mount (DOR-4978): every change
 * to the registry, and the denied-folder list, refuse an agent and a program
 * before anything is read or changed; the reads an agent may make leave out
 * another agent's private fields, and keep its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import type { MiddlewareHandler } from 'hono';
import type { MeshCore } from '@dorkos/mesh';

import { capabilityGroup } from '../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../../http/api-chain.js';
import type { AgentIdentity } from '../../../services/core/agent-identity/agent-identity-service.js';
import { meshDomain } from '../../../services/mesh/doors/mesh-capabilities.js';
import { meshRefusal } from '../../../services/mesh/doors/mesh-refusals.js';
import { toolRefusalProblem } from '../../capability-refusals.js';
import {
  createMockMeshCore,
  fixtureServer,
  fixtureTarget,
  useLoginOffConfig,
  type MockMeshCore,
} from './mesh.fixtures.js';
import { meshReadViews } from './mesh-read-views.js';

useLoginOffConfig();

/** Two agents: Scout, whose identity a test may present, and Ranger. */
const SCOUT = {
  id: 'agent-scout',
  name: 'scout',
  runtime: 'claude-code' as const,
  registeredAt: '2026-11-01T00:00:00.000Z',
  persona: 'Scout’s own instructions.',
  permissions: { areas: { agents: 'allowed' } },
  mcpServers: [{ name: 'notes' }],
  workspace: { mode: 'home' },
};
const RANGER = { ...SCOUT, id: 'agent-ranger', name: 'ranger', persona: 'Ranger’s instructions.' };
const HOMES: Record<string, string> = {
  'agent-scout': '/projects/scout',
  'agent-ranger': '/projects/ranger',
};
const AS_SCOUT: AgentIdentity = {
  agentPath: '/projects/scout',
  displayName: 'Scout',
  createdAt: '2026-11-25T00:00:00.000Z',
};
const PRIVATE = ['persona', 'permissions', 'mcpServers', 'workspace', 'projectPath'];

let meshCore: MockMeshCore & Record<string, ReturnType<typeof vi.fn>>;

/** Serve the doors, standing in for the chain having resolved `identity` when given. */
function serve(identity?: AgentIdentity): void {
  const before: MiddlewareHandler<ApiEnv> = async (c, next) => {
    if (identity) c.set('agentIdentity', identity);
    await next();
  };
  fixtureTarget.mount(
    honoGroupListener(
      capabilityGroup(meshDomain, {
        meshDeps: { meshCore: meshCore as unknown as MeshCore, views: meshReadViews },
      }),
      { before }
    )
  );
}

beforeEach(() => {
  meshCore = {
    ...createMockMeshCore(),
    getTopology: vi.fn(() => ({
      callerNamespace: '*',
      namespaces: [
        {
          namespace: 'projects',
          agentCount: 2,
          agents: [
            { ...SCOUT, projectPath: '/projects/scout' },
            { ...RANGER, projectPath: '/projects/ranger' },
          ],
        },
      ],
      accessRules: [],
    })),
    allowCrossNamespace: vi.fn(),
    denyCrossNamespace: vi.fn(),
  } as typeof meshCore;
  meshCore.get.mockImplementation((id: string) => [SCOUT, RANGER].find((a) => a.id === id));
  meshCore.getProjectPath.mockImplementation((id: string) => HOMES[id]);
  meshCore.listWithHealth.mockReturnValue([SCOUT, RANGER]);
  meshCore.listWithPaths.mockReturnValue([
    { id: SCOUT.id, name: SCOUT.name, projectPath: HOMES['agent-scout'] },
  ]);
});

/** Every person-only door, as a request. */
const PERSON_DOORS = [
  () => request(fixtureServer).get('/api/mesh/denied'),
  () =>
    request(fixtureServer)
      .post('/api/mesh/discover')
      .send({ roots: ['/projects'] }),
  () => request(fixtureServer).post('/api/mesh/agents').send({ path: '/projects/new' }),
  () => request(fixtureServer).delete('/api/mesh/agents/agent-ranger'),
  () => request(fixtureServer).delete('/api/mesh/agents/agent-ranger/data'),
  () => request(fixtureServer).post('/api/mesh/deny').send({ path: '/projects/new' }),
  () => request(fixtureServer).delete('/api/mesh/denied?path=/projects/new'),
  () =>
    request(fixtureServer)
      .put('/api/mesh/topology/access')
      .send({ sourceNamespace: '*', targetNamespace: '*', action: 'allow' }),
];

describe('a person’s registry doors', () => {
  it('refuse an agent on every door, before anything is read or changed', async () => {
    serve(AS_SCOUT);
    for (const door of PERSON_DOORS) {
      const res = await door().set('X-DorkOS-Agent', 'scout-token');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
    }
    for (const fn of Object.values(meshCore)) expect(fn).not.toHaveBeenCalled();
  });

  it('name the tool an agent uses instead, where there is one', async () => {
    serve(AS_SCOUT);
    const deny = await request(fixtureServer)
      .post('/api/mesh/deny')
      .set('X-DorkOS-Agent', 'scout-token')
      .send({ path: '/projects/new' });
    expect(deny.body.detail).toBe('Agents hide a folder from discovery with mesh_deny.');
    const remove = await request(fixtureServer)
      .delete('/api/mesh/agents/agent-ranger')
      .set('X-DorkOS-Agent', 'scout-token');
    expect(remove.body.detail).toMatch(/mesh_unregister\.$/);
  });

  it('refuse a program: a call with an Authorization header is not a person', async () => {
    serve();
    for (const door of PERSON_DOORS) {
      const res = await door().set('Authorization', 'Bearer some-key');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
    }
    for (const fn of Object.values(meshCore)) expect(fn).not.toHaveBeenCalled();
  });

  it('let the person read the denied folders and change the access rules', async () => {
    serve();
    const denied = await request(fixtureServer).get('/api/mesh/denied');
    expect(denied.status).toBe(200);
    const rule = await request(fixtureServer)
      .put('/api/mesh/topology/access')
      .send({ sourceNamespace: '*', targetNamespace: '*', action: 'deny' });
    expect(rule.status).toBe(200);
    expect(meshCore.denyCrossNamespace).toHaveBeenCalledWith('*', '*');
  });

  it('page the denied folders in the order the list keeps, newest first', async () => {
    const rows = ['/c', '/b', '/a'].map((path, i) => ({
      path,
      deniedBy: 'owner',
      deniedAt: `2026-11-2${7 - i}T00:00:00.000Z`,
    }));
    meshCore.listDenied.mockReturnValue(rows);
    serve();
    const first = await request(fixtureServer).get('/api/mesh/denied?limit=2');
    const next = encodeURIComponent(first.body.nextCursor);
    const second = await request(fixtureServer).get(`/api/mesh/denied?limit=2&cursor=${next}`);
    const paths = [...first.body.denied, ...second.body.denied].map(
      (r: { path: string }) => r.path
    );
    expect(paths).toEqual(['/c', '/b', '/a']);
    expect(second.body.nextCursor).toBeNull();
    expect((await request(fixtureServer).get('/api/mesh/denied?cursor=nope')).status).toBe(400);
  });

  it('refuse a bad icon in a fixed sentence that does not echo what was sent', () => {
    const sent = 'Invalid icon "xx". An agent\'s icon is exactly one emoji, e.g. "🔮".';
    expect(toolRefusalProblem(meshRefusal('MESH_INVALID_ICON', sent).payload)).toMatchObject({
      status: 400,
      code: 'invalid_request',
      detail: 'An agent’s icon is exactly one emoji. Omit it to have one picked.',
    });
  });
});

describe('the registry reads an agent may make', () => {
  /** The roster as `headers` reads it. */
  async function roster(headers: Record<string, string> = {}) {
    const res = await request(fixtureServer).get('/api/mesh/agents').set(headers);
    expect(res.status).toBe(200);
    const agents = res.body.agents as Array<Record<string, unknown>>;
    return {
      scout: agents.find((agent) => agent.id === SCOUT.id)!,
      ranger: agents.find((agent) => agent.id === RANGER.id)!,
    };
  }

  it('give the person every field', async () => {
    serve();
    const { ranger } = await roster();
    expect(ranger.persona).toBe(RANGER.persona);
    expect(ranger.permissions).toEqual(RANGER.permissions);
  });

  it('leave out another agent’s private fields, and keep the agent’s own', async () => {
    serve(AS_SCOUT);
    const { scout, ranger } = await roster({ 'X-DorkOS-Agent': 'scout-token' });
    expect(ranger.name).toBe('ranger');
    for (const field of PRIVATE) expect(ranger).not.toHaveProperty(field);
    expect(scout.persona).toBe(SCOUT.persona);
  });

  it('filter the topology the same way', async () => {
    serve(AS_SCOUT);
    const topology = await request(fixtureServer)
      .get('/api/mesh/topology')
      .set('X-DorkOS-Agent', 'scout-token');
    const agents = topology.body.namespaces[0].agents as Array<Record<string, unknown>>;
    const ranger = agents.find((agent) => agent.id === RANGER.id)!;
    for (const field of PRIVATE) expect(ranger).not.toHaveProperty(field);
    expect(agents.find((agent) => agent.id === SCOUT.id)!.persona).toBe(SCOUT.persona);
  });

  it('give the count by folder to the person, and to an agent empty', async () => {
    const status = {
      totalAgents: 2,
      activeCount: 2,
      inactiveCount: 0,
      staleCount: 0,
      unreachableCount: 0,
      byRuntime: { 'claude-code': 2 },
      byProject: { '/projects/scout': 1, '/projects/ranger': 1 },
    };
    meshCore.getStatus.mockReturnValue(status);
    serve();
    const person = await request(fixtureServer).get('/api/mesh/status');
    expect(person.body).toEqual(status);
    const agent = await request(fixtureServer)
      .get('/api/mesh/status')
      .set('X-DorkOS-Agent', 'not-a-real-token');
    expect(agent.status).toBe(200);
    expect(agent.body).toEqual({ ...status, byProject: {} });
  });

  it('treat an agent token that resolves to nobody as another agent', async () => {
    serve();
    const { scout } = await roster({ 'X-DorkOS-Agent': 'not-a-real-token' });
    for (const field of PRIVATE) expect(scout).not.toHaveProperty(field);
  });
});

describe('the roster, a page at a time (DOR-4982)', () => {
  // Purpose: the registry lists newest registered first; every page read in
  // turn keeps that order, and the cursor is sealed to its reader, since an
  // agent reads other agents without their private fields.
  it('keeps the newest-registered order across pages, and refuses another reader’s cursor', async () => {
    const at = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
    const agents = [
      { ...RANGER, id: 'agent-b', registeredAt: at(3) },
      { ...SCOUT, id: 'agent-c', registeredAt: at(2) },
      { ...RANGER, id: 'agent-a', registeredAt: at(1) },
    ];
    meshCore.listWithHealth.mockReturnValue(agents);
    serve();
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await request(fixtureServer).get(`/api/mesh/agents?limit=1${after}`);
      ids.push(...page.body.agents.map((agent: { id: string }) => agent.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['agent-b', 'agent-c', 'agent-a']);

    const first = await request(fixtureServer).get('/api/mesh/agents?limit=1');
    const asAgent = await request(fixtureServer)
      .get(`/api/mesh/agents?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('X-DorkOS-Agent', 'not-a-real-token');
    expect(asAgent.status).toBe(400);
  });
});
