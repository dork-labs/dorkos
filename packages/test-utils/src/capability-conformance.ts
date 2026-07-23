/**
 * Shared Capability Registry conformance suite — the drift gate every capability
 * clears so that adding one `defineCapability` really does light up every
 * agent-facing surface (both MCP servers, the CLI verbs, OpenAPI, the
 * self-description catalog) with nothing orphaned. The capability analogue of
 * `runtimeConformance` / `connectorConformance` (spec `capability-registry`,
 * task 2.6).
 *
 * `capabilityConformance(registry, fixtures)` registers a `describe` block that
 * asserts, for the COMPOSED registry:
 *
 * - every entry has a `${domain}.${verb}` id, a non-empty title, a non-empty
 *   model-facing (ACI-style) description, and a valid permission tier;
 * - `invoke` resolves against the domain-supplied deps fixtures (the registry
 *   the caller passes is composed with fakes; the caller supplies per-capability
 *   sample inputs);
 * - both MCP servers expose EXACTLY the declared tool surfaces — the registry's
 *   per-server declared tool names equal the names the real adapters register
 *   (no orphan in either direction: no declared-but-unregistered, no
 *   registered-but-undeclared);
 * - the CLI verb map covers every declared `cli` surface;
 * - `READ_ONLY_MCP_TOOL_NAMES`, restricted to capability tools, equals the
 *   registry's own `readOnlyCarveOut` derivation (the phase-1 hand-list
 *   near-miss can never recur);
 * - every `readOnlyCarveOut` tool is `observe`-tier (tier ↔ carve-out
 *   consistency);
 * - no two capabilities collide on an `http` method+path (the reverse-direction
 *   OpenAPI collision guard) and the projected route set is order-independent;
 * - the docs-projection registry exposes the SAME `http` surface set as the boot
 *   registry (a route can't appear in `/api/docs` that the running server never
 *   serves, or vice versa).
 *
 * ## Division of labor and the "test the test" seam
 *
 * The synchronous, structural assertions live in {@link checkCapabilityConformance},
 * a PURE function returning every violation. That makes the suite itself
 * falsifiable: a fixture registry with a seeded drift (a missing projection, a
 * carve-out on a mutating tool) must produce violations — proven directly in
 * this package's own test. {@link capabilityConformance} wraps that checker in
 * Vitest `it`s (one per check group, for readable failures) and adds the async
 * per-capability `invoke` assertions.
 *
 * This module imports only `@dorkos/shared/capabilities` (the serializable
 * catalog types) and Vitest — never `@dorkos/server`. The registry and its
 * `invoke` are consumed through the minimal structural {@link ConformanceRegistry}
 * interface the server's real `CapabilityRegistry` satisfies, so test-utils
 * stays free of a server dependency.
 *
 * @module test-utils/capability-conformance
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_TIERS,
  type CapabilityTier,
  type CapabilitySurfaces,
  type McpServerId,
} from '@dorkos/shared/capabilities';

/** The MCP servers a conformance run inspects. */
const MCP_SERVERS: readonly McpServerId[] = ['in-session', 'external'];

/**
 * A capability as the conformance suite reads it — the structural subset of the
 * server's `CapabilityDefinition` the checks touch (its Zod schemas and `invoke`
 * handler are exercised through the registry, not read here). The real
 * definition satisfies this shape.
 */
export interface ConformanceCapability {
  /** Stable `${domain}.${verb}` identifier. */
  id: string;
  /** Human-facing title. */
  title: string;
  /** Model-facing (ACI-style) description. */
  description: string;
  /** Permission tier. */
  tier: CapabilityTier;
  /** The surfaces this capability projects onto. */
  surfaces: CapabilitySurfaces;
}

/**
 * The registry surface the conformance suite drives. The server's composed
 * `CapabilityRegistry` satisfies this structurally, so test-utils needs no
 * `@dorkos/server` dependency.
 */
export interface ConformanceRegistry {
  /** Every registered capability, in registration order. */
  readonly capabilities: readonly ConformanceCapability[];
  /**
   * Validate `input` against the capability's schema and invoke its handler with
   * the registry's captured (fake) deps.
   *
   * @param id - The capability id to invoke.
   * @param input - Raw input; parsed against the capability's input schema.
   * @returns The capability's plain output.
   */
  invoke(id: string, input: unknown): Promise<unknown>;
}

