/**
 * Registry composition and catalog serialization for the Capability Registry
 * (spec `capability-registry`, task 2.1).
 *
 * {@link composeRegistry} folds every domain's capabilities into one immutable
 * runtime registry at boot, throwing on any structural conflict (duplicate ids,
 * duplicate surface names, misfiled ids) so an ambiguous surface can never
 * reach production. The registry captures the boot-time dependency bag and can
 * validate-and-invoke a capability by id or emit the serializable
 * {@link CapabilityCatalog} the self-description surfaces consume.
 *
 * @module services/core/capabilities/registry
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  stableStringify,
  type CapabilityCatalog,
  type SerializedCapability,
} from '@dorkos/shared/capabilities';

import type {
  CapabilityDefinition,
  CapabilityDeps,
  CapabilityDomain,
} from './capability-definition.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import {
  CapabilityGateRefusal,
  enforceCapabilityTier,
  type ApprovalRetryChannel,
  type GrantedApproval,
} from './tier-enforcement.js';
import { isTrustedCaller, type TrustedCaller } from './trusted-caller.js';
import { enforceToolGroupGrant } from './tool-group-enforcement.js';

/**
 * What a transport adapter supplies to {@link CapabilityRegistry.invoke}.
 *
 * Threaded from whichever surface received the call (the invoke route, an MCP
 * server, a cockpit route) down to the registry, which is the single choke point
 * every surface funnels through — so the tier gate runs once, here, and
 * attribution is recorded once, here, rather than duplicated into every adapter.
 *
 * Note what this interface does NOT carry: a granted approval. That is the
 * registry's OWN conclusion, produced by the gate it runs, and a caller supplying
 * it would be handing the handler a person's consent nobody gave. Handlers read
 * it off {@link CapabilityHandlerContext} instead.
 */
export interface CapabilityInvocationContext {
  /**
   * The agent behind this call, when one presented a resolved identity token.
   * `undefined` means the human operator or an unattributed client, which is
   * the normal case and does not change whether the gate runs — the capability's
   * TIER decides that (see `tier-enforcement.ts`).
   */
  identity?: AgentIdentity;
  /**
   * Whether the caller claimed to be a machine AT ALL — resolved or not.
   *
   * The wider question than {@link identity}, and a different one: that field
   * answers "WHICH agent is this", which needs a token that verified; this
   * answers "is a machine calling", which a token that did NOT verify still
   * says. It is the same fact `middleware/agent-identity.ts` exposes as
   * `presentsAgentIdentity`, threaded here so the two HTTP surfaces
   * (`routes/capabilities-invoke.ts`, `routes/mcp.ts`) can state it — an
   * in-process surface resolves its caller structurally and leaves it absent.
   *
   * **It exists because absent {@link identity} was doing double duty.** A
   * revoked or expired agent presents a token that resolves to nothing, so it
   * arrived as "nobody this surface could name" — indistinguishable from the
   * person at the keyboard, whom `room-capabilities.ts` answers with the install
   * owner when login is off. That made `post_to_room` write as the operator and
   * `read_room_history` read the operator's rooms (DOR-1361). It changes no tier
   * decision: the gate deliberately never keys on whether a caller identified
   * itself, and an unidentified caller already gets the anonymous ceiling.
   */
  agentIdentityPresented?: boolean;
  /**
   * Proof that this caller may decide approvals, and may therefore act without
   * one — the single, unforgeable way past the gate. Only `trusted-caller.ts` can
   * mint it, and only from the same check that guards the decide endpoint.
   *
   * Supplying this together with {@link identity} is a contradiction and is
   * refused; see the module TSDoc of `trusted-caller.ts`.
   */
  trusted?: TrustedCaller;
  /**
   * The approval token the caller presented on a retry, when it presented one.
   *
   * It travels beside the input rather than inside it, because the approval binds
   * to a hash of the input and a token carried as an input field would change the
   * very hash it is checked against.
   */
  approvalToken?: string;
  /**
   * Which channel a retry should carry its approval token on, so the gate's
   * instructions name the right field for the surface the call arrived on.
   *
   * Defaults to `http-header`, correct for every HTTP surface. An MCP adapter
   * MUST pass `mcp-argument`, or it will tell a model to set a header it has no
   * way to set.
   */
  retryChannel?: ApprovalRetryChannel;
  /**
   * The signed-in PERSON behind this call, when login is on and the surface
   * verified one — a session cookie or a per-user API key.
   *
   * It exists because "no agent identity" is not the same fact as "the owner".
   * A capability that acts on somebody's own data (the rooms domain reads and
   * writes rooms scoped to one member) has to know WHICH person is asking, and
   * the honest answers are three, not two: an agent, a named person, or nobody
   * this surface could name. Resolving the third case to the owner is how an
   * invited user's API key came to read the owner's direct messages.
   *
   * Absent when login is off — where there is genuinely nothing to tell a local
   * program from the person at the keyboard (the documented DOR-505 residual) —
   * and absent on any surface that verifies no person. Informational, never an
   * authorization: it says who the caller is, not what they may do.
   */
  userId?: string;
  /**
   * The session the call was made FROM, when the surface has one — the
   * in-session `dorkos` server sets it from the live session (connector
   * capabilities default their session-scoped actions to it). The external
   * `/mcp` and HTTP surfaces have no invoking session and leave it absent, so a
   * handler that needs one must then be told explicitly. An adapter fact like
   * {@link identity}: informational, never an authorization.
   */
  sessionId?: string;
  /**
   * The working directory that session runs in, when the surface has one.
   *
   * Set beside {@link sessionId} and by the same surface, for handlers that must
   * record WHERE a session lives rather than merely which one it is — a sign-in
   * that outlives the process has to be resumable in the right directory after a
   * restart has taken the live session with it (DOR-981). Informational, never an
   * authorization: it says where the caller is, not what it may do.
   */
  cwd?: string;
}

