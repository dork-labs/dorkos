/**
 * A turned-off agent reaches nothing it could not before, on either path an
 * identity arrives by (DOR-486, carried into the permission model).
 *
 * Revoking an agent, or its token ageing out, used to erase its identity, and an
 * erased identity reads as "unidentified" at the gate, which is decided on the
 * install's defaults: turning an agent off could widen it. Identities now arrive
 * NAMED and marked `inactive`, so this walks the whole chain with no mock in it:
 * mint a token the way a spawn does, resolve it the way an HTTP call does, and
 * ask the real gate.
 *
 * (Until spec `agent-permissions` phase 3 this file also pinned the per-agent
 * tier ceiling, which Blocked permission areas replaced.)
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
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { defineCapability } from '../capability-definition.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
} from '../permission-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  TOKEN_ABSOLUTE_TTL_MS,
  type AgentIdentityService,
} from '../../agent-identity/agent-identity-service.js';
import { resolveAgentTokenEnv, AGENT_TOKEN_ENV_VAR } from '../../agent-identity/agent-token-env.js';

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
  mcpServers: [],
} as unknown as AgentManifest;

/** An `act` capability with no area — the rung a revoked agent must lose. */
const RENAME = defineCapability({
  id: 'demo.rename',
  title: 'Rename a thing',
  description: 'An act capability used to probe what revocation takes away.',
  tier: 'act',
  area: null,
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_rename', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

/** An `observe` capability — reading, which a revoked agent keeps. */
const READ = defineCapability({
  id: 'demo.read',
  title: 'Read a thing',
  description: 'An observe capability used to prove reading survives revocation.',
  tier: 'observe',
  area: null,
  input: z.object({}),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_read', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

/** A capability in the Rooms permission area, for the permission drill. */
const MANAGE_ROOMS = defineCapability({
  id: 'demo.manage_rooms',
  title: 'Manage rooms',
  description: 'A capability in the Rooms permission area.',
  tier: 'act',
  area: 'rooms',
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

beforeEach(async () => {
  agentPath = await mkdtemp(join(tmpdir(), 'inactive-identity-'));
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
  resetPermissionGate();
  vi.restoreAllMocks();
  await rm(agentPath, { recursive: true, force: true });
});

describe('revoking an agent shuts it off, and never widens it', () => {
  // The inversion this closes, reproduced before it was fixed: `describeAgent`
  // and `resolve` filtered revoked rows out, so a revoked agent resolved to
  // `undefined`, and `undefined` reads as "unidentified" at the gate, which is
  // decided on the install's defaults. Revoking a narrowed agent therefore let
  // it reach MORE than before it was revoked.
  it('names a revoked agent rather than treating it as a stranger', async () => {
    await spawnAndResolve();

    await service.revoke(agentPath);
    const identity = await service.describeAgent(agentPath);

    // Named, not erased — that is what lets the gate tell it from a stranger.
    expect(identity?.agentPath).toBe(agentPath);
    expect(identity?.inactive).toBe('revoked');
  });

  it('refuses an act call a revoked agent could make one moment earlier', async () => {
    await spawnAndResolve();
    const before = enforceCapabilityTier({
      permission: null,
      action: RENAME,
      identity: await service.describeAgent(agentPath),
      input: { name: 'x' },
      retryChannel: 'mcp-argument',
    });
    // Nothing to prove if the call was not allowed to begin with.
    expect(before.outcome).toBe('allowed');

    await service.revoke(agentPath);
    const after = enforceCapabilityTier({
      permission: null,
      action: RENAME,
      identity: await service.describeAgent(agentPath),
      input: { name: 'x' },
      retryChannel: 'mcp-argument',
    });

    expect(after.outcome).toBe('denied');
    if (after.outcome !== 'denied') throw new Error('unreachable');
    expect(after.payload.reason).toBe('permission_blocked');
    expect(after.payload.approvable).toBe(false);
    expect(after.payload.message).toContain('access was turned off');
  });

  it('shuts off the bearer path too, not only the in-session one', async () => {
    const env = await resolveAgentTokenEnv(agentPath, 'Warden');
    await service.revoke(agentPath);

    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);

    expect(identity?.inactive).toBe('revoked');
    expect(
      enforceCapabilityTier({
        permission: null,
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
      permission: null,
      action: READ,
      identity: await service.describeAgent(agentPath),
      input: {},
      retryChannel: 'mcp-argument',
    });

    expect(decision.outcome).toBe('allowed');
  });

  it('takes every Allowed permission away with it', async () => {
    // The seam that would have quietly INVERTED the other way: revoked
    // identities used to be absent, and are named now. Without the inactive
    // rule, naming them would hand a revoked agent every permission its
    // manifest allows.
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => ({ areas: { rooms: 'allowed' } }),
    });
    await spawnAndResolve();
    const live = await service.describeAgent(agentPath);
    const liveDecision = enforceCapabilityTier({
      action: MANAGE_ROOMS,
      identity: live,
      permission: await resolveCallPermission({ action: MANAGE_ROOMS, identity: live }),
      input: {},
      retryChannel: 'mcp-argument',
    });
    expect(liveDecision.outcome).toBe('allowed');

    await service.revoke(agentPath);
    const revoked = await service.describeAgent(agentPath);

    const decision = enforceCapabilityTier({
      action: MANAGE_ROOMS,
      identity: revoked,
      permission: await resolveCallPermission({ action: MANAGE_ROOMS, identity: revoked }),
      input: {},
      retryChannel: 'mcp-argument',
    });
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'permission_blocked', approvable: false },
    });
  });

  it('gives a fresh spawn its identity back', async () => {
    await spawnAndResolve();
    await service.revoke(agentPath);

    // Revocation is agent-wide and permanent for the tokens it swept; a new
    // spawn mints a new one, which is how an agent comes back.
    const identity = await spawnAndResolve();

    expect(identity?.inactive).toBeUndefined();
    expect(identity?.agentPath).toBe(agentPath);
  });
});

describe('a token that has aged out cannot spend what the live agent was granted', () => {
  /** Age every stored token past the absolute cap, which no use resets. */
  function expireEveryToken(): void {
    const longAgo = new Date(Date.now() - TOKEN_ABSOLUTE_TTL_MS - 60_000).toISOString();
    identityDb.update(agentIdentityTokens).set({ createdAt: longAgo, lastUsedAt: longAgo }).run();
  }

  it('refuses to let an expired identity spend an Always allow', async () => {
    // Found by the DOR-486 sweep rather than by review, and carried over from
    // standing permissions: an Always allow is keyed on `agentPath`, and an
    // expired token now arrives NAMED, so without the `inactive` rule a dead
    // token could spend a setting a person gave the LIVE agent.
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => ({ actions: { [MANAGE_ROOMS.id]: 'allowed' } }),
    });
    const env = await resolveAgentTokenEnv(agentPath, 'Warden');
    expireEveryToken();
    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);
    expect(identity?.inactive).toBe('expired');

    const permission = await resolveCallPermission({ action: MANAGE_ROOMS, identity });
    const decision = enforceCapabilityTier({
      permission,
      action: MANAGE_ROOMS,
      identity,
      input: {},
      retryChannel: 'mcp-argument',
    });

    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') expect(decision.payload.approvable).toBe(false);
  });

  it('still honors it for the live agent, which is the control', async () => {
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => ({ actions: { [MANAGE_ROOMS.id]: 'allowed' } }),
    });
    const env = await resolveAgentTokenEnv(agentPath, 'Warden');
    const identity = await service.resolve(env[AGENT_TOKEN_ENV_VAR]!);

    const permission = await resolveCallPermission({ action: MANAGE_ROOMS, identity });
    const decision = enforceCapabilityTier({
      permission,
      action: MANAGE_ROOMS,
      identity,
      input: {},
      retryChannel: 'mcp-argument',
    });

    expect(decision.outcome).toBe('allowed');
  });
});