/**
 * The out-of-registry facts the conformance suite cross-checks the registry
 * against. Each comes from an INDEPENDENT source of truth (the real MCP
 * adapters, the CLI, the security module, the docs composer), so a mismatch
 * catches genuine drift rather than restating the registry.
 */
export interface CapabilityConformanceFixtures {
  /** Label for the registered describe block. Defaults to `'Capability registry conformance'`. */
  name?: string;
  /**
   * Per-capability sample input for the `invoke` assertion (keyed by capability
   * id). A capability with no entry is invoked with `{}` — correct for the
   * empty-input observe capabilities; supply inputs for any capability whose
   * schema has required fields.
   */
  sampleInputs?: Record<string, unknown>;
  /**
   * The tool names each MCP server ACTUALLY registers for the capability
   * surface, obtained by running the real adapters (`capabilityMcpTools` for
   * in-session; `registerCapabilitiesAsMcpTools` onto a real `McpServer` for
   * external). Compared for exact equality against the registry's declared
   * per-server surface.
   */
  registeredMcpToolNames: Record<McpServerId, Iterable<string>>;
  /**
   * The top-level CLI verbs the `dorkos` CLI recognizes. Every capability that
   * declares a `cli` surface must have its verb here.
   */
  cliVerbs: Iterable<string>;
  /**
   * The live `READ_ONLY_MCP_TOOL_NAMES` set (legacy hand-listed names unioned
   * with the registry derivation). The suite asserts that, restricted to the
   * registry's capability tool names, it equals the registry's own
   * `readOnlyCarveOut` derivation.
   */
  readOnlyToolNames: Iterable<string>;
  /**
   * The docs-projection registry (`composeCapabilityRegistryForDocs`), whose
   * `http` surface set must match the boot registry's — so the OpenAPI document
   * can never advertise a route the running server does not serve (or omit one it
   * does).
   */
  docsRegistry: Pick<ConformanceRegistry, 'capabilities'>;
}

/** One conformance violation: the check that failed and a human-readable detail. */
export interface ConformanceViolation {
  /** The check group this violation belongs to (e.g. `'mcp-surface'`). */
  check: string;
  /** What drifted, in enough detail to fix it. */
  detail: string;
}

/**
 * Whether a thrown value is the server's `CapabilityToolError` — the structured
 * domain-error a handler raises through the plain-data seam. Duck-typed by name
 * so this suite stays free of a `@dorkos/server` import.
 *
 * @param err - The thrown value.
 * @returns True when it is a `CapabilityToolError`.
 */
function isCapabilityToolError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CapabilityToolError';
}

/** The `${domain}.${verb}` id shape every capability id must match. */
const ID_PATTERN = /^[a-z0-9]+\.[a-z0-9_]+$/;

/** Minimum model-facing description length — an ACI description is more than a label. */
const MIN_DESCRIPTION_LENGTH = 20;

/** Every `METHOD /path` key from a capability set's `http` surfaces (may repeat). */
function httpKeys(capabilities: readonly ConformanceCapability[]): string[] {
  return capabilities
    .filter((cap) => cap.surfaces.http)
    .map((cap) => `${cap.surfaces.http!.method.toUpperCase()} ${cap.surfaces.http!.path}`);
}

/** The capability tool names declared on a given MCP server, in registration order. */
function declaredMcpToolNames(
  capabilities: readonly ConformanceCapability[],
  server: McpServerId
): string[] {
  return capabilities
    .filter((cap) => cap.surfaces.mcp?.servers.includes(server))
    .map((cap) => cap.surfaces.mcp!.toolName);
}

/** The registry's own read-only carve-out derivation: external tools flagged `readOnlyCarveOut`. */
function carveOutToolNames(capabilities: readonly ConformanceCapability[]): Set<string> {
  const names = new Set<string>();
  for (const cap of capabilities) {
    const mcp = cap.surfaces.mcp;
    if (mcp?.readOnlyCarveOut && mcp.servers.includes('external')) names.add(mcp.toolName);
  }
  return names;
}

/** The sorted symmetric difference of two string sets, as `[only-in-a, only-in-b]`. */
function symmetricDiff(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[] } {
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  return { onlyA, onlyB };
}

