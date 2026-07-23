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
 * ordinary capabilities; the trust boundary lives in the handler.
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
  /** Permission tier (declared now, enforced in phase 3). */
  tier: CapabilityTier;
  /** Zod input contract; validated before `invoke`, projected as JSON Schema. */
  input: In;
  /** Zod output contract; projected as JSON Schema in the catalog. */
  output: Out;
  /** The MCP / CLI / HTTP surfaces this capability projects onto. */
  surfaces: CapabilitySurfaces;
  /**
   * Execute the capability against the injected dependencies, returning PLAIN
   * typed output (see the module-level "result-wrapping seam" note — transport
   * adapters own envelope shaping; redaction stays here).
   *
   * @param deps - The boot-time service-dependency bag.
   * @param input - The validated input (already parsed against {@link input}).
   * @returns The plain typed output.
   */
  invoke(deps: CapabilityDeps, input: z.infer<In>): Promise<z.infer<Out>>;
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
