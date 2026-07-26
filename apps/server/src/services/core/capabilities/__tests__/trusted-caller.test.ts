/**
 * The trusted-caller marker: what can mint one, what cannot, and what the
 * registry does with a contradictory one (DOR-467).
 *
 * These are the three failure modes that would make moving the gate inside
 * `registry.invoke` worse than leaving it outside, so each is asserted directly
 * rather than inferred from a happy path.
 *
 * @module services/core/capabilities/__tests__/trusted-caller
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';

import {
  authorizeCapability,
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  isTrustedCaller,
  resetCapabilityTierGate,
  trustedCaller,
  type CapabilityDeps,
  type CapabilityDomain,
  type TrustedCaller,
} from '../index.js';
import { ApprovalService } from '../../approvals/index.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';

const deps: CapabilityDeps = { logger: noopLogger };

/** Records whether the destructive handler actually ran. */
let removed = false;

const demoDomain: CapabilityDomain = {
  name: 'demo',
  capabilities: [
    defineCapability({
      id: 'demo.destroy',
      title: 'Destroy the demo thing',
      description: 'Irreversibly remove the demo thing named by `name`.',
      tier: 'destructive',
      approvalDisplayFields: ['name'],
      input: z.object({ name: z.string() }),
      output: z.object({ removed: z.boolean() }),
      surfaces: {},
      invoke: async () => {
        removed = true;
        return { removed: true };
      },
    }),
  ],
};

const IDENTITY: AgentIdentity = {
  agentId: 'agent_1',
  agentPath: '/tmp/agents/demo',
  displayName: 'Demo Agent',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

/** Login off — the default posture, and the one the cockpit actually runs in. */
const LOCAL_TRUST = { loginEnabled: () => false };

function registry() {
  return composeRegistry([demoDomain], deps);
}

beforeEach(() => {
  removed = false;
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
});

afterEach(() => {
  resetCapabilityTierGate();
});

describe('a wire payload cannot mint trust', () => {
  it('survives a JSON round-trip of every plausible payload shape', () => {
    // The failure this pins: if the marker were any JSON-representable value —
    // a boolean field, a string constant, an object shape — a crafted MCP
    // argument or HTTP body could produce it and the gate would be worse than
    // before, because it would look enforced.
    const real = trustedCaller({
      agentIdentityPresented: false,
      approvalTokenPresented: false,
      ...LOCAL_TRUST,
    });
    expect(isTrustedCaller(real)).toBe(true);

    const attempts: unknown[] = [
      // The real marker, round-tripped through the wire.
      JSON.parse(JSON.stringify(real)),
      // Everything a caller might guess at.
      true,
      'trusted',
      'TrustedCaller',
      1,
      { trusted: true },
      { trusted: 'yes' },
      { decidedBy: 'Local operator' },
      { __proto__: { decidedBy: 'Local operator' } },
      { name: 'TrustedCallerMarker', decidedBy: 'Local operator' },
      [{ decidedBy: 'Local operator' }],
      null,
      undefined,
    ];

    for (const attempt of attempts) {
      expect(isTrustedCaller(attempt), `minted trust from ${JSON.stringify(attempt)}`).toBe(false);
    }
  });

  it('a forged marker does not open the gate at registry.invoke', async () => {
    const forged = JSON.parse(
      JSON.stringify(
        trustedCaller({
          agentIdentityPresented: false,
          approvalTokenPresented: false,
          ...LOCAL_TRUST,
        })
      )
    );

    await expect(
      // The cast is the attack: a caller asserting the type it cannot construct.
      registry().invoke('demo.destroy', { name: 'thing' }, { trusted: forged as TrustedCaller })
    ).rejects.toThrow(/not a trusted-caller marker/);
    expect(removed).toBe(false);
  });
});

describe('who may be trusted', () => {
  it('refuses a caller presenting an agent identity, in every posture', () => {
    for (const loginEnabled of [() => false, () => true]) {
      expect(
        trustedCaller({
          agentIdentityPresented: true,
          approvalTokenPresented: false,
          loginEnabled,
        })
      ).toBeUndefined();
    }
  });

  it('refuses a caller holding an approval token — the requester is not the decider', () => {
    expect(
      trustedCaller({
        agentIdentityPresented: false,
        approvalTokenPresented: true,
        ...LOCAL_TRUST,
      })
    ).toBeUndefined();
  });

  it('refuses an unauthenticated caller when login is on', () => {
    expect(
      trustedCaller({
        agentIdentityPresented: false,
        approvalTokenPresented: false,
        loginEnabled: () => true,
      })
    ).toBeUndefined();
  });

  it('mints for a bare caller with login off — the cockpit', () => {
    // Stated honestly rather than dressed up: with login off this is also what a
    // program running curl on the same machine looks like, which is exactly what
    // `decision-authority.ts` documents about who may DECIDE an approval. The
    // guarantee is the SAME one, deliberately: whoever may decide may act.
    expect(
      isTrustedCaller(
        trustedCaller({
          agentIdentityPresented: false,
          approvalTokenPresented: false,
          ...LOCAL_TRUST,
        })
      )
    ).toBe(true);
  });
});

describe('trusted XOR identity', () => {
  const trusted = () =>
    trustedCaller({
      agentIdentityPresented: false,
      approvalTokenPresented: false,
      ...LOCAL_TRUST,
    })!;

  it('refuses a call carrying BOTH, rather than resolving in favour of trust', async () => {
    await expect(
      registry().invoke(
        'demo.destroy',
        { name: 'thing' },
        { trusted: trusted(), identity: IDENTITY }
      )
    ).rejects.toThrow(/both a trusted-caller marker and an agent identity/);
    expect(removed).toBe(false);
  });

  it('a genuine trusted caller alone runs, and an identified one alone is gated', async () => {
    await expect(
      registry().invoke('demo.destroy', { name: 'thing' }, { trusted: trusted() })
    ).resolves.toEqual({ removed: true });
    expect(removed).toBe(true);

    removed = false;
    await expect(
      registry().invoke('demo.destroy', { name: 'thing' }, { identity: IDENTITY })
    ).rejects.toMatchObject({ name: 'CapabilityGateRefusal' });
    expect(removed).toBe(false);
  });

  it('`authorizeCapability` refuses the same pair, so the invariant holds in BOTH seams', () => {
    // Unreachable from its only caller today, which cannot assemble the pair. It
    // is asserted anyway: an invariant that holds at one of two entry points is
    // not an invariant, and this is the seam a future caller will reach for.
    expect(() =>
      authorizeCapability(
        registry(),
        'demo.destroy',
        { name: 'thing' },
        {
          trusted: trusted(),
          identity: IDENTITY,
        }
      )
    ).toThrow(/both a trusted-caller marker and an agent identity/);
    expect(removed).toBe(false);
  });

  it('an anonymous, untrusted caller is gated too — dropping a credential wins nothing', async () => {
    await expect(registry().invoke('demo.destroy', { name: 'thing' })).rejects.toMatchObject({
      name: 'CapabilityGateRefusal',
    });
    expect(removed).toBe(false);
  });
});
