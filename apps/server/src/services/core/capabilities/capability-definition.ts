/**
 * The runtime half of the Capability Registry: how a service domain declares a
 * capability exactly once (spec `capability-registry`, task 2.1).
 *
 * A {@link CapabilityDefinition} pairs a capability's identity (id, title,
 * model-facing description, permission tier), its Zod input/output contract,
 * the surfaces it projects onto, and a transport-neutral `invoke` handler.
 * From this single declaration every agent-facing surface is generated (both
 * MCP servers, CLI operator verbs, OpenAPI paths, self-description catalog) —
 * later phase-2 tasks build those projections; this module is only the spine.
 *
 * This module imports no domain (operator, marketplace, …): domains migrate
 * ONTO the registry (task 2.2), never the other way round, so the spine stays
 * dependency-free and cycle-free.
 *
 * ## The result-wrapping seam
 *
 * `invoke` returns PLAIN typed data (`z.infer<Out>`), NOT an MCP
 * `{ content: [...] }` envelope. The phase-1 descriptor handlers wrapped their
 * payloads into text-content blocks themselves; under the registry that
 * wrapping belongs to the transport adapters (task 2.2's
 * `registerCapabilitiesAsMcpTools`), which call `invoke`, then serialize the
 * plain result into whatever shape their transport needs (MCP `CallToolResult`,
 * an HTTP JSON body, a CLI render). Redaction and other payload semantics that
 * must hold on EVERY surface stay inside `invoke` (ADR 260723-013236); only the
 * envelope shape is the adapter's job.
 *
 * @module services/core/capabilities/capability-definition
 */
import type { z } from 'zod';
import type { Logger } from '@dorkos/shared/logger';
import type { CapabilityTier, CapabilitySurfaces } from '@dorkos/shared/capabilities';
import type { CapabilityInvocationContext } from './registry.js';

/**
 * The service-dependency bag threaded into every capability's `invoke` at boot,
 * following the existing pattern (`McpToolDeps`, `MarketplaceMcpDeps`): a flat
 * interface of service handles constructed once in `index.ts` and captured by
 * {@link composeRegistry}.
 *
 * The spine declares only the boot infra every domain shares. Migrating domains
 * (task 2.2) EXTEND this interface with the service handles they need — the same
 * way `McpToolDeps` grew — and each capability's `invoke` narrows to the subset
 * it actually reads. It is deliberately not generic: a single concrete bag keeps
 * every call site and every downstream projection uniform.
 */
export interface CapabilityDeps {
  /** Structured logger threaded at boot; any capability may log through it. */
  logger: Logger;
}

/**
 * A capability declared by a service domain: the single source of truth every
 * agent-facing surface is generated from.
 *
 * The generic parameters are erased to the array-element boundary by
 * {@link defineCapability}, which type-checks the `invoke` handler against the
 * declared schemas before erasing — so a registry holds a homogeneous
 * `CapabilityDefinition[]` while each definition site stays fully type-checked.
 *
 * Confirmation-gated capabilities (e.g. `marketplace.install`,
 * `marketplace.create_package`) model their approval-token state machine INSIDE
 * `invoke` and their `output` schema (a `requires_confirmation` result carrying
 * a token, re-invoked with that token) — by design, there is no declarative
 * "needs confirmation" flag on the definition. The registry treats these as
 * ordinary capabilities; that trust boundary lives in the handler.
 *
 * The `tier` gate is the separate, declarative one, and it runs OUTSIDE the
 * handler: every choke point calls `enforceCapabilityTier` before `invoke`
 * (`tier-enforcement.ts`). A handler that also gates itself reads
 * `context.approval` so the two never ask a person twice for one action.
 *
 * @template In - The Zod input schema type.
 * @template Out - The Zod output schema type.
 */
