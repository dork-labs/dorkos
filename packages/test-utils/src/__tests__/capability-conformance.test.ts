/**
 * Tests for the Capability Registry conformance suite itself — the "test the
 * test" requirement (spec `capability-registry`, task 2.6). A conformant
 * synthetic registry must pass the pure checker with ZERO violations, and every
 * seeded drift (a missing MCP projection, an orphaned registration, a carve-out
 * on a mutating tool, a read-only mismatch, an OpenAPI collision, a docs/boot
 * route mismatch, an uncovered CLI verb, a too-short description) must produce a
 * violation in the right check group — proving the suite can genuinely fail.
 *
 * The destructive-gate checker gets the same treatment: a probe whose adapter path
 * skips the tier gate, one that returns an unstructured payload, and a missing probe
 * must each be reported, so a real adapter that stops enforcing cannot pass. So does
 * the decision-authority checker: a decide endpoint that answers 200 to the
 * requester, one that refuses but records the decision anyway, and a missing probe
 * must each be reported.
 *
 * The tool-group checker is here for a stronger reason than symmetry (DOR-1611).
 * The real DorkOS registry declares no tool group until the rooms-management verbs
 * ship, so its run of that check is legitimately empty and demonstrates nothing.
 * This file is therefore the ONLY place its ability to fail is shown: a registry
 * that runs a gated capability anyway, one that refuses with the wrong error, and
 * one whose refusal claims a person could approve it must each be reported.
 *
 * The top-level `capabilityConformance(...)` call additionally proves the Vitest
 * wrapper registers green against the conformant baseline (including the async
 * `invoke` assertions).
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityConformance,
  checkCapabilityConformance,
  checkRegistryGateConformance,
  checkToolGroupGateConformance,
  type CapabilityConformanceFixtures,
  type ConformanceCapability,
  type ConformanceRegistry,
  checkDecisionAuthorityConformance,
  type ApprovalDecisionProbe,
} from '../capability-conformance.js';

/** A long-enough model-facing description so the metadata check passes by default. */
const OK_DESCRIPTION = 'Do the demonstrated thing and return its result to the caller.';

/** A conformant read-only observe capability with an http surface. */
function observeCapability(): ConformanceCapability {
  return {
    id: 'demo.list',
    title: 'List demo',
    description: OK_DESCRIPTION,
    tier: 'observe',
    surfaces: {
      mcp: { toolName: 'demo_list', servers: ['in-session', 'external'], readOnlyCarveOut: true },
      http: { method: 'get', path: '/api/demo' },
    },
  };
}

/** A conformant mutating act capability with a CLI surface. */
function actCapability(): ConformanceCapability {
  return {
    id: 'demo.set',
    title: 'Set demo',
    description: OK_DESCRIPTION,
    tier: 'act',
    surfaces: {
      mcp: { toolName: 'demo_set', servers: ['in-session', 'external'] },
      cli: { verb: 'demo' },
    },
  };
}

/** A fresh conformant registry (two capabilities) with an always-resolving invoke. */
function conformantRegistry(
  caps: ConformanceCapability[] = [observeCapability(), actCapability()]
): ConformanceRegistry {
  return {
    capabilities: caps,
    invoke: async () => ({ ok: true }),
  };
}

/** The payload a gate-honoring adapter path returns for an unapproved destructive call. */
function approvalRequiredPayload() {
  return {
    status: 'approval_required',
    capabilityId: 'demo.destroy',
    capabilityTitle: 'Destroy demo',
    tier: 'destructive',
    approvalId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    approvalToken: 'deadbeefdeadbeefdeadbeefdeadbeef',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'no_approval',
    message: 'A person has to approve this first.',
    retry: {
      channel: 'mcp-argument',
      field: 'approvalToken',
      instructions: 'Retry with the token.',
    },
  };
}

/**
 * A stand-in for the refusal `registry.invoke` throws when the gate says no.
 * Duck-typed by `name`, exactly as the suite reads it.
 */
function gateRefusal(payload: unknown = approvalRequiredPayload()): Error {
  const err = new Error('A person has to approve this first.');
  err.name = 'CapabilityGateRefusal';
  (err as Error & { decision: unknown }).decision = { outcome: 'approval_required', payload };
  return err;
}

