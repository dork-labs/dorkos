/**
 * An agent cannot change what an agent runs on, which model, or how hard it
 * thinks, without a person seeing it first (DOR-2328).
 *
 * A schedule that leaves its runtime, model or effort unset follows its agent,
 * and a person's approval of that schedule records the unset value, not the
 * agent's (DOR-2323). So an agent that could rewrite an agent's defaults could
 * move every such approved schedule to another runtime or a costlier model
 * without anybody being asked. These cases drive the REAL operator domain
 * through the REAL registry and MCP adapter against a REAL agent on disk:
 *
 * - `operator.update_agent` refuses the three fields, whatever they hold, with a
 *   pointer to the gated tool, and applies none of the rest of the patch.
 * - `operator.update_agent_execution` asks a person first, shows what changes
 *   old → new on the card, and writes only after a grant.
 * - The approval is bound to the values it showed: if the agent's defaults move
 *   between the card and the retry, the token no longer fits and a fresh card
 *   says what would change now.
 * - A person (a trusted caller) is never asked.
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
  resetCapabilityTierGate,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { invokeCapabilityAsMcpResult } from '../../capabilities/mcp-projection.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { initBoundary } from '../../../../lib/boundary.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { AgentIdentity } from '../../agent-identity/index.js';

import { trustedCaller } from '../../capabilities/trusted-caller.js';

/** The agent doing the asking. */
const AGENT: AgentIdentity = {
  agentPath: '/projects/warden',
  displayName: 'Warden',
  tierCeiling: 'destructive',
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
  enabledToolGroups: {},
  mcpServers: [],
} as unknown as AgentManifest;

let agentPath: string;
let registry: CapabilityRegistry;
let approvals: ApprovalService;

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
});

afterEach(async () => {
  resetCapabilityTierGate();
  vi.restoreAllMocks();
  await rm(agentPath, { recursive: true, force: true });
});

describe('operator.update_agent refuses the execution defaults', () => {
  it.each([
    ['runtime', 'codex'],
    ['model', 'claude-opus-4'],
    ['effort', 'max'],
    ['model', null],
  ])('refuses %s (%s) with a pointer to the gated tool', async (field, value) => {
    const { payload, isError } = await callTool('operator.update_agent', {
      cwd: agentPath,
      displayName: 'Unwarden',
      [field]: value,
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('NEEDS_APPROVAL');
    expect(String(payload.error)).toContain('update_agent_execution');
    // All-or-nothing: the rest of the patch is not applied either.
    const onDisk = await manifestOnDisk();
    expect(onDisk.displayName).toBe('Warden');
    expect(onDisk.model).toBe('claude-sonnet-4');
    expect(onDisk.runtime).toBe('claude-code');
  });
});

describe('operator.update_agent_execution asks a person first', () => {
  it('writes nothing until someone approves, and says old → new on the card', async () => {
    const { payload } = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      model: 'claude-opus-4',
      effort: 'high',
    });

    expect(payload.status).toBe('approval_required');
    expect(payload.tier).toBe('destructive');
    expect((await manifestOnDisk()).model).toBe('claude-sonnet-4');
    const [pending] = approvals.listPending();
    expect(pending!.detail).toBe(
      'Model: claude-sonnet-4 → claude-opus-4\nEffort: the default → high'
    );
  });

  it('writes the change once granted and its token presented', async () => {
    const args = { cwd: agentPath, runtime: 'codex', model: 'gpt-5' };
    const { payload } = await callTool('operator.update_agent_execution', args);
    expect(approvals.grant(String(payload.approvalId))).toBeUndefined();

    const granted = await callTool('operator.update_agent_execution', {
      ...args,
      approvalToken: payload.approvalToken,
    });

    expect(granted.isError).toBe(false);
    const onDisk = await manifestOnDisk();
    expect(onDisk.runtime).toBe('codex');
    expect(onDisk.model).toBe('gpt-5');
  });

  it('clears a value back to following the default with null', async () => {
    const args = { cwd: agentPath, model: null };
    const { payload } = await callTool('operator.update_agent_execution', args);
    expect(approvals.listPending()[0]!.detail).toBe('Model: claude-sonnet-4 → the default');
    approvals.grant(String(payload.approvalId));

    await callTool('operator.update_agent_execution', {
      ...args,
      approvalToken: payload.approvalToken,
    });

    expect((await manifestOnDisk()).model).toBeUndefined();
  });

  it('refuses the approved token when the defaults moved since the card, and asks again', async () => {
    // Interleaving: the card said claude-sonnet-4 → claude-opus-4. A person
    // then switched the agent to another model in the app. The old approval
    // must not now be spent on a change nobody was shown.
    const args = { cwd: agentPath, model: 'claude-opus-4' };
    const first = await callTool('operator.update_agent_execution', args);
    approvals.grant(String(first.payload.approvalId));
    await writeManifest(agentPath, { ...SEED, model: 'claude-haiku-4' } as AgentManifest);

    const retry = await callTool('operator.update_agent_execution', {
      ...args,
      approvalToken: first.payload.approvalToken,
    });

    expect(retry.payload.status).toBe('approval_required');
    expect((await manifestOnDisk()).model).toBe('claude-haiku-4');
    const fresh = approvals.listPending().find((p) => p.approvalId === retry.payload.approvalId);
    expect(fresh!.detail).toBe('Model: claude-haiku-4 → claude-opus-4');
  });

  it('refuses a call that changes nothing, before any card', async () => {
    const { payload, isError } = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('VALIDATION');
  });

  it('refuses a call whose values are already in place, and lists only real changes', async () => {
    // Purpose: a card reading "Model: claude-sonnet-4 → claude-sonnet-4" asks a
    // person to approve nothing, and an unchanged field padding a real change
    // hides which line matters.
    const same = await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      runtime: 'claude-code',
      model: 'claude-sonnet-4',
    });
    expect(same.isError).toBe(true);
    expect(same.payload.code).toBe('VALIDATION');
    expect(approvals.listPending()).toHaveLength(0);

    await callTool('operator.update_agent_execution', {
      cwd: agentPath,
      runtime: 'claude-code',
      model: 'claude-opus-4',
    });
    expect(approvals.listPending()[0]!.detail).toBe('Model: claude-sonnet-4 → claude-opus-4');
  });

  it('never asks a person who makes the change themselves', async () => {
    const result = await registry.invoke(
      'operator.update_agent_execution',
      { cwd: agentPath, model: 'claude-opus-4' },
      {
        trusted: trustedCaller({
          agentIdentityPresented: false,
          approvalTokenPresented: false,
          loginEnabled: () => false,
        })!,
      }
    );

    expect(result).toBeDefined();
    expect(approvals.listPending()).toHaveLength(0);
    expect((await manifestOnDisk()).model).toBe('claude-opus-4');
  });
});
