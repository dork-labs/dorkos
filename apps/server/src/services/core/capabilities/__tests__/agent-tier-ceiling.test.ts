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
import { agentIdentityTokens, type Db } from '@dorkos/db';
import { writeManifest, readManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { defineCapability } from '../capability-definition.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../tier-enforcement.js';
import {
  enforceToolGroupGrant,
  initToolGroupGate,
  resetToolGroupGate,
} from '../tool-group-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  TOKEN_ABSOLUTE_TTL_MS,
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

/** An `act` capability — the rung a revoked agent must lose and a capped one keeps. */
const RENAME = defineCapability({
  id: 'demo.rename',
  title: 'Rename a thing',
  description: 'An act capability used to probe what revocation takes away.',
  tier: 'act',
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_rename', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

/** An `observe` capability — reading, which no ceiling ever blocks. */
const READ = defineCapability({
  id: 'demo.read',
  title: 'Read a thing',
  description: 'An observe capability used to prove reading survives revocation.',
  tier: 'observe',
  input: z.object({}),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_read', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

/** A capability behind the one per-agent tool group, for the grant drill. */
const MANAGE_ROOMS = defineCapability({
  id: 'demo.manage_rooms',
  title: 'Manage rooms',
  description: 'A capability gated on the rooms-management grant.',
  tier: 'act',
  toolGroup: 'roomsManage',
  input: z.object({}),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_manage_rooms', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

let agentPath: string;
let service: AgentIdentityService;
let identityDb: Db;

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
  identityDb = createTestDb();
  service = initAgentIdentityService(identityDb);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
});

afterEach(async () => {
  resetAgentIdentityService();
  resetCapabilityTierGate();
  resetToolGroupGate();
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

describe('revoking a capped agent shuts it off, and never widens it', () => {
  // The inversion this closes, reproduced before it was fixed: `describeAgent`
  // and `resolve` filtered revoked rows out, so a revoked agent resolved to
  // `undefined`, `undefined` reads as "unidentified" at the gate, and an
  // unidentified caller is capped at DEFAULT_ANONYMOUS_TIER_CEILING —
  // `destructive`. Revoking an agent capped at `act` therefore let it reach
  // MORE than before it was revoked.
  it('does not hand a revoked agent the anonymous (widest) ceiling', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });
    await spawnAndResolve();

    await service.revoke(agentPath);
    const identity = await service.describeAgent(agentPath);

    // Named, not erased — that is what lets the gate tell it from a stranger.
    expect(identity?.agentPath).toBe(agentPath);
    expect(identity?.inactive).toBe('revoked');
  });

  it('refuses an act call a revoked agent could make one moment earlier', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });
    await spawnAndResolve();
    const before = enforceCapabilityTier({
      action: RENAME,
      identity: await service.describeAgent(agentPath),
      input: { name: 'x' },
      retryChannel: 'mcp-argument',
    });
    // Nothing to prove if the call was not allowed to begin with.
    expect(before.outcome).toBe('allowed');

    await service.revoke(agentPath);
    const after = enforceCapabilityTier({
      action: RENAME,
      identity: await service.describeAgent(agentPath),
      input: { name: 'x' },
      retryChannel: 'mcp-argument',
    });

    expect(after.outcome).toBe('denied');
    if (after.outcome !== 'denied') throw new Error('unreachable');
    expect(after.payload.reason).toBe('tier_ceiling');
    expect(after.payload.approvable).toBe(false);
    expect(after.payload.message).toContain('access was turned off');
  });

  it('shuts off the bearer path too, not only the in-session one', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });
    const env = await resolveAgentTokenEnv(agentPath, 'Warden');
    await service.revoke(agentPath);

    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);

    expect(identity?.inactive).toBe('revoked');
    expect(
      enforceCapabilityTier({
        action: RENAME,
        identity,
        input: { name: 'x' },
        retryChannel: 'mcp-argument',
      }).outcome
    ).toBe('denied');
  });

  it('still lets a revoked agent read, exactly as a stranger may', async () => {
    await service.revoke(agentPath);
    await spawnAndResolve();
    await service.revoke(agentPath);

    const decision = enforceCapabilityTier({
      action: READ,
      identity: await service.describeAgent(agentPath),
      input: {},
      retryChannel: 'mcp-argument',
    });

    expect(decision.outcome).toBe('allowed');
  });

  it('takes every tool-group grant away with it', async () => {
    // The seam that would have quietly INVERTED the other way: this gate keyed
    // on identity presence, and revoked identities used to be absent. Naming
    // them would have handed a revoked agent every grant on its manifest.
    initToolGroupGate({ grants: { holds: async () => true } });
    await spawnAndResolve();
    const live = await service.describeAgent(agentPath);
    expect((await enforceToolGroupGrant({ action: MANAGE_ROOMS, identity: live })).outcome).toBe(
      'allowed'
    );

    await service.revoke(agentPath);
    const revoked = await service.describeAgent(agentPath);

    const decision = await enforceToolGroupGrant({ action: MANAGE_ROOMS, identity: revoked });
    expect(decision.outcome).toBe('denied');
  });

  it('gives a fresh spawn its identity back', async () => {
    await updateAgentManifest({ agentPath, body: { tierCeiling: 'act' } });
    await spawnAndResolve();
    await service.revoke(agentPath);

    // Revocation is agent-wide and permanent for the tokens it swept; a new
    // spawn mints a new one, which is how an agent comes back.
    const identity = await spawnAndResolve();

    expect(identity?.inactive).toBeUndefined();
    expect(identity?.tierCeiling).toBe('act');
  });
});

describe('a token that has aged out cannot spend what the live agent was granted', () => {
  /** Age every stored token past the absolute cap, which no use resets. */
  function expireEveryToken(): void {
    const longAgo = new Date(Date.now() - TOKEN_ABSOLUTE_TTL_MS - 60_000).toISOString();
    identityDb.update(agentIdentityTokens).set({ createdAt: longAgo, lastUsedAt: longAgo }).run();
  }

  it('refuses to resolve a standing permission for an expired identity', async () => {
    // Found by the DOR-486 sweep rather than by review. A standing permission is
    // keyed on `agentPath`, and an expired token used to arrive as `undefined` —
    // no identity, no grant. It now arrives NAMED and keeps its recorded ceiling,
    // so without the `inactive` test in `resolveStandingGrant` a dead token could
    // spend a permission a person granted the LIVE agent and skip the card.
    initCapabilityTierGate({
      approvals: new ApprovalService(createTestDb()),
      standingGrants: {
        enabled: () => true,
        findLive: () => ({ id: 'grant-1' }) as never,
      },
    });
    const env = await resolveAgentTokenEnv(agentPath, 'Warden');
    expireEveryToken();
    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);
    expect(identity?.inactive).toBe('expired');

    const decision = enforceCapabilityTier({
      action: UNINSTALL,
      identity,
      input: { name: 'sentry-monitor' },
      retryChannel: 'mcp-argument',
    });

    // A person is asked, exactly as if no permission existed.
    expect(decision.outcome).toBe('approval_required');
  });

  it('still resolves it for the live agent, which is the control', async () => {
    initCapabilityTierGate({
      approvals: new ApprovalService(createTestDb()),
      standingGrants: {
        enabled: () => true,
        findLive: () => ({ id: 'grant-1' }) as never,
      },
    });
    const env = await resolveAgentTokenEnv(agentPath, 'Warden');
    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);

    const decision = enforceCapabilityTier({
      action: UNINSTALL,
      identity,
      input: { name: 'sentry-monitor' },
      retryChannel: 'mcp-argument',
    });

    expect(decision.outcome).toBe('allowed');
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