/** A destructive capability, for the gate checks. */
function destructiveCapability(): ConformanceCapability {
  return {
    id: 'demo.destroy',
    title: 'Destroy demo',
    description: OK_DESCRIPTION,
    tier: 'destructive',
    approvalDisplayFields: ['name'],
    surfaces: { mcp: { toolName: 'demo_destroy', servers: ['in-session', 'external'] } },
  };
}

/**
 * A registry whose `invoke` gates: it refuses the destructive capability and
 * resolves everything else. This is what the real registry does after DOR-467.
 */
function gatingRegistry(refusal: () => unknown = gateRefusal): ConformanceRegistry {
  const caps = [observeCapability(), actCapability(), destructiveCapability()];
  return {
    capabilities: caps,
    invoke: async (id) => {
      const cap = caps.find((c) => c.id === id);
      if (cap?.tier === 'destructive') throw refusal();
      return { ok: true };
    },
  };
}

/** A probe standing in for a decide endpoint that refuses the requester. */
const requesterRefusedProbe: ApprovalDecisionProbe = async () => ({
  status: 403,
  approvalDecided: false,
});

/** Fresh conformant fixtures matching {@link conformantRegistry}. */
function conformantFixtures(registry: ConformanceRegistry): CapabilityConformanceFixtures {
  return {
    requesterDecideProbe: requesterRefusedProbe,
    registeredMcpToolNames: {
      'in-session': ['demo_list', 'demo_set'],
      external: ['demo_list', 'demo_set'],
    },
    cliVerbs: ['demo'],
    // `legacy_ping` is a hand-listed non-capability read-only tool — it must be
    // ignored by the derivation equality (out of registry scope).
    readOnlyToolNames: ['demo_list', 'legacy_ping'],
    docsRegistry: { capabilities: registry.capabilities },
  };
}

/** True when some violation names the given check group. */
function hasCheck(
  violations: ReturnType<typeof checkCapabilityConformance>,
  check: string
): boolean {
  return violations.some((v) => v.check === check);
}

// The conformant baseline registers green — including the async invoke checks.
// It uses the GATING registry, because a registry with no destructive capability
// would make the destructive-gate check vacuous and the suite would be proving
// nothing about the thing it exists to prove.
const baseline = gatingRegistry();
capabilityConformance(baseline, {
  ...conformantFixtures(baseline),
  registeredMcpToolNames: {
    'in-session': ['demo_list', 'demo_set', 'demo_destroy'],
    external: ['demo_list', 'demo_set', 'demo_destroy'],
  },
  name: 'Capability conformance — conformant synthetic registry',
});

describe('checkCapabilityConformance — conformant baseline', () => {
  it('returns zero violations for a conformant registry + fixtures', () => {
    const registry = conformantRegistry();
    expect(checkCapabilityConformance(registry, conformantFixtures(registry))).toEqual([]);
  });
});

