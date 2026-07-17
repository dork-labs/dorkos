/**
 * Runtime validation for the external MCP server's `dorkos://` resources
 * (sessions, agents, skills).
 *
 * Follows the real-pipeline pattern established by `mcp-structured-output.test.ts`
 * and the marketplace `tools-list.test.ts`: a REAL `McpServer` + `Client` pair
 * connected over `InMemoryTransport`, driven through the standard MCP
 * `resources/list`, `resources/templates/list`, and `resources/read` requests
 * — the same requests an external MCP client (Claude Code, Cursor, Codex)
 * sends. This exercises the SDK's own resource-routing and error-shaping
 * logic, not just our registration calls.
 *
 * @module services/core/__tests__/mcp-resources
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/schemas';
import { createExternalMcpServer } from '../mcp-server.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { RuntimeRegistry } from '../runtime-registry.js';

const NOW = new Date().toISOString();

/**
 * A single known session the fake runtime serves. `lastMessagePreview` is
 * deliberately populated with recognizable message text so the tests can
 * prove the resources strip it — the external MCP surface is metadata-only.
 */
const SESSION: Session = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Known session',
  createdAt: NOW,
  updatedAt: NOW,
  lastMessagePreview: 'MESSAGE TEXT THAT MUST NOT LEAK',
  permissionMode: 'default',
  runtime: 'claude-code',
  cwd: '/tmp/fixture-project',
};

/** The metadata-only projection of {@link SESSION} both session resources return. */
const SESSION_METADATA = {
  id: SESSION.id,
  title: SESSION.title,
  runtime: SESSION.runtime,
  cwd: SESSION.cwd,
  updatedAt: SESSION.updatedAt,
};

/** A single known agent the fake `MeshCore` serves. */
const AGENT: AgentManifest = {
  id: '01JXAMPLE0000000000000TEST',
  name: 'resource-test-bot',
  description: 'Fixture agent for resource tests',
  runtime: 'claude-code',
  capabilities: ['testing'],
  behavior: { responseMode: 'always' },
  registeredAt: NOW,
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  enabledToolGroups: {},
};

