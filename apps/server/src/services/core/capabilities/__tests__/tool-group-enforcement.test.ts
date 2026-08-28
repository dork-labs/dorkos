/**
 * The per-agent tool-group gate, driven through `registry.invoke` — the only way
 * any surface reaches it (spec `rooms-management-tools` §D1–D3, DOR-1611).
 *
 * The design is a FAIL DIRECTION, so this file is that table rather than a
 * handful of happy paths: an identified agent holding the grant runs, and every
 * other resolvable caller — no grant, grant `false`, a lookup that throws, no
 * identity at all, no lookup wired — is refused. Each row is asserted through the
 * registry with a real refusal shape, and the discrimination pair (same call,
 * grant flipped) is asserted so the check cannot pass by being always-red.
 *
 * Two orderings carry weight and are pinned:
 *
 * - The group gate runs BEFORE the tier gate. A `destructive` capability an agent
 *   may never reach must not mint an approval card on the way to being refused,
 *   so the refusal is `tool_group_disabled` and the approval store stays empty.
 * - The grant is read FRESH. The manifest test writes a real `.dork/agent.json`,
 *   invokes, rewrites the file, and invokes again in the same process — the
 *   "turning it off stops the very next call" guarantee, with no restart and no
 *   re-wiring in between.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createTestDb } from '@dorkos/test-utils/db';

import { composeRegistry, type CapabilityRegistry } from '../registry.js';
import { defineCapability } from '../capability-definition.js';
import {
  CapabilityGateRefusal,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type TierDeniedPayload,
  type TierEnforcementAttempt,
} from '../tier-enforcement.js';
import {
  initToolGroupGate,
  resetToolGroupGate,
  type ToolGroupGrantLookup,
} from '../tool-group-enforcement.js';
import { manifestToolGroupGrants } from '../tool-group-grants.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

/** The agent every row calls as. */
const AGENT_PATH = '/projects/prober';

/** Set by the gated capability's handler if the gate ever lets a call through. */
let handlerRan = false;

/** A capability declaring the hard group, at the given tier. */
function gated(tier: 'act' | 'destructive' = 'act') {
  return defineCapability({
    id: `demo.${tier}_gated`,
    title: `Demo ${tier} gated`,
    description: 'A demonstration capability behind the rooms-management grant.',
    tier,
    input: z.object({}),
    output: z.unknown(),
    surfaces: { mcp: { toolName: `demo_${tier}_gated`, servers: ['in-session', 'external'] } },
    toolGroup: 'roomsManage',
    ...(tier === 'destructive' ? { approvalDisplayFields: [] as readonly string[] } : {}),
    invoke: async () => {
      handlerRan = true;
      return { ok: true };
    },
  });
}

/** The same capability with no group declared — the shape of everything today. */
const UNGATED = defineCapability({
  id: 'demo.ungated',
  title: 'Demo ungated',
  description: 'A demonstration capability declaring no tool group.',
  tier: 'act',
  input: z.object({}),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_ungated', servers: ['in-session', 'external'] } },
  invoke: async () => {
    handlerRan = true;
    return { ok: true };
  },
});

