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
 * - every `destructive` capability declares `approvalDisplayFields`, and none of the
 *   names it declares is secret-shaped. The declared branch of the renderer is an
 *   allowlist, so it does NOT re-check names — declaring `confirmationToken` would
 *   render it in full. The summary is broadcast on the global event stream and
 *   readable by agents through `GET /api/approvals/pending`, so this check is what
 *   makes that mistake impossible rather than merely discouraged;
 * - no two capabilities collide on an `http` method+path (the reverse-direction
 *   OpenAPI collision guard) and the projected route set is order-independent;
 * - the docs-projection registry exposes the SAME `http` surface set as the boot
 *   registry (a route can't appear in `/api/docs` that the running server never
 *   serves, or vice versa);
 * - EVERY `destructive` capability the registry carries is REFUSED by
 *   `registry.invoke` itself when no approval and no trusted marker is presented
 *   (spec `agent-trust` §3.2, DOR-467). Because the gate lives inside `invoke`,
 *   this one registry-derived check covers every adapter at once — including
 *   adapters that do not exist yet — where the previous hand-listed probe set
 *   could only ever fail for a path somebody had already thought to list.
 * - a caller PRESENTING ITS RETRY TOKEN cannot decide the approval that token
 *   belongs to: {@link ApprovalDecisionProbe} drives the real invoke route to obtain
 *   a pending approval, then the real decide endpoint carrying that token, which
 *   must be refused with the approval left undecided. Note the scope precisely —
 *   this proves the token-holder refusal, not a general "whoever can invoke cannot
 *   grant", which is false by design when local login is off (see
 *   {@link ApprovalDecisionProbe}).
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
  isSecretInputKey,
  type CapabilityTier,
  type CapabilitySurfaces,
  type McpServerId,
} from '@dorkos/shared/capabilities';

/** The MCP servers a conformance run inspects. */
const MCP_SERVERS: readonly McpServerId[] = ['in-session', 'external'];

/**
 * Whether a thrown value is the registry's gate refusal — the error
 * `registry.invoke` raises when the tier gate did not allow a call. Duck-typed by
 * name so this suite stays free of a `@dorkos/server` import.
 *
 * @param err - The thrown value.
 * @returns True when it is a `CapabilityGateRefusal`.
 */
function isGateRefusal(err: unknown): err is { decision: { payload: unknown } } {
  return err instanceof Error && err.name === 'CapabilityGateRefusal';
}

/** What the real decide endpoint did when the REQUESTER tried to answer itself. */
export interface ApprovalDecisionProbeResult {
  /** HTTP status the decide endpoint answered with. Must be a refusal (>= 400). */
  status: number;
  /**
   * Whether the approval actually ended up decided — read back from the approval
   * service, not inferred from the status. Must be false: a 403 that recorded the
   * grant anyway would be worse than an honest 200.
   */
  approvalDecided: boolean;
}

/**
 * Drive `POST /api/approvals/:id/grant` as the caller that just asked, carrying the
 * retry token the `202` handed it.
 *
 * The invariant this encodes, stated no wider than the probe proves: **a caller
 * presenting an approval token cannot decide that approval.** The probe obtains a
 * real pending approval through the real invoke route, then calls the real decide
 * route carrying that token and nothing a person in the cockpit would carry.
 *
 * Two things it deliberately does NOT encode:
 *
 * - "A caller that can reach `POST /api/capabilities/:id/invoke` cannot reach
 *   `POST /api/approvals/:id/grant`." That is false by design with local login
 *   off, where a credential-free request from an adversary with shell access is
 *   indistinguishable from the cockpit's
 *   (`services/core/approvals/decision-authority.ts`). Encoding an invariant that
 *   could only pass by breaking the default product would be worse than the
 *   narrower true one.
 * - The identified-agent refusal. Removing the token check alone fails this probe;
 *   removing the agent-identity check alone does not, because this caller is
 *   anonymous. That half is pinned at the route level instead
 *   (`routes/__tests__/capabilities-invoke.test.ts`, "breaks it for an identified
 *   agent too, even without the token header").
 *
 * @returns The status and whether the approval was left undecided.
 */
