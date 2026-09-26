/**
 * `operator.update_agent_execution` (DOR-2328) under the permission model
 * (spec `agent-permissions`): it lives in Other agents and shows the change it
 * would make, old → new, so it always asks: an area-level Allowed asks, Always
 * allow is never offered, and even an Allowed stored on the action resolves to
 * Ask. A Blocked area refuses it. The Ask path keeps its card and the approval
 * bound to it.
 *
 * (The DOR-2328 behaviour on its own is pinned in `agent-execution-gate.test.ts`,
 * which this file's setup copies.)
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { operatorDomain } from '../operator-capabilities.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import type { AgentPermissions, PermissionOverrides } from '@dorkos/shared/permissions';
import { invokeCapabilityAsMcpResult } from '../../capabilities/mcp-projection.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { initBoundary } from '../../../../lib/boundary.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { AgentIdentity } from '../../agent-identity/index.js';

/** The agent doing the asking. */
const AGENT: AgentIdentity = {
  agentPath: '/projects/warden',
  displayName: 'Warden',
  createdAt: new Date().toISOString(),
};

const SEED = {
  id: '01M054RMQAMZPXHWHRKPGY9Z87',
  name: 'warden',
  displayName: 'Warden',
  description: 'Watches the build and complains loudly.',
  runtime: 'claude-code',
  model: 'claude-sonnet-4',
  capabilities: ['review'],
  behavior: { responseMode: 'always' },
  registeredAt: '2026-08-16T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  mcpServers: [],
} as unknown as AgentManifest;

let agentPath: string;
let registry: CapabilityRegistry;
let approvals: ApprovalService;
let defaults: PermissionOverrides;
let own: AgentPermissions | undefined;

/** The manifest as it stands on disk. */
async function manifestOnDisk(): Promise<AgentManifest> {
  const manifest = await readManifest(agentPath);
  if (!manifest) throw new Error('the seeded agent manifest went missing');
  return manifest;
}

/** Invoke a capability the way an in-session MCP client would (no hold wired). */
async function callTool(
  id: string,
  args: Record<string, unknown>
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const result = await invokeCapabilityAsMcpResult(registry, id, args, { identity: AGENT });
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected a text content block');
  return {
    payload: JSON.parse(block.text) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

beforeEach(async () => {
  agentPath = await realpath(await mkdtemp(join(tmpdir(), 'exec-gate-')));
  await mkdir(join(agentPath, '.dork'), { recursive: true });
  await writeManifest(agentPath, SEED);
  await initBoundary(agentPath);

  registry = composeRegistry([operatorDomain], {
    logger: noopLogger,
    operatorDeps: {} as McpToolDeps,
  });
  approvals = new ApprovalService(createTestDb());
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals });
  defaults = { areas: {}, actions: {} };
  own = undefined;
  initPermissionGate({
    readConfig: () => ({ preset: 'full', defaults }),
    readAgentPermissions: async () => own,
  });
});

afterEach(async () => {
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
  await rm(agentPath, { recursive: true, force: true });
});

const ARGS = { model: 'claude-opus-4' };

describe('changing what an agent runs on, under permissions', () => {
  it('still asks with Other agents Allowed, showing old → new, and writes after a yes', async () => {
    const { payload } = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      ...ARGS,
    });
    expect(payload.status).toBe('approval_required');
    expect(approvals.listPending()[0]).toMatchObject({
      area: 'agents',
      detail: 'Model: claude-sonnet-4 → claude-opus-4',
    });
    expect((await manifestOnDisk()).model).toBe('claude-sonnet-4');

    approvals.grant(String(payload.approvalId));
    const granted = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      ...ARGS,
      approvalToken: payload.approvalToken,
    });
    expect(granted.isError).toBe(false);
    expect((await manifestOnDisk()).model).toBe('claude-opus-4');
  });

  it('never offers Always allow, since the card shows what changes', async () => {
    await callTool('operator.update_agent_execution', { cwd: agentPath, ...ARGS });
    expect(approvals.listPending()[0]).toMatchObject({ alwaysOffered: false });
  });

  it('still asks when an Allowed for this action is stored anyway (a hand-edited file)', async () => {
    own = { actions: { 'operator.update_agent_execution': 'allowed' } };
    const { payload } = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      ...ARGS,
    });
    expect(payload.status).toBe('approval_required');
    expect(approvals.listPending()[0]).toMatchObject({
      detail: 'Model: claude-sonnet-4 → claude-opus-4',
      alwaysOffered: false,
    });
    expect((await manifestOnDisk()).model).toBe('claude-sonnet-4');
  });

  it('refuses with no card when Other agents is Blocked', async () => {
    defaults = { areas: { agents: 'blocked' }, actions: {} };
    const { payload } = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      ...ARGS,
    });
    // A refusal the agent reads, not an approval to wait for.
    expect(payload.status).not.toBe('approval_required');
    expect(JSON.stringify(payload)).toContain('permission_blocked');
    expect(approvals.listPending()).toEqual([]);
    expect((await manifestOnDisk()).model).toBe('claude-sonnet-4');
  });
});
