import type {
  OriginalRoomMergeRegistryConstruction,
  CapabilityHandlerContext,
  CapabilityInvocationContext,
  ContributeResult,
} from './registry-context.js';
import type { CapabilityDefinition } from './capability-definition.js';
import type { CapabilityCatalog } from '@dorkos/shared/capabilities';
import type { ExtensionContribution } from './extension-contribution.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';

export interface OriginalRoomMergeInvocation {
  readonly construction: OriginalRoomMergeRegistryConstruction;
  readonly context: CapabilityHandlerContext;
  readonly input: object;
  readonly values: Readonly<{ roomId: string; summary: string }>;
  readonly principal: ServerPrincipalProof;
  readonly signal?: AbortSignal;
  active: boolean;
}
/**
 * The runtime registry produced by {@link composeRegistry}: a frozen core plus
 * a live extension layer. Holds the composed capabilities plus the boot-time
 * dependency bag, and exposes lookup, validated invocation, and catalog
 * serialization.
 */
export interface CapabilityRegistry {
  /**
   * Every registered capability: the core in registration order, then each
   * live extension contribution in contribution order. A frozen array, rebuilt
   * only when a contribution is added or removed.
   */
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
   * @throws A {@link CapabilityToolError} saying the tool is not available right
   *   now when `id` is in the extension namespace but not registered (its
   *   extension stopped or is restarting); if no other capability is registered
   *   under `id`; if `input` fails schema
   *   validation (a `ZodError`); if the context carries both a trusted marker and
   *   an agent identity; or, when the gate (tier and permission together) does
   *   not allow the call, a {@link CapabilityGateRefusal} carrying the payload to
   *   return to the caller.
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
  /**
   * Add one running extension's tools. Never throws: anything wrong comes back
   * as a refusal the caller reports on the extension.
   *
   * Refused, with nothing added, when the contribution is malformed, when its
   * owner already has a live contribution (remove that first — nothing is ever
   * replaced), or when any of its ids or MCP tool names is already claimed by
   * the core or by another contribution. All of one extension's tools are
   * added, or none are.
   *
   * @param contribution - The extension id, display name and tool specs.
   * @returns A handle whose `remove()` takes the tools away, or the refusal.
   */
  contribute(contribution: ExtensionContribution): ContributeResult;
  /**
   * Hear about every successful contribute and remove.
   *
   * @param listener - Called with the new surface version, a monotonically
   *   increasing integer, after each change. A listener that throws is logged
   *   and ignored.
   * @returns A function that stops the listener.
   */
  onChange(listener: (version: number) => void): () => void;
}
