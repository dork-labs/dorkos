/**
 * The `mcp.*` capability domain (spec `mcp-server-management` §5): its tier
 * posture, the approval card's command fields on the destructive writes, and the
 * gate proof — an unapproved `mcp.add` writes nothing and returns the approval
 * payload; a granted one writes the entry. `mcp.list` is a free `observe` read.
 *
 * Read-only posture assertions drive the capability directly; the gate
 * assertions go through `registry.invoke`, where the tier gate lives (DOR-467).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { AgentRegistry } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { mcpDomain } from '../mcp-capabilities.js';
import { AgentMcpServerService, type AgentWorkspaceLocator } from '../agent-mcp-server-service.js';
import type { CapabilityDeps } from '../../core/capabilities/index.js';
import {
  composeRegistry,
  describeGatedAttempt,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  CapabilityGateRefusal,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from '../../core/capabilities/index.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';

const AGENT: AgentIdentity = {
  agentPath: '/projects/prober',
  displayName: 'Prober',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

const AGENT_ID = '01HV7KJZZZ0000000000000000';

const STDIO_CONNECTION = {
  transport: 'stdio' as const,
  command: 'my-server',
  args: ['--port', '9000'],
  env: {},
};

/** Resolve one capability by id, throwing when the domain stops declaring it. */
function capability(id: string): CapabilityDefinition {
  const found = mcpDomain.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`mcp domain no longer declares ${id}`);
  return found;
}

class FakeLocator implements AgentWorkspaceLocator {
  constructor(private readonly map: Record<string, string>) {}
  get(agentId: string): { projectPath: string } | undefined {
    const projectPath = this.map[agentId];
    return projectPath ? { projectPath } : undefined;
  }
}

function baseManifest(): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: AGENT_ID,
    name: 'test-agent',
    description: 'A test agent',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-03T00:00:00.000Z',
    registeredBy: 'test-suite',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [],
  };
}

const tempDirs: string[] = [];

async function setup(mcpJson?: Record<string, unknown>): Promise<{
  service: AgentMcpServerService;
  deps: CapabilityDeps;
  projectPath: string;
}> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cap-'));
  tempDirs.push(projectPath);
  await writeManifest(projectPath, baseManifest());
  if (mcpJson) {
    await fs.writeFile(
      path.join(projectPath, '.mcp.json'),
      JSON.stringify({ mcpServers: mcpJson }),
      'utf-8'
    );
  }

  const service = new AgentMcpServerService({
    agents: new FakeLocator({ [AGENT_ID]: projectPath }),
    logger: { warn: () => {} },
  });
  const deps: CapabilityDeps = {
    logger: noopLogger,
    mcpDeps: { service, agents: new AgentRegistry(createTestDb()) },
  };
  return { service, deps, projectPath };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('mcp.* tier posture', () => {
  it('list is an observe read with the carve-out; add/update are destructive with the command card', () => {
    const list = capability('mcp.list');
    expect(list.tier).toBe('observe');
    expect(list.surfaces.mcp?.readOnlyCarveOut).toBe(true);

    for (const id of ['mcp.add', 'mcp.update']) {
      const cap = capability(id);
      expect(cap.tier).toBe('destructive');
      expect(cap.surfaces.mcp?.readOnlyCarveOut).toBeUndefined();
      // The card must show the exact command/endpoint that will run (spec §4).
      expect(cap.approvalDisplayFields).toEqual([
        'connection.transport',
        'connection.command',
        'connection.args',
        'connection.url',
      ]);
    }

    // Import is destructive too, but its card names the agent + discovered
    // server (the connection is resolved server-side, after the gate), not the
    // connection.* fields add/update show.
    const imp = capability('mcp.import');
    expect(imp.tier).toBe('destructive');
    expect(imp.surfaces.mcp?.readOnlyCarveOut).toBeUndefined();
    expect(imp.approvalDisplayFields).toEqual(['agentId', 'name']);

    for (const id of ['mcp.remove', 'mcp.enable', 'mcp.disable', 'mcp.test']) {
      expect(capability(id).tier).toBe('act');
    }
  });

  it('every verb projects the mcp_<verb>_server tool and an HTTP surface', () => {
    for (const verb of ['list', 'add', 'import', 'update', 'remove', 'enable', 'disable', 'test']) {
      const cap = capability(`mcp.${verb}`);
      expect(cap.surfaces.mcp?.toolName).toBe(`mcp_${verb}_server`);
      // No curated CLI verb: `dorkos call mcp.<verb>` reaches it generically.
      expect(cap.surfaces.cli).toBeUndefined();
      expect(cap.surfaces.http?.path).toContain('/api/agents/');
    }
  });
});