describe('checkCapabilityConformance — seeded drift must fail', () => {
  it('missing projection: a declared external tool the server never registers', () => {
    const registry = conformantRegistry();
    const fixtures = conformantFixtures(registry);
    fixtures.registeredMcpToolNames = {
      'in-session': ['demo_list', 'demo_set'],
      external: ['demo_set'],
    };
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'mcp-surface')).toBe(true);
    expect(
      violations.some((v) => v.detail.includes('demo_list') && v.detail.includes('never registers'))
    ).toBe(true);
  });

  it('orphan registration: a server tool no capability declares', () => {
    const registry = conformantRegistry();
    const fixtures = conformantFixtures(registry);
    fixtures.registeredMcpToolNames = {
      'in-session': ['demo_list', 'demo_set', 'ghost'],
      external: ['demo_list', 'demo_set'],
    };
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'mcp-surface')).toBe(true);
    expect(violations.some((v) => v.detail.includes('ghost') && v.detail.includes('orphan'))).toBe(
      true
    );
  });

  it('tier ↔ carve-out: readOnlyCarveOut on a mutating (act) tool', () => {
    const act = actCapability();
    act.surfaces.mcp!.readOnlyCarveOut = true;
    const registry = conformantRegistry([observeCapability(), act]);
    const fixtures = conformantFixtures(registry);
    // Keep the read-only set consistent so ONLY the tier check fires.
    fixtures.readOnlyToolNames = ['demo_list', 'demo_set', 'legacy_ping'];
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'tier-carve-out')).toBe(true);
  });

  it('read-only carve-out: a carve-out tool missing from READ_ONLY_MCP_TOOL_NAMES', () => {
    const registry = conformantRegistry();
    const fixtures = conformantFixtures(registry);
    fixtures.readOnlyToolNames = ['legacy_ping']; // dropped demo_list
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'read-only-carve-out')).toBe(true);
  });

  it('OpenAPI collision: two capabilities claim the same method+path', () => {
    const collider: ConformanceCapability = {
      id: 'demo.other',
      title: 'Other demo',
      description: OK_DESCRIPTION,
      tier: 'observe',
      surfaces: { http: { method: 'get', path: '/api/demo' } },
    };
    const registry = conformantRegistry([observeCapability(), actCapability(), collider]);
    const fixtures = conformantFixtures(registry);
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'openapi-collision')).toBe(true);
  });

  it('docs/boot parity: the docs registry omits a boot http route', () => {
    const registry = conformantRegistry();
    const fixtures = conformantFixtures(registry);
    // Docs projection missing the http-bearing capability.
    fixtures.docsRegistry = { capabilities: [actCapability()] };
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'docs-boot-parity')).toBe(true);
  });

  it('CLI coverage: a declared cli verb the CLI never registers', () => {
    const registry = conformantRegistry();
    const fixtures = conformantFixtures(registry);
    fixtures.cliVerbs = [];
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'cli-surface')).toBe(true);
  });

  it('approval-card fields: a destructive capability with no declared display fields', () => {
    const destroy: ConformanceCapability = {
      id: 'demo.destroy',
      title: 'Destroy demo',
      description: OK_DESCRIPTION,
      tier: 'destructive',
      surfaces: { mcp: { toolName: 'demo_destroy', servers: ['external'] } },
    };
    const registry = conformantRegistry([observeCapability(), actCapability(), destroy]);
    const fixtures = conformantFixtures(registry);
    fixtures.registeredMcpToolNames = {
      'in-session': ['demo_list', 'demo_set'],
      external: ['demo_list', 'demo_set', 'demo_destroy'],
    };
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'approval-card-fields')).toBe(true);

    // Declaring them clears it.
    destroy.approvalDisplayFields = ['target'];
    expect(hasCheck(checkCapabilityConformance(registry, fixtures), 'approval-card-fields')).toBe(
      false
    );

    // An empty declaration is its own violation: a card with no arguments at all.
    destroy.approvalDisplayFields = [];
    expect(hasCheck(checkCapabilityConformance(registry, fixtures), 'approval-card-fields')).toBe(
      true
    );

    // And a declared field whose NAME says secret: the renderer's declared branch
    // is an allowlist, so it shows this verbatim on a card agents can read.
    destroy.approvalDisplayFields = ['confirmationToken', 'target'];
    const declared = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(declared, 'approval-card-fields')).toBe(true);
    expect(declared.some((v) => v.detail.includes('confirmationToken'))).toBe(true);

    // Including under a dotted path, where the leaf is what gets read.
    destroy.approvalDisplayFields = ['auth.apiKey'];
    expect(hasCheck(checkCapabilityConformance(registry, fixtures), 'approval-card-fields')).toBe(
      true
    );
  });

  it('metadata: a description too short to be model-facing', () => {
    const obs = observeCapability();
    obs.description = 'too short';
    const registry = conformantRegistry([obs, actCapability()]);
    const fixtures = conformantFixtures(registry);
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'metadata')).toBe(true);
  });
});

