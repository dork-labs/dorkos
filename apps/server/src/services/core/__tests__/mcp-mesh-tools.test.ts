import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createMeshDiscoverHandler,
  createMeshRegisterHandler,
  createMeshListHandler,
  createMeshDenyHandler,
  createMeshUnregisterHandler,
  createMeshStatusHandler,
  createMeshInspectHandler,
  createMeshQueryTopologyHandler,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import { type AgentToolDeps } from '../agent-tool-kit/agent-tool-kit.js';
import { runWithAuditActor } from '../../audit/audit-context.js';

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

// Boundary validation is exercised in the HTTP route tests; here it passes
// through by default so path handling stays under test, and individual cases
// override it to assert rejection.
vi.mock('../../../lib/boundary.js', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/boundary.js')>(
    '../../../lib/boundary.js'
  );
  return {
    ...actual,
    validateBoundary: vi.fn(async (p: string) => p),
    validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  };
});

import { meshToolDefinitions } from '../../runtimes/claude-code/mcp-tools/mesh-tools.js';
import { readManifest } from '@dorkos/shared/manifest';
import {
  validateBoundary,
  validateBoundaryOrDorkHome,
  BoundaryError,
} from '../../../lib/boundary.js';
import { setOnAgentCreated } from '../agent-created-hook.js';

/** Registration times for listed agents: the roster pages newest first by them. */
const AT = '2026-11-02T00:00:00.000Z';
const EARLIER = '2026-11-01T00:00:00.000Z';

function createMockDeps(meshEnabled = true): AgentToolDeps {
  const mockMeshCore = {
    discover: vi.fn(),
    register: vi.fn(),
    registerByPath: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    getByPath: vi.fn(),
    getSubject: vi.fn((agentId: string) => `relay.agent.ns.${agentId}`),
    // No agent here was installed from a package (DOR-3969 `fromPackage`).
    getProjectPath: vi.fn(() => undefined),
    unregister: vi.fn(),
    deny: vi.fn(),
    undeny: vi.fn(),
    close: vi.fn(),
    getStatus: vi.fn(),
    inspect: vi.fn(),
    getTopology: vi.fn(),
  };

  return {
    transcriptReader: {} as AgentToolDeps['transcriptReader'],
    defaultCwd: '/test',
    ...(meshEnabled && { meshCore: mockMeshCore as unknown as AgentToolDeps['meshCore'] }),
  };
}