/** An identity for the agent the grant is keyed on. */
const IDENTITY: AgentIdentity = {
  agentPath: AGENT_PATH,
  displayName: 'Prober',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

/** A lookup that answers one fixed value for every agent. */
function lookupReturning(held: boolean): ToolGroupGrantLookup {
  return { holds: async () => held };
}

/**
 * Invoke and report the refusal payload, asserting that the call was refused at
 * all — so a row that silently RAN is a failure with a readable message rather
 * than an undefined dereference.
 */
async function refusalFrom(
  registry: CapabilityRegistry,
  id: string,
  identity?: AgentIdentity
): Promise<TierDeniedPayload> {
  let thrown: unknown;
  try {
    await registry.invoke(id, {}, identity ? { identity } : {});
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `${id} was not refused`).toBeInstanceOf(CapabilityGateRefusal);
  const decision = (thrown as CapabilityGateRefusal).decision;
  expect(decision.outcome).toBe('denied');
  return decision.payload as TierDeniedPayload;
}

describe('the per-agent tool-group gate', () => {
  let registry: CapabilityRegistry;
  let attempts: TierEnforcementAttempt[];
  let approvals: ApprovalService;

  beforeEach(() => {
    handlerRan = false;
    attempts = [];
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    approvals = new ApprovalService(createTestDb());
    // The tier gate is armed exactly as boot arms it, so a call that got past the
    // group gate would take the real tier path and leave a real approval behind.
    initCapabilityTierGate({ approvals });
    registry = composeRegistry(
      [{ name: 'demo', capabilities: [gated('act'), gated('destructive'), UNGATED] }],
      { logger: noopLogger }
    );
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetToolGroupGate();
    vi.restoreAllMocks();
  });

  describe('the fail table', () => {
    it('runs for an identified agent holding the grant', async () => {
      initToolGroupGate({ grants: lookupReturning(true) });

      await expect(registry.invoke('demo.act_gated', {}, { identity: IDENTITY })).resolves.toEqual({
        ok: true,
      });
      expect(handlerRan).toBe(true);
    });

    it('refuses an identified agent whose grant is off', async () => {
      initToolGroupGate({ grants: lookupReturning(false) });

      const payload = await refusalFrom(registry, 'demo.act_gated', IDENTITY);

      expect(payload.reason).toBe('tool_group_disabled');
      expect(handlerRan).toBe(false);
    });

    it('refuses when the lookup THROWS, rather than reading a broken store as a yes', async () => {
      initToolGroupGate({
        grants: {
          holds: async () => {
            throw new Error('the manifest could not be read');
          },
        },
      });

      const payload = await refusalFrom(registry, 'demo.act_gated', IDENTITY);

      expect(payload.reason).toBe('tool_group_disabled');
      expect(handlerRan).toBe(false);
    });

    it('refuses a caller that presented no identity, without asking the lookup', async () => {
      const holds = vi.fn(async () => true);
      initToolGroupGate({ grants: { holds } });

      const payload = await refusalFrom(registry, 'demo.act_gated');

      expect(payload.reason).toBe('tool_group_disabled');
      // An anonymous caller has no agent path to key on, so there is nothing to
      // ask — a lookup consulted here would be answering about somebody else.
      expect(holds).not.toHaveBeenCalled();
      expect(handlerRan).toBe(false);
    });

    it('refuses when boot wired no lookup at all', async () => {
      // `resetToolGroupGate` in `afterEach` leaves this state; asserted rather
      // than assumed, because "unwired" is the state a wiring mistake produces
      // and it must fail closed rather than open.
      const payload = await refusalFrom(registry, 'demo.act_gated', IDENTITY);

      expect(payload.reason).toBe('tool_group_disabled');
      expect(handlerRan).toBe(false);
    });

    it('lets a trusted caller through, having already proved it may decide approvals', async () => {
      initToolGroupGate({ grants: lookupReturning(false) });
      const { trustedCaller } = await import('../trusted-caller.js');
      // The person in their own cockpit, on the login-off default posture.
      const trusted = trustedCaller({
        agentIdentityPresented: false,
        approvalTokenPresented: false,
        loginEnabled: () => false,
      })!;

      await expect(registry.invoke('demo.act_gated', {}, { trusted })).resolves.toEqual({
        ok: true,
      });
    });
  });

  it('leaves a capability that declares NO tool group untouched', async () => {
    // No lookup wired, no identity presented — the state that refuses every gated
    // capability above. An ungated one must not notice the gate exists.
    await expect(registry.invoke('demo.ungated', {})).resolves.toEqual({ ok: true });
    expect(handlerRan).toBe(true);
  });

  it('discriminates: the same call, the same caller, only the grant changed', async () => {
    initToolGroupGate({ grants: lookupReturning(false) });
    const refused = await refusalFrom(registry, 'demo.act_gated', IDENTITY);
    expect(refused.reason).toBe('tool_group_disabled');

    initToolGroupGate({ grants: lookupReturning(true) });
    await expect(registry.invoke('demo.act_gated', {}, { identity: IDENTITY })).resolves.toEqual({
      ok: true,
    });
  });

  it('refuses with a payload every existing surface already knows how to render', async () => {
    initToolGroupGate({ grants: lookupReturning(false) });

    const payload = await refusalFrom(registry, 'demo.act_gated', IDENTITY);

    expect(payload).toMatchObject({
      status: 'denied',
      capabilityId: 'demo.act_gated',
      capabilityTitle: 'Demo act gated',
      tier: 'act',
      reason: 'tool_group_disabled',
      // Load-bearing: no approval can ever unlock this, so a model told
      // otherwise would loop asking for one.
      approvable: false,
    });
    // The remedy, and who owns it — the sentence the agent relays to the person.
    expect(payload.message).toContain('Manage rooms');
    expect(payload.message).toContain('Tools settings');
  });

  it('runs BEFORE the tier gate, so a refused destructive call mints no approval', async () => {
    initToolGroupGate({ grants: lookupReturning(false) });

    const payload = await refusalFrom(registry, 'demo.destructive_gated', IDENTITY);

    // Not `approval_required`, and not `tier_ceiling`: the group answered first.
    expect(payload.reason).toBe('tool_group_disabled');
    // The half that matters. An approval card for an action that was never going
    // to run is a question the operator cannot usefully answer.
    expect(approvals.listPending()).toEqual([]);
  });

  it('reports every refusal to the audit hook, so the operator sees what was tried', async () => {
    initToolGroupGate({
      grants: lookupReturning(false),
      onAttempt: (attempt) => attempts.push(attempt),
    });

    await refusalFrom(registry, 'demo.act_gated', IDENTITY);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.action.id).toBe('demo.act_gated');
    expect(attempts[0]!.identity?.agentPath).toBe(AGENT_PATH);
    expect(attempts[0]!.decision.outcome).toBe('denied');
  });

  it('never turns a broken audit hook into a broken gate', async () => {
    initToolGroupGate({
      grants: lookupReturning(false),
      onAttempt: () => {
        throw new Error('the activity feed is down');
      },
    });

    const payload = await refusalFrom(registry, 'demo.act_gated', IDENTITY);
    expect(payload.reason).toBe('tool_group_disabled');
  });
});