export type ApprovalDecisionProbe = () => Promise<ApprovalDecisionProbeResult>;

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
  /** Input fields the approval card may show. Required on `destructive` entries. */
  approvalDisplayFields?: readonly string[];
  /**
   * The per-agent grant this capability requires, when it declares one.
   *
   * Typed as a bare string rather than the server's `CapabilityToolGroup` union,
   * so this suite stays free of a `@dorkos/server` import and does not have to be
   * edited every time a group is added. The check derives its subjects from
   * whichever capabilities carry it.
   */
  toolGroup?: string;
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
  /**
   * Probe proving the requester cannot decide its own approval; see
   * {@link ApprovalDecisionProbe}. Required — an absent probe is itself a
   * violation, because "nobody checked" is how the bypass shipped the first time.
   */
  requesterDecideProbe: ApprovalDecisionProbe;
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

  // ── Scope add (1b): a destructive card's fields are chosen, not inherited ─
  for (const cap of caps) {
    if (cap.tier !== 'destructive') continue;
    for (const field of cap.approvalDisplayFields ?? []) {
      // The renderer's declared branch is an allowlist and deliberately does not
      // re-filter by name, so a secret-shaped field named HERE reaches the card in
      // full. Catch it at declaration, where it is one word to fix.
      const leaf = field.split('.').pop() ?? field;
      if (isSecretInputKey(leaf)) {
        add(
          'approval-card-fields',
          `capability "${cap.id}" declares "${field}" in approvalDisplayFields, and that name says ` +
            `its value is credential material — a declared field is shown verbatim, on a card every ` +
            `cockpit sees and any agent can read`
        );
      }
    }
    if (!cap.approvalDisplayFields) {
      add(
        'approval-card-fields',
        `capability "${cap.id}" is tier "destructive" but declares no approvalDisplayFields, so its ` +
          `approval card shows every input field it happens to have — and that card is broadcast to ` +
          `every cockpit and readable by agents`
      );
    } else if (cap.approvalDisplayFields.length === 0) {
      add(
        'approval-card-fields',
        `capability "${cap.id}" declares an EMPTY approvalDisplayFields, so a person would be asked ` +
          `to approve an irreversible action with none of its arguments shown`
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

/**
 * Whether a payload is the tier gate's `approval_required` result: the status
 * discriminator, an approval id a person can decide, and retry instructions a
 * model can follow. Duck-typed so this suite stays free of a `@dorkos/server`
 * import.
 */
function isApprovalRequiredPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    p.status === 'approval_required' &&
    typeof p.approvalId === 'string' &&
    p.approvalId.length > 0 &&
    typeof p.approvalToken === 'string' &&
    p.approvalToken.length > 0 &&
    typeof p.message === 'string' &&
    typeof p.retry === 'object' &&
    p.retry !== null &&
    typeof (p.retry as Record<string, unknown>).instructions === 'string'
  );
}

/**
 * Prove that the tier gate is REACHED, for every `destructive` capability the
 * registry carries, by the only path any surface can use to run one.
 *
 * This replaced a hand-maintained list of adapter paths, each needing its own
 * probe (DOR-467). That list could only fail for a path already ON it, so the
 * surface that actually shipped ungated — the legacy marketplace routes — was
 * invisible to it: it was never added, so nothing was ever missing. The check is
 * now derived from the registry instead. Every capability the registry knows
 * about is driven through the registry's own `invoke`, with no trusted marker and
 * no approval, and a `destructive` one must come back refused.
 *
 * That covers every adapter at once, present and future, because the gate lives
 * INSIDE `invoke`: a new surface that reaches a capability inherits it, and a new
 * surface that does not reach a capability through `invoke` is caught by the
 * call-site scan in the server package instead (`__tests__/gate-bypass-scan.test.ts`),
 * which is the half a registry-shaped check cannot see.
 *
 * "No side effect" needs no separate probe here: a refusal is a REJECTION, so the
 * handler never ran. A gate that returned the right payload after doing the damage
 * would have to resolve, and would fail this check.
 *
 * @param registry - The composed registry under test.
 * @param sampleInputs - Per-capability sample input, keyed by capability id.
 * @returns Every violation found.
 */
export async function checkRegistryGateConformance(
  registry: ConformanceRegistry,
  sampleInputs: Record<string, unknown> = {}
): Promise<ConformanceViolation[]> {
  const violations: ConformanceViolation[] = [];
  const add = (detail: string): void => void violations.push({ check: 'destructive-gate', detail });

  const destructive = registry.capabilities.filter((cap) => cap.tier === 'destructive');
  if (destructive.length === 0) {
    add(
      'the registry declares no `destructive` capability, so this check proves nothing — it is ' +
        'vacuously green and would stay green with the gate removed'
    );
  }

  for (const cap of destructive) {
    let refused = false;
    let thrown: unknown;
    try {
      await registry.invoke(cap.id, sampleInputs[cap.id] ?? {});
    } catch (err) {
      thrown = err;
      refused = true;
    }

    if (!refused) {
      add(
        `${cap.id}: registry.invoke RAN a destructive capability for an untrusted, unapproved ` +
          `caller — the tier gate is not inside invoke, so every surface that calls it is ungated`
      );
      continue;
    }
    if (!isGateRefusal(thrown)) {
      add(
        `${cap.id}: registry.invoke rejected, but not with a gate refusal — got ` +
          `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`
      );
      continue;
    }
    if (!isApprovalRequiredPayload(thrown.decision.payload)) {
      add(
        `${cap.id}: the gate refused but its payload is not a structured approval_required ` +
          `(status, approvalId, approvalToken, message, retry.instructions), got ` +
          `${JSON.stringify(thrown.decision.payload)}`
      );
    }
  }

  return violations;
}

/**
 * Whether a refusal payload is the tool-group gate's, in the shape a caller has
 * to be able to act on: refused, un-approvable, and carrying a sentence.
 *
 * `approvable: false` is the load-bearing field. A refusal that claimed a person
 * could unlock it would send a model round the approval loop forever for a switch
 * only the operator can flip, in a place the model cannot reach.
 *
 * @param payload - The refusal payload from the gate.
 * @returns True when it is a well-formed `tool_group_disabled` denial.
 */
function isToolGroupDenial(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    p.status === 'denied' &&
    p.reason === 'tool_group_disabled' &&
    p.approvable === false &&
    typeof p.message === 'string' &&
    p.message.length > 0
  );
}