/** The mocked mesh core inside `deps`. */
function meshOf(deps: AgentToolDeps): Record<string, ReturnType<typeof vi.fn>> {
  return deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

describe('Mesh MCP Tools', () => {
  it.each([
    ['mesh_discover', () => createMeshDiscoverHandler(createMockDeps(false))({ roots: ['/test'] })],
    [
      'mesh_register',
      () => createMeshRegisterHandler(createMockDeps(false))({ path: '/test/bot' }),
    ],
    ['mesh_list', () => createMeshListHandler(createMockDeps(false))({})],
    ['mesh_deny', () => createMeshDenyHandler(createMockDeps(false))({ path: '/bad' })],
    [
      'mesh_unregister',
      () => createMeshUnregisterHandler(createMockDeps(false))({ agentId: 'a1' }),
    ],
    ['mesh_status', () => createMeshStatusHandler(createMockDeps(false))()],
    ['mesh_inspect', () => createMeshInspectHandler(createMockDeps(false))({ agentId: 'a1' })],
    ['mesh_query_topology', () => createMeshQueryTopologyHandler(createMockDeps(false))({})],
  ] as const)('%s refuses with MESH_DISABLED when mesh is off', async (_tool, call) => {
    const result = await call();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
  });

  describe('when mesh is enabled', () => {
    it('mesh_discover returns candidates', async () => {
      const deps = createMockDeps(true);
      const mockCandidates = [
        {
          path: '/bot',
          strategy: 'claude-code',
          hints: { suggestedName: 'bot', detectedRuntime: 'claude-code' },
          discoveredAt: new Date().toISOString(),
        },
      ];
      const meshCore = meshOf(deps);
      meshCore.discover.mockImplementation(async function* () {
        for (const c of mockCandidates) yield { type: 'candidate', data: c };
      });

      const handler = createMeshDiscoverHandler(deps);
      const result = await handler({ roots: ['/test'] });
      const data = JSON.parse(result.content[0].text);
      expect(data.candidates).toHaveLength(1);
      expect(data.count).toBe(1);
    });

    it('mesh_register records the calling agent as createdBy (DOR-2788)', async () => {
      const deps = createMockDeps(true);
      const meshCore = meshOf(deps);
      meshCore.registerByPath.mockResolvedValue({ id: 'a1', name: 'bot', runtime: 'claude-code' });

      const handler = createMeshRegisterHandler(deps);
      await runWithAuditActor(
        { actor: { accountId: '01CALLER', kind: 'agent', name: 'Juno' }, surface: 'mcp' },
        () => handler({ path: '/test/bot', name: 'bot' })
      );
      expect(meshCore.registerByPath).toHaveBeenCalledWith(
        '/test/bot',
        expect.objectContaining({ createdBy: '01CALLER' }),
        'mcp-tool'
      );
    });

    // DOR-2054. `name` is the immutable address an agent's `@handle` in a room
    // is derived from (`deriveHandle(name) ?? deriveHandle(displayName)` in
    // `services/rooms/author-registry.ts`), but the tool described it as a
    // "display name override" and wrote whatever it was given straight into the
    // manifest — so DorkBot registered an agent whose name was the string
    // "DorkOS Cloud", spaces and all, with a seeded face nobody chose.
    describe('identity fields', () => {
      it('slugifies a display-style name and keeps the original as the display name', async () => {
        const deps = createMockDeps(true);
        const meshCore = meshOf(deps);
        meshCore.registerByPath.mockResolvedValue({ id: 'a1', name: 'dorkos-cloud' });

        const handler = createMeshRegisterHandler(deps);
        const result = await handler({
          path: '/test/cloud',
          name: 'DorkOS Cloud',
          icon: '\u{1F52E}',
          color: '#ec4899',
        });

        expect(result.isError).toBeUndefined();
        expect(meshCore.registerByPath).toHaveBeenCalledWith(
          '/test/cloud',
          expect.objectContaining({
            name: 'dorkos-cloud',
            displayName: 'DorkOS Cloud',
            icon: '\u{1F52E}',
            color: '#ec4899',
          }),
          'mcp-tool'
        );
      });

      // Each refusal says what a valid value is and never reaches the registry.
      it.each([
        [{ icon: 'sparkles' }, 'INVALID_ICON', 'exactly one emoji'],
        [{ color: 'pinkish' }, 'INVALID_COLOR', '#ec4899'],
        [{ displayName: 'x'.repeat(101) }, 'INVALID_DISPLAY_NAME', '100'],
        [{ name: '' }, 'INVALID_NAME', ''],
        [{ runtime: 'gpt5' }, 'INVALID_RUNTIME', ''],
      ])('refuses %o with %s', async (bad, code, hint) => {
        const deps = createMockDeps(true);
        const meshCore = meshOf(deps);

        const result = await createMeshRegisterHandler(deps)({
          path: '/test/bot',
          name: 'bot',
          ...bad,
        });

        expect(result.isError).toBe(true);
        const data = JSON.parse(result.content[0].text) as { error: string; code: string };
        expect(data.code).toBe(code);
        expect(data.error).toContain(hint);
        expect(meshCore.registerByPath).not.toHaveBeenCalled();
      });

      it.each(['144x.co', 'next_starter', '日本語'])(
        'leaves the directory name %s exactly as it came',
        async (dirName) => {
          // `slugifyAgentName` would move all three (`a-144x-co`, `next-starter`,
          // `agent`), and `handle.ts` measured what that costs: `mintHandle`
          // reads `name` first, so a rewritten name is a moved address.
          const deps = createMockDeps(true);
          const meshCore = meshOf(deps);
          meshCore.registerByPath.mockResolvedValue({ id: 'a1', name: dirName });

          const handler = createMeshRegisterHandler(deps);
          await handler({ path: `/test/${dirName}` });

          const partial = meshCore.registerByPath.mock.calls[0][1] as Record<string, unknown>;
          expect(partial.name).toBe(dirName);
          expect(partial).not.toHaveProperty('displayName');
        }
      );
    });

    it('mesh_register notifies the agent-created seam, so the agent takes its #team seat now', async () => {
      // Same seam, same reason as the HTTP register route (DOR-1042): an agent
      // an agent registers for you must not wait for a restart to be seated.
      const listener = vi.fn().mockResolvedValue(undefined);
      setOnAgentCreated(listener);
      try {
        const deps = createMockDeps(true);
        const meshCore = meshOf(deps);
        meshCore.registerByPath.mockResolvedValue({
          id: 'a1',
          name: 'Bot',
          runtime: 'claude-code',
        });

        const handler = createMeshRegisterHandler(deps);
        await handler({ path: '/test/bot', name: 'Bot' });

        expect(listener).toHaveBeenCalledWith({
          id: 'a1',
          name: 'Bot',
          displayName: undefined,
          path: '/test/bot',
          // Registration, not creation — seated, never announced.
          origin: 'registered',
        });
      } finally {
        setOnAgentCreated(null);
      }
    });

    it('mesh_register rejects re-registration over system agent', async () => {
      const deps = createMockDeps(true);
      vi.mocked(readManifest).mockResolvedValueOnce({
        id: 'sys1',
        name: 'dorkbot',
        isSystem: true,
        namespace: 'system',
      } as Awaited<ReturnType<typeof readManifest>>);

      const handler = createMeshRegisterHandler(deps);
      const result = await handler({ path: '/test/dorkbot', name: 'overwrite' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        error: 'Cannot re-register over a system agent',
        code: 'SYSTEM_AGENT',
      });
      const meshCore = meshOf(deps);
      expect(meshCore.registerByPath).not.toHaveBeenCalled();
    });

    // Register uses the dork-home seam (mirrors the HTTP mesh register route).
    it.each([
      [
        'mesh_register',
        'registerByPath',
        validateBoundaryOrDorkHome,
        (d: AgentToolDeps) => createMeshRegisterHandler(d)({ path: '/etc/passwd' }),
      ],
      [
        'mesh_discover',
        'discover',
        validateBoundary,
        (d: AgentToolDeps) => createMeshDiscoverHandler(d)({ roots: ['/etc'] }),
      ],
      [
        'mesh_deny',
        'deny',
        validateBoundary,
        (d: AgentToolDeps) => createMeshDenyHandler(d)({ path: '/etc' }),
      ],
    ] as const)('%s rejects a path outside the boundary', async (_tool, method, guard, call) => {
      const deps = createMockDeps(true);
      const meshCore = meshOf(deps);
      vi.mocked(guard).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const result = await call(deps);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'OUTSIDE_BOUNDARY' });
      expect(meshCore[method]).not.toHaveBeenCalled();
    });

    // DOR-1337 (F5): the docs tell an agent to find peers with mesh_list and then
    // send to them, but the only address that matches an allow rule is the
    // four-segment `relay.agent.{namespace}.{agentId}` — and mesh_list used to
    // return the namespace-stripped manifest, leaving the agent to invent a
    // two-segment subject that no rule can match. The address now travels with
    // the listing, derived exactly as `mesh_inspect` derives it.
    it('mesh_list carries each agent relaySubject, resolved by the canonical id lookup', async () => {
      const deps = createMockDeps(true);
      const meshCore = meshOf(deps);
      meshCore.list.mockReturnValue([
        { id: 'a1', name: 'alpha', registeredAt: AT },
        { id: 'b2', name: 'beta', registeredAt: EARLIER },
      ]);

      const handler = createMeshListHandler(deps);
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.agents).toEqual([
        { id: 'a1', name: 'alpha', registeredAt: AT, ref: null, relaySubject: 'relay.agent.ns.a1' },
        {
          id: 'b2',
          name: 'beta',
          registeredAt: EARLIER,
          ref: null,
          relaySubject: 'relay.agent.ns.b2',
        },
      ]);
      // Never rebuilt from the manifest: only the un-stripped registry lookup
      // knows the namespace the endpoint and its rules were registered under.
      expect(meshCore.getSubject).toHaveBeenCalledWith('a1');
      expect(meshCore.getSubject).toHaveBeenCalledWith('b2');
    });

    // DOR-2790: agents message each other with chat_send, which takes an agent id
    // as "to". Telling them to send to relaySubject pointed at a retired path.
    it('mesh_list and mesh_inspect point agents at the id for chat_send, not relaySubject', () => {
      const defs = meshToolDefinitions(createMockDeps(true));
      const descriptionOf = (name: string) => defs.find((d) => d.name === name)?.description ?? '';
      for (const name of ['mesh_list', 'mesh_inspect']) {
        const text = descriptionOf(name);
        expect(text).toMatch(/the chat send tool/);
        expect(text).toMatch(/only for message-bus and A2A integrations/);
        expect(text).not.toMatch(/Send to that exact/);
      }
    });

    // DOR-5046: every listed agent carries its `dork:agent:` reference, so a
    // link to it is `[Name](/r/<ref>)`; an id no link opens carries null.
    it('mesh_list and mesh_inspect name each agent by its dork: reference', async () => {
      const id = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
      const deps = createMockDeps(true);
      const meshCore = meshOf(deps);
      meshCore.list.mockReturnValue([
        { id, name: 'lantern', registeredAt: AT },
        { id: 'a1', name: 'alpha', registeredAt: EARLIER },
      ]);
      const listed = JSON.parse((await createMeshListHandler(deps)({})).content[0].text);
      expect(listed.agents.map((agent: { ref: string | null }) => agent.ref)).toEqual([
        `dork:agent:${id}`,
        null,
      ]);

      meshCore.inspect.mockReturnValue({
        agent: { id, name: 'lantern' },
        health: {},
        relaySubject: null,
      });
      const inspected = JSON.parse(
        (await createMeshInspectHandler(deps)({ agentId: id })).content[0].text
      );
      expect(inspected.agent.ref).toBe(`dork:agent:${id}`);
    });

    it('mesh_unregister rejects system agents with SYSTEM_AGENT error', async () => {
      const deps = createMockDeps(true);
      const meshCore = meshOf(deps);
      meshCore.get.mockReturnValue({ id: 'sys1', name: 'dorkbot', isSystem: true });

      const handler = createMeshUnregisterHandler(deps);
      const result = await handler({ agentId: 'sys1' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        error: 'System agents cannot be unregistered',
        code: 'SYSTEM_AGENT',
      });
      expect(meshCore.unregister).not.toHaveBeenCalled();
    });
  });
});