/**
 * What a capability's handler receives — who is calling, and what the gate
 * already concluded about this exact call.
 *
 * Deliberately a different type from {@link CapabilityInvocationContext}: the
 * fields a caller may SUPPLY and the fields a handler may TRUST are not the same
 * set, and collapsing them is how a shared, memoized adapter context once
 * forwarded an `approval` the gate never granted.
 */
export interface CapabilityHandlerContext {
  /** The agent behind this call, when one presented a resolved identity token. */
  identity?: AgentIdentity;
  /**
   * Whether a machine claimed this call at all, resolved or not. See
   * {@link CapabilityInvocationContext.agentIdentityPresented} — a handler that
   * resolves the caller to a domain principal must refuse when this holds and
   * {@link identity} does not, rather than reading the pair as "no agent".
   */
  agentIdentityPresented?: boolean;
  /**
   * The signed-in person behind this call, when the surface verified one. See
   * {@link CapabilityInvocationContext.userId} for why its ABSENCE is a distinct
   * fact from "the owner" and must be treated as one.
   */
  userId?: string;
  /**
   * The approval the tier gate spent to let this call through, when the call was
   * gated (`destructive` tier) and a person granted it.
   *
   * Set by the registry, never by a caller. A capability whose handler runs its
   * own confirmation flow treats this as consent already given for this exact
   * invocation, so the operator answers one card instead of two.
   */
  approval?: GrantedApproval;
  /**
   * Present when the caller proved it may decide approvals. A handler running its
   * own confirmation flow treats this exactly like {@link approval}: the person
   * whose consent that flow would go and fetch is the one already calling.
   */
  trusted?: TrustedCaller;
  /**
   * The invoking session, when the call arrived through a surface that has one
   * (the in-session `dorkos` server). Session-scoped capabilities (connector
   * attach/detach) default to it; absent on the external `/mcp` and HTTP
   * surfaces, where the caller must name a session explicitly.
   */
  sessionId?: string;
  /**
   * That session's working directory, when the surface carries one — for a
   * handler that must record WHERE the caller is, not merely which session it
   * is. The managed-MCP sign-in stores it on its flow so a token that lands after
   * a restart still resumes the agent in the right place (DOR-981).
   */
  cwd?: string;
}

/**
 * Observer invoked after each capability invocation, for attribution and audit.
 *
 * Kept as an injected hook rather than a direct `ActivityService` dependency so
 * this module stays domain-free (see the module TSDoc on the dependency-free
 * spine). Boot wires it to the Activity feed; tests can assert on it directly.
 * It must never throw — {@link composeRegistry} does not guard the call site
 * beyond swallowing rejections, and an audit failure must not fail the call.
 */
export type CapabilityInvocationObserver = (event: {
  /** The capability that ran. */
  capability: CapabilityDefinition;
  /** The context the handler was invoked with. */
  context: CapabilityHandlerContext;
  /** Whether the handler completed without throwing. */
  ok: boolean;
}) => void;

