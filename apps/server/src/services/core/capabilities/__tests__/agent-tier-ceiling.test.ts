/**
 * A tier ceiling set through the affordance actually caps the agent (DOR-486).
 *
 * The ceiling was enforced correctly and reachable by nobody: `mint()` always
 * stamped `destructive`, no manifest field carried a limit, and no surface wrote
 * one — so the gate compared every agent against the widest rung forever. This
 * walks the whole chain with no mock in it, because the defect was exactly that
 * the two halves never met: write the manifest through the same service the
 * self-edit route and the `update_agent` tool use, mint a token the way a spawn
 * does, resolve it the way an HTTP call does, and ask the real gate.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { writeManifest, readManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { defineCapability } from '../capability-definition.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../tier-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentityService,
} from '../../agent-identity/agent-identity-service.js';
import { resolveAgentTokenEnv, AGENT_TOKEN_ENV_VAR } from '../../agent-identity/agent-token-env.js';
import { updateAgentManifest, AgentUpdateError } from '../../operator/agent-updater.js';

/** An agent as it exists before anybody has limited it. */
const SEED = {
  id: '01M054RMQAMZPXHWHRKPGY9Z88',
  name: 'warden',
  displayName: 'Warden',
  description: 'Watches the build.',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  registeredAt: '2026-09-02T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  enabledToolGroups: {},
  mcpServers: [],
} as unknown as AgentManifest;

/** The destructive capability every case asks for. */
const UNINSTALL = defineCapability({
  id: 'demo.uninstall',
  title: 'Uninstall a package',
  description: 'A destructive capability used to probe the ceiling.',
  tier: 'destructive',
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_uninstall', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

let agentPath: string;
let service: AgentIdentityService;

/** Spawn a session the way a runtime does, and resolve the token it was handed. */
async function spawnAndResolve() {
  const env = await resolveAgentTokenEnv(agentPath, 'Warden');
  const token = env[AGENT_TOKEN_ENV_VAR];
  expect(token).toBeDefined();
  return service.resolve(token!);
}

/** Ask the real gate for the destructive capability, as that identity. */
async function askTheGate() {
  const identity = await spawnAndResolve();
  return {
    identity,
    decision: enforceCapabilityTier({
      action: UNINSTALL,
      identity,
      input: { name: 'sentry-monitor' },
      retryChannel: 'mcp-argument',
    }),
  };
}

beforeEach(async () => {
  agentPath = await mkdtemp(join(tmpdir(), 'tier-ceiling-'));
  await writeManifest(agentPath, SEED);
  resetAgentIdentityService();
  service = initAgentIdentityService(createTestDb());
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
});

afterEach(async () => {
  resetAgentIdentityService();
  resetCapabilityTierGate();
  vi.restoreAllMocks();
  await rm(agentPath, { recursive: true, force: true });
});

describe('a ceiling set on the manifest reaches the gate', () => {
  it('leaves an agent that has never been limited exactly as it was', async () => {
    // The migration guarantee: nothing already running loses capability. The
    // call still needs a person's approval — it is destructive — but the ceiling
    // is not what stopped it, and a person CAN unlock it.
    const { identity, decision } = await askTheGate();

    expect(identity?.tierCeiling).toBe('destructive');
    expect(decision.outcome).toBe('approval_required');
  });

  it('refuses the destructive capability, unapprovably, once the ceiling is act', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });

    const { identity, decision } = await askTheGate();

    // The affordance wrote it...
    expect((await readManifest(agentPath))?.tierCeiling).toBe('act');
    // ...the spawn carried it onto the token...
    expect(identity?.tierCeiling).toBe('act');
    // ...and the gate acted on it.
    expect(decision.outcome).toBe('denied');
    if (decision.outcome !== 'denied') throw new Error('unreachable');
    expect(decision.payload.reason).toBe('tier_ceiling');
    expect(decision.payload.approvable).toBe(false);
    expect(decision.payload.message).toContain('Nobody can approve this');
  });

  it('keeps the limit on the next spawn, not just the one that set it', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'observe' } });

    await spawnAndResolve();
    const { identity } = await askTheGate();

    expect(identity?.tierCeiling).toBe('observe');
  });

  it('does not widen a ceiling when the manifest becomes unreadable', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'observe' } });
    await spawnAndResolve();

    // A limit you can delete your way out of is not a limit.
    await rm(join(agentPath, '.dork'), { recursive: true, force: true });
    const { identity, decision } = await askTheGate();

    expect(identity?.tierCeiling).toBe('observe');
    expect(decision.outcome).toBe('denied');
  });
});

describe('an agent may tighten its own ceiling, never widen one', () => {
  it('accepts a lowering from the agent-reachable path', async () => {
    const updated = await updateAgentManifest({ agentPath, body: { tierCeiling: 'observe' } });

    expect(updated.tierCeiling).toBe('observe');
  });

  it('accepts a no-op write of the ceiling it already has', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });
    const updated = await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });

    expect(updated.tierCeiling).toBe('act');
  });

  it('refuses a raise, and changes nothing else in the same patch', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'observe' } });

    await expect(
      updateAgentManifest({
        agentPath,
        body: { tierCeiling: 'destructive', displayName: 'Warden the Unbound' },
      })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    // All-or-nothing, like the seam's other operator-only guards.
    const onDisk = await readManifest(agentPath);
    expect(onDisk?.tierCeiling).toBe('observe');
    expect(onDisk?.displayName).toBe('Warden');
  });

  it('refuses clearing the ceiling, because absent means unrestricted', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });

    const refusal = await updateAgentManifest({
      agentPath,
      body: { tierCeiling: null },
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(AgentUpdateError);
    expect((refusal as AgentUpdateError).code).toBe('OPERATOR_ONLY');
    expect((await readManifest(agentPath))?.tierCeiling).toBe('act');
  });

  it('tells the agent who can change it, and what the two limits are', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'observe' } });

    const refusal = (await updateAgentManifest({
      agentPath,
      body: { tierCeiling: 'act' },
    }).catch((err: unknown) => err)) as AgentUpdateError;

    expect(refusal.message).toContain('Only a person can widen');
    expect(refusal.message).toContain('reading only');
    expect(refusal.message).toContain('changes that can be undone');
  });
});