describe('the grant read off a real agent manifest', () => {
  let registry: CapabilityRegistry;
  let agentDir: string;

  /** A manifest for the agent at `agentDir`, with the grant set as given. */
  function manifestWith(roomsManage?: boolean): AgentManifest {
    return {
      id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      name: 'prober',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'test',
      personaEnabled: true,
      enabledToolGroups: roomsManage === undefined ? {} : { roomsManage },
      mcpServers: [],
      workspace: { mode: 'home' },
    } as unknown as AgentManifest;
  }

  /** The identity for the agent living at `agentDir`. */
  function identity(): AgentIdentity {
    return {
      agentPath: agentDir,
      displayName: 'Prober',
      tierCeiling: 'destructive',
      createdAt: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    handlerRan = false;
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-group-grant-'));
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    // The REAL production lookup over a REAL manifest file: a stub here could
    // agree with the gate and disagree with the disk, which is the failure mode
    // the SQLite cache would have introduced (it carries no such field at all).
    initToolGroupGate({ grants: manifestToolGroupGrants() });
    registry = composeRegistry([{ name: 'demo', capabilities: [gated('act')] }], {
      logger: noopLogger,
    });
  });

  afterEach(async () => {
    resetCapabilityTierGate();
    resetToolGroupGate();
    vi.restoreAllMocks();
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it('takes a revoked grant on the VERY NEXT call, with no restart', async () => {
    await writeManifest(agentDir, manifestWith(true));
    await expect(registry.invoke('demo.act_gated', {}, { identity: identity() })).resolves.toEqual({
      ok: true,
    });

    // The person turns it off. Nothing is re-wired and nothing is restarted.
    await writeManifest(agentDir, manifestWith(false));

    const payload = await refusalFrom(registry, 'demo.act_gated', identity());
    expect(payload.reason).toBe('tool_group_disabled');
  });

  it('reads an absent key as off, never as inherit', async () => {
    await writeManifest(agentDir, manifestWith(undefined));

    const payload = await refusalFrom(registry, 'demo.act_gated', identity());
    expect(payload.reason).toBe('tool_group_disabled');
  });

  it('reads a directory with no manifest at all as off', async () => {
    const payload = await refusalFrom(registry, 'demo.act_gated', identity());
    expect(payload.reason).toBe('tool_group_disabled');
  });
});