/**
 * The immutable runtime registry produced by {@link composeRegistry}. Holds the
 * composed capabilities plus the boot-time dependency bag, and exposes lookup,
 * validated invocation, and catalog serialization.
 */
export interface CapabilityRegistry {
  /** Every registered capability, frozen in registration order. */
  readonly capabilities: readonly CapabilityDefinition[];
  /**
   * Look up a capability by its `${domain}.${verb}` id.
   *
   * @param id - The capability id.
   * @returns The definition, or `undefined` if none is registered under `id`.
   */
  get(id: string): CapabilityDefinition | undefined;
  /**
   * Validate `input` against the capability's schema, ENFORCE ITS PERMISSION
   * TIER, invoke its handler with the captured dependency bag, and return the
   * plain typed output (see the result-wrapping seam note in
   * `capability-definition.ts`).
   *
   * The gate is inside this method rather than in front of it (DOR-467). It used
   * to sit in each transport adapter, which meant a surface was gated exactly as
   * long as somebody remembered to gate it — and one did not: the legacy
   * marketplace routes reached an uninstall with no tier check at all, which is
   * the path the seeded skill pack taught agents. A new adapter now inherits the
   * gate by calling this method, and the only way past it is a
   * {@link TrustedCaller}, which no wire payload can mint.
   *
   * @param id - The capability id to invoke.
   * @param input - Raw input; parsed against the capability's `input` schema.
   * @param context - Optional request-scoped context: who is calling, any
   *   approval token they presented, and whether they proved they may decide
   *   approvals. Omitting it invokes as an unidentified, untrusted caller — which
   *   is gated, because the TIER decides that, not the identity.
   * @returns The capability's plain output.
   * @throws If no capability is registered under `id`; if `input` fails schema
   *   validation (a `ZodError`); if the context carries both a trusted marker and
   *   an agent identity; or, when either gate does not allow the call — the
   *   per-agent tool-group grant (`tool-group-enforcement.ts`) or the tier gate —
   *   a {@link CapabilityGateRefusal} carrying the payload to return to the caller.
   */
  invoke(id: string, input: unknown, context?: CapabilityInvocationContext): Promise<unknown>;
  /**
   * Produce the serializable catalog: every capability with its Zod schemas
   * converted to JSON Schema, a fresh `generatedAt`, and a stable
   * `catalogVersion` content hash.
   *
   * @returns The catalog snapshot.
   */
  catalog(): CapabilityCatalog;
}

/**
 * Convert one capability to its serializable catalog entry: drop `invoke` and
 * render both Zod schemas as JSON Schema via Zod v4's native conversion.
 *
 * @param capability - The runtime capability definition.
 * @returns The serialized, wire-safe entry.
 */
export function serializeCapability(capability: CapabilityDefinition): SerializedCapability {
  return {
    id: capability.id,
    title: capability.title,
    description: capability.description,
    tier: capability.tier,
    inputSchema: z.toJSONSchema(capability.input),
    outputSchema: z.toJSONSchema(capability.output),
    surfaces: capability.surfaces,
  };
}

/**
 * Call an invocation observer, swallowing anything it throws.
 *
 * Attribution is a side channel: it must never turn a successful capability
 * call into a failed one, nor mask the handler's own error with its own.
 */
function notify(
  observer: CapabilityInvocationObserver,
  capability: CapabilityDefinition,
  context: CapabilityInvocationContext,
  ok: boolean
): void {
  try {
    observer({ capability, context, ok });
  } catch {
    // Deliberately ignored — see the TSDoc above.
  }
}

/**
 * Compute the stable `catalogVersion` content hash over a set of serialized
 * capabilities.
 *
 * The hash is order-independent in two senses: capabilities are sorted by id,
 * and every object's keys are sorted recursively ({@link stableStringify}),
 * before hashing — so neither the order domains were composed in nor the order
 * fields were written in changes the version. Only the actual content does.
 *
 * @param capabilities - The serialized capabilities to hash.
 * @returns The first 12 hex chars of the SHA-256 digest.
 */
export function computeCatalogVersion(capabilities: readonly SerializedCapability[]): string {
  const sorted = [...capabilities].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(stableStringify(sorted)).digest('hex').slice(0, 12);
}