describe('external MCP dorkos:// resources (real resources/list + resources/read pipeline)', () => {
  let workspaceDir: string;
  let client: Client;

  beforeAll(async () => {
    // Real .agents/skills/<name>/SKILL.md on disk so the skills resources
    // exercise their true scan + parse path.
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'mcp-resources-'));
    const skillDir = path.join(workspaceDir, '.agents', 'skills', 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: A skill fixture for resource tests.\n---\n\nBody content for the test skill.\n',
      'utf-8'
    );

    const fakeRuntime = {
      type: 'claude-code',
      listSessions: async () => [SESSION],
      getSession: async (_cwd: string, sessionId: string) =>
        sessionId === SESSION.id ? SESSION : null,
      getInternalSessionId: (sessionId: string) => sessionId,
    };
    const fakeRuntimeRegistry = {
      listRuntimes: () => [fakeRuntime],
      resolveForSession: async () => fakeRuntime,
    } as unknown as RuntimeRegistry;
    const fakeMeshCore = {
      list: () => [AGENT],
      get: (agentId: string) => (agentId === AGENT.id ? AGENT : undefined),
    } as unknown as McpToolDeps['meshCore'];

    const deps: McpToolDeps = {
      transcriptReader: {
        listSessions: async () => [],
      } as unknown as McpToolDeps['transcriptReader'],
      defaultCwd: workspaceDir,
      runtimeRegistry: fakeRuntimeRegistry,
      meshCore: fakeMeshCore,
    };

    const server = createExternalMcpServer(deps);
    client = new Client({ name: 'resources-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('advertises resources without listChanged or subscribe capabilities', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.resources).toEqual({ listChanged: false });
    expect(caps?.resources?.subscribe).toBeUndefined();
  });

  it('resources/list returns the three static resources with name/description/mimeType', async () => {
    const { resources } = await client.listResources();
    const byUri = new Map(resources.map((r) => [r.uri, r]));

    for (const uri of ['dorkos://sessions', 'dorkos://agents', 'dorkos://skills']) {
      const resource = byUri.get(uri);
      expect(resource, `expected ${uri} in resources/list`).toBeDefined();
      expect(resource!.name).toBeTruthy();
      expect(resource!.description).toBeTruthy();
      expect(resource!.mimeType).toBe('application/json');
    }
    // Templates are not enumerated into resources/list (list: undefined) —
    // only the 3 static collection resources appear here.
    expect(resources).toHaveLength(3);
  });

  it('resources/templates/list returns the three item templates', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const uriTemplates = resourceTemplates.map((t) => t.uriTemplate).sort();
    expect(uriTemplates).toEqual(
      ['dorkos://agents/{id}', 'dorkos://sessions/{id}', 'dorkos://skills/{name}'].sort()
    );
    for (const template of resourceTemplates) {
      expect(template.mimeType).toBe('application/json');
      expect(template.description).toBeTruthy();
    }
  });

  it('reads dorkos://sessions — metadata rows only, lastMessagePreview stripped', async () => {
    const result = await client.readResource({ uri: 'dorkos://sessions' });
    const body = JSON.parse(result.contents[0]!.text as string);
    // Exact row equality: the runtime returned a full Session (including
    // lastMessagePreview message text); the resource must trim every row to
    // the metadata projection.
    expect(body.sessions).toEqual([SESSION_METADATA]);
    expect(result.contents[0]!.text).not.toContain('MESSAGE TEXT THAT MUST NOT LEAK');
  });

  it('reads dorkos://sessions/{id} for a known session — trimmed metadata shape', async () => {
    const result = await client.readResource({ uri: `dorkos://sessions/${SESSION.id}` });
    const body = JSON.parse(result.contents[0]!.text as string);
    expect(body).toEqual(SESSION_METADATA);
  });

  it('reads dorkos://sessions/{id} for an unknown id — proper MCP error', async () => {
    await expect(client.readResource({ uri: 'dorkos://sessions/does-not-exist' })).rejects.toThrow(
      /Session not found/
    );
  });

  it('reads dorkos://agents and finds the known agent', async () => {
    const result = await client.readResource({ uri: 'dorkos://agents' });
    const body = JSON.parse(result.contents[0]!.text as string);
    expect(body.count).toBe(1);
    expect(body.agents).toContainEqual(expect.objectContaining({ id: AGENT.id }));
  });

  it('reads dorkos://agents/{id} for a known agent', async () => {
    const result = await client.readResource({ uri: `dorkos://agents/${AGENT.id}` });
    const body = JSON.parse(result.contents[0]!.text as string);
    expect(body).toMatchObject({ id: AGENT.id, name: AGENT.name });
  });

  it('reads dorkos://agents/{id} for an unknown id — proper MCP error', async () => {
    await expect(client.readResource({ uri: 'dorkos://agents/does-not-exist' })).rejects.toThrow(
      /Agent not found/
    );
  });

  it('reads dorkos://skills and finds the fixture skill (summary only)', async () => {
    const result = await client.readResource({ uri: 'dorkos://skills' });
    const body = JSON.parse(result.contents[0]!.text as string);
    expect(body.count).toBe(1);
    expect(body.skills).toEqual([
      { name: 'test-skill', description: 'A skill fixture for resource tests.' },
    ]);
  });

  it('reads dorkos://skills/{name} for a known skill — full frontmatter + body', async () => {
    const result = await client.readResource({ uri: 'dorkos://skills/test-skill' });
    const body = JSON.parse(result.contents[0]!.text as string);
    expect(body.name).toBe('test-skill');
    expect(body.meta.description).toBe('A skill fixture for resource tests.');
    expect(body.body).toBe('Body content for the test skill.');
  });

  it('reads dorkos://skills/{name} for an unknown name — proper MCP error', async () => {
    await expect(client.readResource({ uri: 'dorkos://skills/does-not-exist' })).rejects.toThrow(
      /Skill not found/
    );
  });

  it('reads an entirely unknown dorkos:// URI — proper MCP error', async () => {
    await expect(client.readResource({ uri: 'dorkos://not-a-real-resource' })).rejects.toThrow();
  });

  it('degrades per runtime: a throwing runtime yields warnings[] while the healthy one still lists', async () => {
    // Own server/client pair (same pattern as the drift test in
    // mcp-structured-output.test.ts): two runtimes, one of which rejects
    // listSessions — mirroring ADR-0310's per-runtime degradation contract.
    const healthyRuntime = {
      type: 'claude-code',
      listSessions: async () => [SESSION],
    };
    const brokenRuntime = {
      type: 'codex',
      listSessions: async () => {
        throw new Error('codex sidecar unavailable');
      },
    };
    const deps: McpToolDeps = {
      transcriptReader: {
        listSessions: async () => [],
      } as unknown as McpToolDeps['transcriptReader'],
      defaultCwd: workspaceDir,
      runtimeRegistry: {
        listRuntimes: () => [healthyRuntime, brokenRuntime],
      } as unknown as RuntimeRegistry,
    };
    const degradedServer = createExternalMcpServer(deps);
    const degradedClient = new Client({ name: 'degradation-test', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([degradedServer.connect(st), degradedClient.connect(ct)]);
    try {
      const result = await degradedClient.readResource({ uri: 'dorkos://sessions' });
      const body = JSON.parse(result.contents[0]!.text as string);
      expect(body.sessions).toEqual([SESSION_METADATA]);
      expect(body.warnings).toEqual([{ runtime: 'codex', message: 'codex sidecar unavailable' }]);
    } finally {
      await degradedClient.close();
    }
  });
});