describe('mcp.add approval card', () => {
  it('resolves the connection command fields into the card (not the literal "input." prefix)', () => {
    // Proves the paths resolve against the parsed input: a stdio add shows the
    // transport, command, and args. A wrong `input.connection.*` prefix would
    // render every value as "not set" — this is the assertion that catches it.
    const summary = describeGatedAttempt(capability('mcp.add'), {
      agentId: AGENT_ID,
      name: 'my-server',
      connection: STDIO_CONNECTION,
    });
    expect(summary).toContain('connection.transport: "stdio"');
    expect(summary).toContain('connection.command: "my-server"');
    expect(summary).toContain('connection.args: 2 items');
    // The url field is absent on a stdio connection, so it renders as "not set".
    expect(summary).toContain('connection.url: not set');
  });
});

describe('mcp.* gate enforcement (through registry.invoke)', () => {
  let approvals: ApprovalService;

  beforeEach(() => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
  });
  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /** The approval payload a refused destructive call returns. */
  interface ApprovalCard {
    status: string;
    capabilityId: string;
    tier: string;
    approvalId: string;
    approvalToken: string;
  }

  /** Invoke, expecting the tier gate to refuse; return the approval card it produced. */
  async function invokeExpectingRefusal(
    registry: CapabilityRegistry,
    id: string,
    input: unknown,
    identity?: AgentIdentity
  ): Promise<ApprovalCard> {
    try {
      await registry.invoke(id, input, identity ? { identity } : undefined);
    } catch (err) {
      if (err instanceof CapabilityGateRefusal)
        return err.decision.payload as unknown as ApprovalCard;
      throw err;
    }
    throw new Error(`Expected ${id} to be refused by the tier gate, but it ran.`);
  }

  it('mcp.list is free: no approval, returns the (empty) list', async () => {
    const { deps } = await setup();
    const registry = composeRegistry([mcpDomain], deps);
    const result = await registry.invoke('mcp.list', { agentId: AGENT_ID });
    expect(result).toEqual([]);
  });

  it('mcp.add without approval returns approval_required and writes NOTHING', async () => {
    const { service, deps } = await setup();
    const registry = composeRegistry([mcpDomain], deps);

    const card = await invokeExpectingRefusal(registry, 'mcp.add', {
      agentId: AGENT_ID,
      name: 'my-server',
      connection: STDIO_CONNECTION,
    });
    expect(card).toMatchObject({
      status: 'approval_required',
      capabilityId: 'mcp.add',
      tier: 'destructive',
    });
    // The gate is the only writer: a refused add left the manifest untouched.
    expect(await service.list(AGENT_ID)).toEqual([]);
  });

  it('mcp.add on a granted retry writes the enabled entry with the approver recorded', async () => {
    const { service, deps } = await setup();
    const registry = composeRegistry([mcpDomain], deps);

    const card = await invokeExpectingRefusal(
      registry,
      'mcp.add',
      { agentId: AGENT_ID, name: 'my-server', connection: STDIO_CONNECTION },
      AGENT
    );

    // A person grants it, then the agent retries with the token.
    approvals.grant(card.approvalId);
    const written = (await registry.invoke(
      'mcp.add',
      { agentId: AGENT_ID, name: 'my-server', connection: STDIO_CONNECTION },
      { identity: AGENT, approvalToken: card.approvalToken }
    )) as AgentManifest['mcpServers'];

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      name: 'my-server',
      enabled: true,
      addedBy: AGENT.agentPath,
      connection: STDIO_CONNECTION,
    });
    // …and it is persisted, not just returned.
    expect(await service.list(AGENT_ID)).toHaveLength(1);
  });
});