export interface CapabilityDefinition<
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> {
  /**
   * Stable `${domain}.${verb}` identifier, e.g. `config.get`,
   * `marketplace.install`. The prefix must equal the owning domain's name.
   */
  id: `${string}.${string}`;
  /** Human-facing title. */
  title: string;
  /**
   * Model-facing description (ACI style): what the capability does and when to
   * reach for it, written for the agent that will decide to call it.
   */
  description: string;
  /**
   * Permission tier. Enforced by `enforceCapabilityTier` at every choke point
   * before this handler runs, so `destructive` really does mean "a person has to
   * say yes first" (see `tier-enforcement.ts`).
   */
  tier: CapabilityTier;
  /** Zod input contract; validated before `invoke`, projected as JSON Schema. */
  input: In;
  /** Zod output contract; projected as JSON Schema in the catalog. */
  output: Out;
  /** The MCP / CLI / HTTP surfaces this capability projects onto. */
  surfaces: CapabilitySurfaces;
  /**
   * The input fields the approval card may show, as dotted paths, in the order a
   * person should read them.
   *
   * An allowlist rather than a redaction list, because the failure it prevents is
   * a field nobody thought about reaching a card. The summary is broadcast on the
   * global event stream and returned by `GET /api/approvals/pending`, which agents
   * can read — so `marketplace.uninstall`'s own `confirmationToken` field, whose
   * description tells a model to re-call with a token, would otherwise publish a
   * live secret to every connected cockpit.
   *
   * Declare this on any `destructive` capability — conformance fails one that does
   * not, and one that names a secret-shaped field. Omitting it is otherwise safe
   * but blunt: every top-level field is shown except those whose NAME says secret
   * (`approval-summary.ts`), and a nested object renders as an unhelpful
   * `details` — naming `options.purge` here fixes that.
   *
   * **Order most-consequential-first.** The whole sentence is capped at
   * `APPROVAL_SUMMARY_MAX_LENGTH`, and while today's cards are nowhere near it (312
   * characters worst case), a capability declaring several long string fields could
   * push a later one past the cap. The field that decides how much damage the action
   * does should never be the one at risk of being cut.
   */
  approvalDisplayFields?: readonly string[];
  /**
   * Execute the capability against the injected dependencies, returning PLAIN
   * typed output (see the module-level "result-wrapping seam" note — transport
   * adapters own envelope shaping; redaction stays here).
   *
   * @param deps - The boot-time service-dependency bag.
   * @param input - The validated input (already parsed against {@link input}).
   * @param context - Who is calling and what the tier gate already decided about
   *   this exact call. Most handlers ignore it; a handler that runs its own
   *   confirmation flow reads `context.approval` so a person who has ALREADY
   *   approved this invocation at the choke point is not asked a second time.
   * @returns The plain typed output.
   */
  invoke(
    deps: CapabilityDeps,
    input: z.infer<In>,
    context: CapabilityInvocationContext
  ): Promise<z.infer<Out>>;
}

/**
 * Declare a capability, type-checking that its `invoke` handler consumes and
 * produces exactly what its `input`/`output` schemas describe, then erasing the
 * schema generics to the shared array-element type so a domain can collect a
 * homogeneous `CapabilityDefinition[]`.
 *
 * The single `as unknown as` cast is confined here (mirroring the phase-1
 * `defineOperatorTool` / `defineMarketplaceTool` helpers): it bridges the
 * contravariance between a specific handler input and the erased base, while
 * every call site keeps full type-checking of the schema/handler pairing.
 *
 * @template In - The Zod input schema type (inferred from `spec.input`).
 * @template Out - The Zod output schema type (inferred from `spec.output`).
 * @param spec - The fully-typed capability declaration.
 * @returns The type-erased definition for a registry array.
 */
export function defineCapability<In extends z.ZodType, Out extends z.ZodType>(
  spec: CapabilityDefinition<In, Out>
): CapabilityDefinition {
  return spec as unknown as CapabilityDefinition;
}

/**
 * A service domain's contribution to the registry: its name (the id prefix and
 * OpenAPI tag) and the capabilities it owns.
 */
export interface CapabilityDomain {
  /** Domain name — the `${domain}` id prefix, e.g. `operator`, `marketplace`. */
  name: string;
  /** The capabilities this domain declares. */
  capabilities: readonly CapabilityDefinition[];
  /**
   * Optional startup assertion that the composed dependency bag carries the
   * service handles this domain's capabilities need. Called once by
   * {@link composeRegistry} after structural validation, so a registry composed
   * with a domain's capabilities but missing that domain's deps fails fast at
   * boot with a clear error — never on first invoke.
   *
   * @param deps - The boot-time dependency bag the registry captured.
   * @throws If a required dependency is absent.
   */
  assertDeps?(deps: CapabilityDeps): void;
}