describe('checkRegistryGateConformance', () => {
  it('passes when registry.invoke refuses the destructive capability', async () => {
    expect(await checkRegistryGateConformance(gatingRegistry())).toEqual([]);
  });

  it('seeded drift: invoke runs the destructive capability anyway', async () => {
    // The shape of the bug DOR-467 fixed: a path reaches the effect with no gate.
    const registry: ConformanceRegistry = {
      capabilities: [observeCapability(), destructiveCapability()],
      invoke: async () => ({ ok: true }),
    };
    const violations = await checkRegistryGateConformance(registry);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.check === 'destructive-gate')).toBe(true);
    expect(violations.some((v) => v.detail.includes('RAN a destructive capability'))).toBe(true);
  });

  it('seeded drift: invoke rejects, but not with a gate refusal', async () => {
    const violations = await checkRegistryGateConformance(
      gatingRegistry(() => new TypeError('deps missing'))
    );
    expect(violations.some((v) => v.detail.includes('not with a gate refusal'))).toBe(true);
  });

  it('seeded drift: the gate refuses with an unusable payload', async () => {
    const violations = await checkRegistryGateConformance(
      gatingRegistry(() => gateRefusal({ error: 'nope' }))
    );
    expect(violations.some((v) => v.detail.includes('approval_required'))).toBe(true);
  });

  it('seeded drift: a registry with no destructive capability is not vacuously green', async () => {
    const violations = await checkRegistryGateConformance(conformantRegistry());
    expect(violations.some((v) => v.detail.includes('vacuously green'))).toBe(true);
  });
});

/**
 * The tool-group checker gets the "test the test" treatment too, and it needs it
 * more than its siblings: the real DorkOS registry declares NO tool group until
 * the rooms-management verbs ship, so the real-registry run of this check is
 * legitimately empty and proves nothing on its own (DOR-1611). Its ability to fail
 * is demonstrated here, against a registry that does declare one.
 */
