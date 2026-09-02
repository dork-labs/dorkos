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
 * must hold on EVERY surface stay inside `invoke` (ADR 260725-152018); only the
 * envelope shape is the adapter's job.
 *
 * @module services/core/capabilities/capability-definition
 */
import type { z } from 'zod';
import type { Logger } from '@dorkos/shared/logger';
import type { CapabilityTier, CapabilitySurfaces } from '@dorkos/shared/capabilities';
import type { CapabilityHandlerContext } from './registry.js';
import type { InSessionCardKind } from './in-session-card.js';

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
 * A per-agent grant a capability may require, keyed by the name it carries in an
 * agent manifest's `enabledToolGroups` (`packages/shared/src/mesh-schemas.ts`).
 *
 * One member today. These are the HARD keys of that object: unlike the four
 * documentation keys beside them, a capability naming one here is refused for an
 * agent that does not hold it. See {@link CapabilityDefinition.toolGroup}.
 */
export type CapabilityToolGroup = 'roomsManage';

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
 * handler, inside `registry.invoke` itself (`tier-enforcement.ts`, DOR-467) — so
 * it cannot be reached around. A handler that also gates itself reads
 * `context.approval` (or `context.trusted`) so the two never ask a person twice
 * for one action.
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
   * Permission tier. Enforced inside `registry.invoke` before this handler runs,
   * so `destructive` really does mean "a person has to say yes first" (see
   * `tier-enforcement.ts`).
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
   * The ONE input field a person has to read in full before answering, as a
   * dotted path. Its value is carried to the card verbatim, beside the summary
   * sentence rather than inside it.
   *
   * This exists because {@link approvalDisplayFields} cannot answer the question
   * for every capability, and the gap is a real one rather than a cosmetic one
   * (DOR-1698). A summary value is capped at 80 characters so that no single
   * argument can crowd out another, which is right when the value is a package
   * name and wrong when the value IS the decision — the new text of the file
   * that tells an agent what it must not do. Review reproduced the attack: 2,000
   * characters whose first 80 were the current boundaries verbatim, with the
   * part that undid them past the clamp, approved by an operator who could not
   * see it.
   *
   * Rules, all of them checked by the conformance suite:
   *
   * - Only a `destructive` capability may declare one. A tier that does not stop
   *   has no card to put it on.
   * - It must name a real top-level field of the capability's own `input`.
   * - It must NOT also appear in {@link approvalDisplayFields}: the point is one
   *   full rendering, not a truncated copy beside a complete one.
   * - Its name must not read as a secret, for the same reason the display fields'
   *   do not — this value reaches the global event stream and the agent-readable
   *   pending list.
   *
   * Bounded at `APPROVAL_DETAIL_MAX_LENGTH` where it is stored, so a capability
   * whose field could exceed that must cap its own input lower.
   */
  approvalDetailField?: string;
  /**
   * Draw an inline CARD in the conversation this capability was called from
   * (DOR-1004) — a surface the person acts on, in the chat, instead of a link
   * pasted into the agent's reply.
   *
   * Declarative on purpose: the capability says WHAT belongs on screen and the
   * in-session MCP projection decides whether there is a screen to put it on
   * (`in-session-card.ts`). The handler itself never learns which surface it is
   * running on, so the sessionless surfaces — external `/mcp`, HTTP — keep
   * returning the full payload for a caller that has no card to look at.
   *
   * Unlike the destructive-tier hold, a card does NOT stop the call: it is
   * pushed, the result is returned, and the turn ends. Anything a card is worth
   * drawing for (a browser OAuth round trip) outlasts any hold a turn can
   * afford.
   */
  inSessionCard?: InSessionCardKind;
  /**
   * The per-agent grant this capability requires, if any.
   *
   * Declaring it makes the capability HARD-GATED: `registry.invoke` refuses the
   * call unless the resolved caller is an identified agent holding the grant.
   * Undeclared (the default, and every capability today) means ungated — the tier
   * gate is the only gate.
   *
   * Unlike the four `enabledToolGroups` keys in `mcp-tool-groups.ts`, which shape
   * documentation only (ADR 260726-171347), this field is a real boundary. Do not
   * add one without reading that ADR's condition on agent-writable grants: a
   * grant the governed agent can set for itself is not a grant, which is why
   * `updateAgentManifest` refuses the field on the agent-reachable write path.
   *
   * Declarative for the same reason `inSessionCard` is: the capability states
   * WHICH grant it needs and a seam elsewhere decides what to do about it
   * (`tool-group-enforcement.ts`). The handler never learns the answer, because a
   * refused call has no handler run.
   */
  toolGroup?: CapabilityToolGroup;
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
    context: CapabilityHandlerContext
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