/**
 * Prove that every capability declaring a per-agent tool group is REFUSED when the
 * caller does not hold it, through the only path any surface can use to run one
 * (DOR-1611).
 *
 * Derived from the registry, exactly like {@link checkRegistryGateConformance} and
 * for the same reason: a hand-listed set of tool names can only fail for a name
 * somebody already added, and this repo has twice shipped a hole that was simply
 * never on the list. Every capability carrying a `toolGroup` is driven through
 * `registry.invoke` with no trusted marker and no identity — the anonymous caller,
 * which by construction holds no grant — and must come back refused. A capability
 * that gains a group tomorrow is covered the day it declares one, and one that
 * silently LOSES its group is covered by the structural surface checks.
 *
 * "No side effect" needs no separate probe: a refusal is a REJECTION, so the
 * handler never ran. A gate that returned the right payload after doing the damage
 * would have to resolve, and would fail this check.
 *
 * **An empty subject set is not flagged here**, unlike the destructive check.
 * The two are in different places in their lives: the registry has always carried
 * a `destructive` capability, so an empty set there means the check went blind,
 * whereas this mechanism ships one release BEFORE the first capability declares a
 * group and an empty set is the honest state of the world. That is the whole
 * reason `checkToolGroupGateConformance` is exported: this suite's own tests seed
 * a registry that DOES declare one and prove the check goes red, so its ability to
 * fail is demonstrated rather than assumed.
 *
 * @param registry - The composed registry under test.
 * @param sampleInputs - Per-capability sample input, keyed by capability id.
 * @returns Every violation found.
 */