describe('mcp domain error mapping', () => {
  it('re-raises a reserved-name add as a structured CapabilityToolError', async () => {
    // Driven directly (no gate): the service throws AgentMcpServerError, which the
    // capability maps to a CapabilityToolError carrying the code.
    const { deps } = await setup();
    await expect(
      capability('mcp.add').invoke(
        deps,
        { agentId: AGENT_ID, name: 'dorkos', connection: STDIO_CONNECTION },
        {}
      )
    ).rejects.toMatchObject({ name: 'CapabilityToolError', payload: { code: 'RESERVED_NAME' } });
  });

  it('re-raises an unknown-server update as a structured CapabilityToolError', async () => {
    const { deps } = await setup();
    await expect(
      capability('mcp.update').invoke(deps, { agentId: AGENT_ID, name: 'nope', enabled: false }, {})
    ).rejects.toMatchObject({ name: 'CapabilityToolError', payload: { code: 'SERVER_NOT_FOUND' } });
  });

  it('re-raises an unresolvable import as a structured DISCOVERED_NOT_FOUND error', async () => {
    const { deps } = await setup(); // no .mcp.json — nothing to resolve
    await expect(
      capability('mcp.import').invoke(deps, { agentId: AGENT_ID, name: 'ghost' }, {})
    ).rejects.toMatchObject({
      name: 'CapabilityToolError',
      payload: { code: 'DISCOVERED_NOT_FOUND' },
    });
  });

  it('re-raises importing an already-managed name as DUPLICATE_NAME', async () => {
    const { service, deps } = await setup({ dup: { command: 'node' } });
    await service.add({
      agentId: AGENT_ID,
      name: 'dup',
      connection: STDIO_CONNECTION,
      addedBy: 'operator',
    });
    await expect(
      capability('mcp.import').invoke(deps, { agentId: AGENT_ID, name: 'dup' }, {})
    ).rejects.toMatchObject({ name: 'CapabilityToolError', payload: { code: 'DUPLICATE_NAME' } });
  });
});

describe('mcp.import approval card', () => {
  it('names the agent and the discovered server being brought under management', () => {
    // The connection is resolved server-side after the gate, so the card names
    // what the operator decides — the agent and the .mcp.json server — rather
    // than connection.* fields that have no value in the pre-gate input.
    const summary = describeGatedAttempt(capability('mcp.import'), {
      agentId: AGENT_ID,
      name: 'filesystem',
    });
    expect(summary).toContain('name: "filesystem"');
    expect(summary).toContain(`agentId: ${JSON.stringify(AGENT_ID)}`);
  });
});

describe('mcp.import gate enforcement (through registry.invoke)', () => {
  let approvals: ApprovalService;

  beforeEach(() => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
  });
  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /** The approval payload a refused destructive call returns. */
  interface ApprovalCard {
    status: string;
    capabilityId: string;
    tier: string;
    approvalId: string;
    approvalToken: string;
  }

  async function invokeExpectingRefusal(
    registry: CapabilityRegistry,
    input: unknown
  ): Promise<ApprovalCard> {
    try {
      await registry.invoke('mcp.import', input, { identity: AGENT });
    } catch (err) {
      if (err instanceof CapabilityGateRefusal)
        return err.decision.payload as unknown as ApprovalCard;
      throw err;
    }
    throw new Error('Expected mcp.import to be refused by the tier gate, but it ran.');
  }

  it('without approval returns approval_required and writes NOTHING', async () => {
    const { service, deps } = await setup({
      filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
    });
    const registry = composeRegistry([mcpDomain], deps);

    const card = await invokeExpectingRefusal(registry, { agentId: AGENT_ID, name: 'filesystem' });
    expect(card).toMatchObject({
      status: 'approval_required',
      capabilityId: 'mcp.import',
      tier: 'destructive',
    });
    // The gate is the only writer: a refused import left the manifest untouched,
    // so no discovered server was silently promoted.
    expect(await service.list(AGENT_ID)).toEqual([]);
  });

  it('on a granted retry resolves the .mcp.json connection and writes it managed + enabled', async () => {
    const { service, deps } = await setup({
      filesystem: { command: 'npx', args: ['-y', '@mcp/fs'], env: { ROOT: '/tmp' } },
    });
    const registry = composeRegistry([mcpDomain], deps);

    const card = await invokeExpectingRefusal(registry, { agentId: AGENT_ID, name: 'filesystem' });
    approvals.grant(card.approvalId);

    const written = (await registry.invoke(
      'mcp.import',
      { agentId: AGENT_ID, name: 'filesystem' },
      { identity: AGENT, approvalToken: card.approvalToken }
    )) as AgentManifest['mcpServers'];

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      name: 'filesystem',
      enabled: true,
      addedBy: AGENT.agentPath,
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mcp/fs'],
        env: { ROOT: '/tmp' },
      },
    });
    expect(await service.list(AGENT_ID)).toHaveLength(1);
  });
});
