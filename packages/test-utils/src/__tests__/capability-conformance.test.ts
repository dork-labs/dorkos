/**
 * Tests for the Capability Registry conformance suite itself — the "test the
 * test" requirement (spec `capability-registry`, task 2.6). A conformant
 * synthetic registry must pass the pure checker with ZERO violations, and every
 * seeded drift (a missing MCP projection, an orphaned registration, a carve-out
 * on a mutating tool, a read-only mismatch, an OpenAPI collision, a docs/boot
 * route mismatch, an uncovered CLI verb, a too-short description) must produce a
 * violation in the right check group — proving the suite can genuinely fail.
 *
 * The top-level `capabilityConformance(...)` call additionally proves the Vitest
 * wrapper registers green against the conformant baseline (including the async
 * `invoke` assertions).
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityConformance,
  checkCapabilityConformance,
  type CapabilityConformanceFixtures,
  type ConformanceCapability,
  type ConformanceRegistry,
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

/** Fresh conformant fixtures matching {@link conformantRegistry}. */
function conformantFixtures(registry: ConformanceRegistry): CapabilityConformanceFixtures {
  return {
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

  it('metadata: a description too short to be model-facing', () => {
    const obs = observeCapability();
    obs.description = 'too short';
    const registry = conformantRegistry([obs, actCapability()]);
    const fixtures = conformantFixtures(registry);
    const violations = checkCapabilityConformance(registry, fixtures);
    expect(hasCheck(violations, 'metadata')).toBe(true);
  });
});