// DOR-3969: an agent installed from a marketplace package carries text its author wrote, so the
// list says so (`fromPackage`) and the call marks the turn. One the person made says nothing.
describe('mesh_list and mesh_inspect name an agent installed from a package', () => {
  /** An agent home with an install record from `installedFrom`, or none. */
  async function homeInstalledFrom(installedFrom: string | null): Promise<string> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dorkos-from-package-'));
    if (installedFrom !== null) {
      await mkdir(path.join(home, '.dork'), { recursive: true });
      await writeFile(
        path.join(home, '.dork', 'install-metadata.json'),
        JSON.stringify({
          name: 'garden-helper',
          version: '1.0.0',
          type: 'agent',
          installedFrom,
          installedAt: '2026-11-17T12:00:00.000Z',
        })
      );
    }
    return home;
  }

  async function listed(installedFrom: string | null) {
    const home = await homeInstalledFrom(installedFrom);
    try {
      const deps = createMockDeps();
      const mesh = meshOf(deps);
      mesh.list!.mockReturnValue([{ id: 'a1', name: 'garden-helper', registeredAt: AT }]);
      mesh.getProjectPath!.mockReturnValue(home);
      mesh.inspect!.mockReturnValue({ agent: { id: 'a1', name: 'garden-helper' }, health: {} });
      const list = JSON.parse((await createMeshListHandler(deps)({})).content[0].text);
      const inspect = JSON.parse(
        (await createMeshInspectHandler(deps)({ agentId: 'a1' })).content[0].text
      );
      return { list: list.agents[0].fromPackage, inspect: inspect.agent.fromPackage };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('says fromPackage for an agent installed from a third-party marketplace', async () => {
    expect(await listed('garden-market')).toEqual({ list: true, inspect: true });
  });

  it("says nothing for one from the person's own marketplace, or one made here", async () => {
    expect(await listed('personal')).toEqual({ list: undefined, inspect: undefined });
    expect(await listed(null)).toEqual({ list: undefined, inspect: undefined });
  });
});

describe('mesh_list, a page at a time like GET /api/mesh/agents (DOR-5480)', () => {
  // Purpose: an agent that reads only the first page thinks the roster ends
  // there, so the tool pages by the route's rule: newest registered first, the
  // filters and the reader bound into the cursor.
  const at = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
  const ROSTER = [
    { id: 'agent-a', name: 'a', registeredAt: at(1) },
    { id: 'agent-b', name: 'b', registeredAt: at(3) },
    { id: 'agent-c', name: 'c', registeredAt: at(2) },
  ];
  const agentReader = () => ({ identity: { agentPath: '/agents/scout' } });

  async function page(deps: McpToolDeps, args: Record<string, unknown>, reader = agentReader) {
    const result = await createMeshListHandler(deps, reader)(args);
    return { isError: result.isError, data: JSON.parse(result.content[0].text) };
  }

  it('reads every agent once, newest registered first, by following nextCursor', async () => {
    const deps = createMockDeps();
    meshOf(deps).list.mockReturnValue(ROSTER);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const { data } = await page(deps, { limit: 1, ...(cursor ? { cursor } : {}) });
      ids.push(...data.agents.map((agent: { id: string }) => agent.id));
      cursor = data.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['agent-b', 'agent-c', 'agent-a']);
  });

  it('refuses a cursor given under other filters or to another reader, never as page one', async () => {
    const deps = createMockDeps();
    meshOf(deps).list.mockReturnValue(ROSTER);
    const { data: first } = await page(deps, { limit: 1 });
    const otherFilter = await page(deps, { limit: 1, cursor: first.nextCursor, capability: 'x' });
    const otherReader = await page(deps, { limit: 1, cursor: first.nextCursor }, () => ({}));
    for (const refused of [otherFilter, otherReader]) {
      expect(refused.isError).toBe(true);
      expect(refused.data).toMatchObject({ code: 'INVALID_CURSOR' });
    }
  });
});