/**
 * Run every SYNCHRONOUS structural conformance check and return all violations
 * (an empty array means conformant). Pure and dependency-light so it can be
 * called directly to prove the suite fails on a seeded drift ("test the test").
 *
 * @param registry - The composed registry (boot registry, with fakes).
 * @param fixtures - The out-of-registry facts to cross-check against.
 * @returns Every violation found, across all checks.
 */
export function checkCapabilityConformance(
  registry: ConformanceRegistry,
  fixtures: CapabilityConformanceFixtures
): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const caps = registry.capabilities;
  const add = (check: string, detail: string): void => void violations.push({ check, detail });

  // ── Per-entry metadata ──────────────────────────────────────────────────
  const toolNameOwners = new Map<string, string>();
  for (const cap of caps) {
    if (!ID_PATTERN.test(cap.id)) {
      add('metadata', `id "${cap.id}" is not a lowercase \`domain.verb\` identifier`);
    }
    if (cap.title.trim().length === 0) {
      add('metadata', `capability "${cap.id}" has an empty title`);
    }
    if (cap.description.trim().length < MIN_DESCRIPTION_LENGTH) {
      add(
        'metadata',
        `capability "${cap.id}" description is too short to be model-facing (< ${MIN_DESCRIPTION_LENGTH} chars)`
      );
    }
    if (cap.description.trim() === cap.title.trim()) {
      add('metadata', `capability "${cap.id}" description merely repeats its title`);
    }
    if (!(CAPABILITY_TIERS as readonly string[]).includes(cap.tier)) {
      add('metadata', `capability "${cap.id}" has an invalid tier "${cap.tier}"`);
    }
    // A tool name may be claimed by only one capability (the registry enforces
    // this at compose time; re-assert so a drifted fixture registry is caught).
    const toolName = cap.surfaces.mcp?.toolName;
    if (toolName) {
      const owner = toolNameOwners.get(toolName);
      if (owner)
        add(
          'mcp-surface',
          `MCP tool name "${toolName}" claimed by both "${owner}" and "${cap.id}"`
        );
      else toolNameOwners.set(toolName, cap.id);
    }
  }

  // ── MCP surface equality (no orphans in either direction) ───────────────
  for (const server of MCP_SERVERS) {
    const declared = new Set(declaredMcpToolNames(caps, server));
    const actual = new Set(fixtures.registeredMcpToolNames[server]);
    const { onlyA: declaredNotRegistered, onlyB: registeredNotDeclared } = symmetricDiff(
      declared,
      actual
    );
    for (const name of declaredNotRegistered) {
      add(
        'mcp-surface',
        `${server}: capability declares tool "${name}" but the server never registers it`
      );
    }
    for (const name of registeredNotDeclared) {
      add(
        'mcp-surface',
        `${server}: server registers tool "${name}" with no capability declaring it (orphan)`
      );
    }
  }

  // ── CLI verb coverage ────────────────────────────────────────────────────
  const cliVerbs = new Set(fixtures.cliVerbs);
  for (const cap of caps) {
    const cli = cap.surfaces.cli;
    if (cli && !cliVerbs.has(cli.verb)) {
      add(
        'cli-surface',
        `capability "${cap.id}" declares CLI verb "${cli.verb}" but the CLI does not register it`
      );
    }
  }

  // ── Read-only carve-out equals the registry derivation ──────────────────
  const derivedCarveOut = carveOutToolNames(caps);
  const externalToolNames = new Set(declaredMcpToolNames(caps, 'external'));
  const readOnly = new Set(fixtures.readOnlyToolNames);
  // Restrict the live set to capability tools: legacy hand-listed names are out
  // of registry scope and must not count against the derivation.
  const readOnlyCapTools = new Set([...readOnly].filter((n) => externalToolNames.has(n)));
  const { onlyA: readOnlyNotDerived, onlyB: derivedNotReadOnly } = symmetricDiff(
    readOnlyCapTools,
    derivedCarveOut
  );
  for (const name of readOnlyNotDerived) {
    add(
      'read-only-carve-out',
      `tool "${name}" is in READ_ONLY_MCP_TOOL_NAMES but no capability flags it readOnlyCarveOut`
    );
  }
  for (const name of derivedNotReadOnly) {
    add(
      'read-only-carve-out',
      `capability tool "${name}" flags readOnlyCarveOut but is missing from READ_ONLY_MCP_TOOL_NAMES`
    );
  }

  // ── Scope add (1): tier ↔ carve-out consistency ─────────────────────────
  for (const cap of caps) {
    if (cap.surfaces.mcp?.readOnlyCarveOut && cap.tier !== 'observe') {
      add(
        'tier-carve-out',
        `capability "${cap.id}" flags readOnlyCarveOut but is tier "${cap.tier}" (only observe-tier tools may be read-only)`
      );
    }
  }

  // ── Scope add (2): OpenAPI reverse collision + deterministic ordering ────
  const bootKeys = httpKeys(caps);
  const seen = new Set<string>();
  for (const key of bootKeys) {
    if (seen.has(key)) {
      add(
        'openapi-collision',
        `two capabilities project the same OpenAPI route "${key}" (a reverse-direction collision)`
      );
    }
    seen.add(key);
  }

  // ── Scope add (3): docs registry http surface set ≡ boot registry set ───
  const bootHttp = new Set(bootKeys);
  const docsHttp = new Set(httpKeys(fixtures.docsRegistry.capabilities));
  const { onlyA: bootOnly, onlyB: docsOnly } = symmetricDiff(bootHttp, docsHttp);
  for (const key of bootOnly) {
    add(
      'docs-boot-parity',
      `route "${key}" is served by the boot registry but absent from the docs projection`
    );
  }
  for (const key of docsOnly) {
    add(
      'docs-boot-parity',
      `route "${key}" is in the docs projection but not served by the boot registry`
    );
  }

  return violations;
}

