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
 * The top-level `capabilityConformance(...)` call additionally proves the Vitest
 * wrapper registers green against the conformant baseline (including the async
 * `invoke` assertions).
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityConformance,
  checkCapabilityConformance,
  checkDestructiveGateConformance,
  GATED_ADAPTER_PATHS,
  type CapabilityConformanceFixtures,
  type ConformanceCapability,
  type ConformanceRegistry,
  checkDecisionAuthorityConformance,
  type ApprovalDecisionProbe,
  type DestructiveGateProbe,
  type GatedAdapterPath,
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

/** A probe standing in for an adapter path that honors the gate. */
const gateHonoringProbe: DestructiveGateProbe = async () => ({
  sideEffectHappened: false,
  payload: approvalRequiredPayload(),
});

/** Probes for every adapter path, all honoring the gate. */
function conformantProbes(): Partial<Record<GatedAdapterPath, DestructiveGateProbe>> {
  return Object.fromEntries(GATED_ADAPTER_PATHS.map((path) => [path, gateHonoringProbe]));
}

/** A probe standing in for a decide endpoint that refuses the requester. */
const requesterRefusedProbe: ApprovalDecisionProbe = async () => ({
  status: 403,
  approvalDecided: false,
});

/** Fresh conformant fixtures matching {@link conformantRegistry}. */
function conformantFixtures(registry: ConformanceRegistry): CapabilityConformanceFixtures {
  return {
    destructiveGateProbes: conformantProbes(),
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
const baseline = conformantRegistry();
capabilityConformance(baseline, {
  ...conformantFixtures(baseline),
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

describe('checkDestructiveGateConformance', () => {
  it('passes when every adapter path returns approval_required and runs nothing', async () => {
    expect(await checkDestructiveGateConformance(conformantProbes())).toEqual([]);
  });

  it('seeded drift: an adapter path that invokes the capability anyway', async () => {
    const probes = conformantProbes();
    // A path that "forgot" the gate: the handler ran and the caller got its output.
    probes['external-mcp'] = async () => ({
      sideEffectHappened: true,
      payload: { ok: true },
    });
    const violations = await checkDestructiveGateConformance(probes);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.check === 'destructive-gate')).toBe(true);
    expect(violations.some((v) => v.detail.includes('external-mcp'))).toBe(true);
    expect(violations.some((v) => v.detail.includes('bypasses the tier gate'))).toBe(true);
  });

  it('seeded drift: a path that blocks the call but returns an unusable payload', async () => {
    const probes = conformantProbes();
    probes['invoke-route'] = async () => ({
      sideEffectHappened: false,
      payload: { error: 'nope' },
    });
    const violations = await checkDestructiveGateConformance(probes);
    expect(violations.some((v) => v.detail.includes('approval_required payload'))).toBe(true);
  });

  it('seeded drift: an adapter path with no probe at all', async () => {
    const probes = conformantProbes();
    delete probes['in-session-mcp'];
    const violations = await checkDestructiveGateConformance(probes);
    expect(violations.some((v) => v.detail.includes('no probe supplied'))).toBe(true);
  });

  it('seeded drift: a probe that throws', async () => {
    const probes = conformantProbes();
    probes['invoke-route'] = async () => {
      throw new Error('adapter blew up');
    };
    const violations = await checkDestructiveGateConformance(probes);
    expect(violations.some((v) => v.detail.includes('adapter blew up'))).toBe(true);
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