/**
 * Compose one immutable {@link CapabilityRegistry} from the given domains,
 * capturing `deps` for invocation.
 *
 * Throws at startup — before any request is served — on any structural
 * conflict, so an ambiguous or misfiled surface fails the boot rather than
 * silently shadowing another:
 *
 * - a capability id that does not begin with its owning domain's name;
 * - a duplicate capability id across domains;
 * - a duplicate MCP tool name, CLI verb (+ optional subcommand), or HTTP
 *   method+path across any two capabilities.
 *
 * @param domains - The service domains contributing capabilities.
 * @param deps - The boot-time service-dependency bag captured by the registry.
 * @param onInvocation - Optional observer called after every invocation, for
 *   attribution and audit. Omitted in tests and in the docs-only composer.
 * @returns The frozen, ready-to-serve registry.
 * @throws If any of the structural conflicts above is detected.
 */
export function composeRegistry(
  domains: readonly CapabilityDomain[],
  deps: CapabilityDeps,
  onInvocation?: CapabilityInvocationObserver
): CapabilityRegistry {
  const byId = new Map<string, CapabilityDefinition>();
  const mcpToolNames = new Map<string, string>();
  const cliVerbs = new Map<string, string>();
  const httpRoutes = new Map<string, string>();

  const claim = (table: Map<string, string>, key: string, id: string, label: string): void => {
    const existing = table.get(key);
    if (existing !== undefined) {
      throw new Error(
        `Capability registry: duplicate ${label} "${key}" declared by both "${existing}" and "${id}".`
      );
    }
    table.set(key, id);
  };

  for (const domain of domains) {
    for (const capability of domain.capabilities) {
      const { id, surfaces } = capability;

      if (!id.startsWith(`${domain.name}.`)) {
        throw new Error(
          `Capability registry: id "${id}" must be prefixed with its domain name "${domain.name}." (declared in domain "${domain.name}").`
        );
      }
      if (byId.has(id)) {
        throw new Error(`Capability registry: duplicate capability id "${id}".`);
      }
      byId.set(id, capability);

      if (surfaces.mcp) {
        claim(mcpToolNames, surfaces.mcp.toolName, id, 'MCP tool name');
      }
      if (surfaces.cli) {
        const key = surfaces.cli.subcommand
          ? `${surfaces.cli.verb} ${surfaces.cli.subcommand}`
          : surfaces.cli.verb;
        claim(cliVerbs, key, id, 'CLI verb');
      }
      if (surfaces.http) {
        claim(
          httpRoutes,
          `${surfaces.http.method.toUpperCase()} ${surfaces.http.path}`,
          id,
          'HTTP route'
        );
      }
    }
  }

  // Structural validation passed; now let each domain assert its own deps are
  // present so a registry composed with a domain's capabilities but missing that
  // domain's service handles fails fast at boot (spec `capability-registry`,
  // task 2.3), not on the first invoke.
  for (const domain of domains) {
    domain.assertDeps?.(deps);
  }

  const capabilities: readonly CapabilityDefinition[] = Object.freeze(
    domains.flatMap((domain) => [...domain.capabilities])
  );

  // The registry is immutable, so the JSON-Schema serialization and the content
  // hash are computed once, lazily, and reused (spec §Performance — "catalog
  // serialization cached by content hash"). Only `generatedAt` is refreshed per
  // read, which is trivial and keeps the timestamp honest.
  let serializedCache: { capabilities: SerializedCapability[]; catalogVersion: string } | undefined;

  const registry: CapabilityRegistry = {
    capabilities,
    get(id) {
      return byId.get(id);
    },
    async invoke(id, input, context) {
      const capability = byId.get(id);
      if (!capability) {
        throw new Error(`Capability registry: no capability registered for id "${id}".`);
      }
      const supplied = context ?? {};

      // A present `trusted` that is not a genuine marker is refused LOUDLY rather
      // than quietly downgraded to untrusted. Failing closed would be safe, but
      // silent — and the only ways to get here are a caller forging the field or
      // a module minting it wrongly, both of which someone needs to be told about.
      // Truthiness is NOT enough: `JSON.parse(JSON.stringify(marker))` is a
      // truthy plain object, and reading it as trust is exactly the bypass this
      // marker exists to prevent.
      if (supplied.trusted !== undefined && !isTrustedCaller(supplied.trusted)) {
        throw new Error(
          `Capability registry: "${id}" was invoked with a \`trusted\` value that is not a ` +
            `trusted-caller marker. Only \`trustedCaller\` can mint one; a value that merely ` +
            `looks like it (a JSON round-trip, a hand-built object) is not trust.`
        );
      }

      // Trusted means "no machine principal presented itself"; an identity IS a
      // machine principal presenting itself. The pair cannot both be true, so a
      // caller that assembled it is wrong about something — refuse rather than
      // pick a winner, because picking trust would turn that bug into a bypass.
      if (supplied.trusted && supplied.identity) {
        throw new Error(
          `Capability registry: "${id}" was invoked with both a trusted-caller marker and an agent ` +
            `identity (${supplied.identity.agentPath}). A trusted call is one no machine principal ` +
            `made; these cannot both hold.`
        );
      }

      // Parse ONCE, then gate on exactly the value that will execute — defaults
      // applied, unknown keys stripped. The approval binds to a hash of this
      // value, so hashing anything else (the raw body, or a re-parse) would make
      // the binding cover something other than what runs.
      const parsed = capability.input.parse(input);

      // Always a real object, so a handler can read `context.approval` without
      // guarding for an absent context on every call site. The invoking session
      // id and its directory are adapter facts that ride through on either branch.
      // `agentIdentityPresented` rides on BOTH branches, the trusted one
      // included: a trusted marker and an agent identity are already refused as
      // a contradiction above, so on that branch this can only be false — and
      // forwarding it anyway is what keeps "the handler sees what the surface
      // saw" true without a second rule about when it does not.
      const surface = {
        ...(supplied.agentIdentityPresented ? { agentIdentityPresented: true } : {}),
        ...(supplied.userId ? { userId: supplied.userId } : {}),
        ...(supplied.sessionId ? { sessionId: supplied.sessionId } : {}),
        ...(supplied.cwd ? { cwd: supplied.cwd } : {}),
      };
      const invocationContext: CapabilityHandlerContext = supplied.trusted
        ? { trusted: supplied.trusted, ...surface }
        : { ...(supplied.identity ? { identity: supplied.identity } : {}), ...surface };

      // The gates. A trusted caller skips both, having already proved it may
      // decide the very approval the tier gate would ask for.
      if (!supplied.trusted) {
        // The per-agent tool-group grant, BEFORE the tier gate on purpose: a
        // capability this caller may never reach must not mint an approval card
        // for an action that was never going to run. Ungated capabilities — every
        // one but the few that declare a `toolGroup` — pay one `undefined` check
        // here and nothing else.
        const grant = await enforceToolGroupGrant({
          action: capability,
          ...(supplied.identity ? { identity: supplied.identity } : {}),
        });
        if (grant.outcome !== 'allowed') throw new CapabilityGateRefusal(grant);

        const decision = enforceCapabilityTier({
          action: capability,
          input: parsed,
          ...(supplied.identity ? { identity: supplied.identity } : {}),
          ...(supplied.approvalToken ? { approvalToken: supplied.approvalToken } : {}),
          retryChannel: supplied.retryChannel ?? 'http-header',
        });
        if (decision.outcome !== 'allowed') throw new CapabilityGateRefusal(decision);
        if (decision.approval) invocationContext.approval = decision.approval;
      }

      // No observer, or nothing to attribute: run the original path untouched so
      // an unattributed call stays byte-identical to before this seam existed
      // (spec §3.1 — absent identity is today's behavior).
      //
      // A `destructive` capability is the exception, and it is not optional: the
      // tier gate deliberately does NOT audit an `allowed` call ("allowed calls
      // are audited on invoke", `tier-enforcement.ts`), so skipping the observer
      // for an unidentified caller meant an irreversible action that actually RAN
      // produced an `approval_required` line and then silence. Two seams each
      // correctly deferred to the other and the record fell between them.
      const auditedWithoutIdentity = capability.tier === 'destructive';
      if (!onInvocation || (!invocationContext.identity && !auditedWithoutIdentity)) {
        return capability.invoke(deps, parsed, invocationContext);
      }

      // Report the outcome either way: a failed attempt by a named agent is
      // exactly as interesting to an audit trail as a successful one.
      try {
        const result = await capability.invoke(deps, parsed, invocationContext);
        notify(onInvocation, capability, invocationContext, true);
        return result;
      } catch (err) {
        notify(onInvocation, capability, invocationContext, false);
        throw err;
      }
    },
    catalog() {
      if (!serializedCache) {
        const serialized = capabilities.map(serializeCapability);
        serializedCache = {
          capabilities: serialized,
          catalogVersion: computeCatalogVersion(serialized),
        };
      }
      return {
        catalogVersion: serializedCache.catalogVersion,
        generatedAt: new Date().toISOString(),
        capabilities: serializedCache.capabilities,
      };
    },
  };

  return Object.freeze(registry);
}