/** Group violations by their `check` for a readable per-check assertion. */
function groupByCheck(violations: ConformanceViolation[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const v of violations) {
    const list = grouped.get(v.check) ?? [];
    list.push(v.detail);
    grouped.set(v.check, list);
  }
  return grouped;
}

/** The check groups asserted, so each gets its own `it` even when it has zero violations. */
const CHECK_GROUPS = [
  'metadata',
  'mcp-surface',
  'cli-surface',
  'read-only-carve-out',
  'tier-carve-out',
  'openapi-collision',
  'docs-boot-parity',
] as const;

/**
 * Register the Capability Registry conformance suite for a composed registry.
 *
 * Call at the top level of a Vitest test file. The structural checks run once
 * (via {@link checkCapabilityConformance}) and are asserted per check group; the
 * `invoke` assertions run one `it` per capability so a single failing handler is
 * named precisely.
 *
 * @param registry - The composed registry under test (compose with fake deps).
 * @param fixtures - The out-of-registry facts to cross-check; see
 *   {@link CapabilityConformanceFixtures}.
 */
export function capabilityConformance(
  registry: ConformanceRegistry,
  fixtures: CapabilityConformanceFixtures
): void {
  const name = fixtures.name ?? 'Capability registry conformance';
  const violations = checkCapabilityConformance(registry, fixtures);
  const grouped = groupByCheck(violations);

  describe(name, () => {
    describe('structural surfaces', () => {
      for (const group of CHECK_GROUPS) {
        it(`${group}: no drift`, () => {
          const details = grouped.get(group) ?? [];
          expect(details, details.join('\n')).toEqual([]);
        });
      }
    });

    describe('invoke against fixtures', () => {
      for (const cap of registry.capabilities) {
        it(`${cap.id} invokes without a wiring error`, async () => {
          const input = fixtures.sampleInputs?.[cap.id] ?? {};
          let error: unknown;
          await registry.invoke(cap.id, input).catch((err: unknown) => {
            error = err;
          });
          // "Works" means the capability is WIRED and reachable through the
          // registry — it either resolves, or raises its own STRUCTURED
          // `CapabilityToolError` (the handler ran and returned a domain error
          // result). Only an UNSTRUCTURED throw (a `TypeError`/`ReferenceError`
          // from missing dep plumbing, or a `ZodError` from a bad sample input)
          // is a real wiring failure. `CapabilityToolError` lives in the server
          // package, so it is duck-typed by name to keep this suite server-free.
          const ok = error === undefined || isCapabilityToolError(error);
          expect(ok, error instanceof Error ? error.message : String(error)).toBe(true);
        });
      }
    });
  });
}