describe('checkToolGroupGateConformance', () => {
  /** The refusal the tool-group gate throws for a caller holding no grant. */
  function toolGroupRefusal(payload: unknown = toolGroupDeniedPayload()): Error {
    const err = new Error('Managing rooms is turned off for this agent.');
    err.name = 'CapabilityGateRefusal';
    (err as Error & { decision: unknown }).decision = { outcome: 'denied', payload };
    return err;
  }

  /** The structured payload a well-behaved tool-group refusal carries. */
  function toolGroupDeniedPayload() {
    return {
      status: 'denied',
      capabilityId: 'demo.manage',
      capabilityTitle: 'Manage demo',
      tier: 'act',
      reason: 'tool_group_disabled',
      approvable: false,
      message: 'Managing rooms is turned off for this agent. Ask the person who runs this install.',
    };
  }

  /** A capability behind a per-agent grant. */
  function gatedCapability(): ConformanceCapability {
    return {
      id: 'demo.manage',
      title: 'Manage demo',
      description: OK_DESCRIPTION,
      tier: 'act',
      toolGroup: 'roomsManage',
      surfaces: { mcp: { toolName: 'demo_manage', servers: ['in-session', 'external'] } },
    };
  }

  /** A registry that refuses its grant-bearing capability and resolves the rest. */
  function grantGatingRegistry(refusal: () => unknown = toolGroupRefusal): ConformanceRegistry {
    const caps = [observeCapability(), actCapability(), gatedCapability()];
    return {
      capabilities: caps,
      invoke: async (id) => {
        const cap = caps.find((c) => c.id === id);
        if (cap?.toolGroup !== undefined) throw refusal();
        return { ok: true };
      },
    };
  }

  it('passes when registry.invoke refuses the capability behind the grant', async () => {
    expect(await checkToolGroupGateConformance(grantGatingRegistry())).toEqual([]);
  });

  it('seeded drift: invoke runs the gated capability for a caller holding no grant', async () => {
    // The defect the whole boundary exists to prevent: a toggle that appears to
    // restrict and does not — the shape ADR-0070 shipped for three months.
    const registry: ConformanceRegistry = {
      capabilities: [observeCapability(), gatedCapability()],
      invoke: async () => ({ ok: true }),
    };
    const violations = await checkToolGroupGateConformance(registry);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.check === 'tool-group-gate')).toBe(true);
    expect(violations.some((v) => v.detail.includes('RAN a capability behind the'))).toBe(true);
  });

  it('seeded drift: invoke rejects, but not with a gate refusal', async () => {
    const violations = await checkToolGroupGateConformance(
      grantGatingRegistry(() => new TypeError('deps missing'))
    );
    expect(violations.some((v) => v.detail.includes('not with a gate refusal'))).toBe(true);
  });

  it('seeded drift: the gate keys on identity PRESENCE and waves named agents through', async () => {
    // The defect an anonymous-only check cannot see, and the exact shape this
    // boundary exists to prevent: refusing the caller that named nobody while
    // letting every agent that named itself straight past the grant.
    const caps = [observeCapability(), gatedCapability()];
    const registry: ConformanceRegistry = {
      capabilities: caps,
      invoke: async (id, _input, context) => {
        const cap = caps.find((c) => c.id === id);
        if (cap?.toolGroup !== undefined && !context?.identity) throw toolGroupRefusal();
        return { ok: true };
      },
    };

    const violations = await checkToolGroupGateConformance(registry);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.detail.includes('identified agent holding no grant'))).toBe(
      true
    );
    // And the anonymous row still passes, which is what made it insufficient.
    expect(violations.some((v) => v.detail.includes('unidentified caller'))).toBe(false);
  });

  it('seeded drift: the refusal claims a person could approve it', async () => {
    // `approvable: true` is not a cosmetic slip. It sends a model round the
    // approval loop forever for a switch only the operator can flip.
    const violations = await checkToolGroupGateConformance(
      grantGatingRegistry(() => toolGroupRefusal({ ...toolGroupDeniedPayload(), approvable: true }))
    );
    expect(violations.some((v) => v.detail.includes('tool_group_disabled'))).toBe(true);
  });

  it('seeded drift: the refusal is the TIER gate answering, not the group gate', async () => {
    const violations = await checkToolGroupGateConformance(
      grantGatingRegistry(() =>
        toolGroupRefusal({ ...toolGroupDeniedPayload(), reason: 'tier_ceiling' })
      )
    );
    expect(violations.some((v) => v.detail.includes('tool_group_disabled'))).toBe(true);
  });

  it('is empty — not violated — for a registry that declares no group at all', async () => {
    // Deliberately unlike the destructive check, which flags an empty subject set
    // as vacuous. This mechanism ships one release before its first subject, and
    // reddening the real registry for that would be a guard crying wolf.
    expect(await checkToolGroupGateConformance(conformantRegistry())).toEqual([]);
  });
});

describe('checkDecisionAuthorityConformance', () => {
  it('passes when the requester is refused and the approval stays undecided', async () => {
    expect(await checkDecisionAuthorityConformance(requesterRefusedProbe)).toEqual([]);
  });

  it('seeded bypass: the decide endpoint answers 200 to the caller that asked', async () => {
    const violations = await checkDecisionAuthorityConformance(async () => ({
      status: 200,
      approvalDecided: true,
    }));
    expect(violations.length).toBe(2);
    expect(violations.every((v) => v.check === 'decision-authority')).toBe(true);
    expect(violations.some((v) => v.detail.includes('approve its own destructive call'))).toBe(
      true
    );
    expect(violations.some((v) => v.detail.includes('human half of the gate is optional'))).toBe(
      true
    );
  });

  it('seeded bypass: refused with a 403 but the decision was recorded anyway', async () => {
    const violations = await checkDecisionAuthorityConformance(async () => ({
      status: 403,
      approvalDecided: true,
    }));
    expect(violations.some((v) => v.detail.includes('human half of the gate is optional'))).toBe(
      true
    );
  });

  it('seeded drift: no probe at all', async () => {
    const violations = await checkDecisionAuthorityConformance(undefined);
    expect(violations.some((v) => v.detail.includes('no requesterDecideProbe supplied'))).toBe(
      true
    );
  });

  it('seeded drift: a probe that throws', async () => {
    const violations = await checkDecisionAuthorityConformance(async () => {
      throw new Error('router blew up');
    });
    expect(violations.some((v) => v.detail.includes('router blew up'))).toBe(true);
  });
});