export async function checkToolGroupGateConformance(
  registry: ConformanceRegistry,
  sampleInputs: Record<string, unknown> = {}
): Promise<ConformanceViolation[]> {
  const violations: ConformanceViolation[] = [];
  const add = (detail: string): void => void violations.push({ check: 'tool-group-gate', detail });

  const gated = registry.capabilities.filter((cap) => cap.toolGroup !== undefined);

  for (const cap of gated) {
    let thrown: unknown;
    let refused = false;
    try {
      await registry.invoke(cap.id, sampleInputs[cap.id] ?? {});
    } catch (err) {
      thrown = err;
      refused = true;
    }

    if (!refused) {
      add(
        `${cap.id}: registry.invoke RAN a capability behind the "${cap.toolGroup}" grant for a ` +
          `caller holding no grant — the tool-group gate is not inside invoke, so every surface ` +
          `that calls it is ungated`
      );
      continue;
    }
    if (!isGateRefusal(thrown)) {
      add(
        `${cap.id}: registry.invoke rejected, but not with a gate refusal — got ` +
          `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`
      );
      continue;
    }
    if (!isToolGroupDenial(thrown.decision.payload)) {
      add(
        `${cap.id}: the gate refused but its payload is not a structured tool_group_disabled ` +
          `denial (status: 'denied', reason: 'tool_group_disabled', approvable: false, message), ` +
          `got ${JSON.stringify(thrown.decision.payload)}`
      );
    }
  }

  return violations;
}

/**
 * Run the requester-cannot-decide probe and return all violations (empty means the
 * decide endpoint refused the requester and left the approval alone). Separated and
 * exported like the gate checker so a seeded bypass can be shown to FAIL it.
 *
 * @param probe - The probe, or `undefined` when the caller supplied none.
 * @returns Every violation found.
 */
export async function checkDecisionAuthorityConformance(
  probe: ApprovalDecisionProbe | undefined
): Promise<ConformanceViolation[]> {
  const violations: ConformanceViolation[] = [];
  const add = (detail: string): void =>
    void violations.push({ check: 'decision-authority', detail });

  if (!probe) {
    return [
      {
        check: 'decision-authority',
        detail:
          'no requesterDecideProbe supplied, so nothing proves the caller that asked for an ' +
          'approval cannot also grant it',
      },
    ];
  }

  let result: ApprovalDecisionProbeResult;
  try {
    result = await probe();
  } catch (err) {
    add(`probe threw instead of returning a decide outcome — ${String(err)}`);
    return violations;
  }

  if (result.status < 400) {
    add(
      `the decide endpoint answered ${result.status} to a caller presenting that approval's own ` +
        `retry token; a token holder must be refused, or it can approve its own destructive call`
    );
  }
  if (result.approvalDecided) {
    add(
      'the approval was DECIDED by the caller that requested it — the human half of the gate is optional'
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
  'approval-card-fields',
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

    describe('tier enforcement at every adapter path', () => {
      it('destructive-gate: registry.invoke refuses every destructive capability', async () => {
        const details = (
          await checkRegistryGateConformance(registry, fixtures.sampleInputs ?? {})
        ).map((v) => v.detail);
        expect(details, details.join('\n')).toEqual([]);
      });

      it('decision-authority: the caller that asked cannot grant its own approval', async () => {
        const details = (
          await checkDecisionAuthorityConformance(fixtures.requesterDecideProbe)
        ).map((v) => v.detail);
        expect(details, details.join('\n')).toEqual([]);
      });

      it('tool-group-gate: registry.invoke refuses every capability behind a grant', async () => {
        const details = (
          await checkToolGroupGateConformance(registry, fixtures.sampleInputs ?? {})
        ).map((v) => v.detail);
        expect(details, details.join('\n')).toEqual([]);
      });
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
          //
          // A `destructive` capability is wired correctly and STILL does not run
          // here: the gate inside `invoke` refuses it, which is the whole point of
          // DOR-467 and is asserted properly in the destructive-gate check above.
          //
          // A capability behind a per-agent tool group is the same story one gate
          // earlier: a conformance invocation carries no identity, so it holds no
          // grant and is refused before its handler is reached (DOR-1611). Its
          // refusal is asserted properly in the tool-group-gate check above.
          const ok =
            error === undefined ||
            isCapabilityToolError(error) ||
            ((cap.tier === 'destructive' || cap.toolGroup !== undefined) && isGateRefusal(error));
          expect(ok, error instanceof Error ? error.message : String(error)).toBe(true);
        });
      }
    });
  });
}
