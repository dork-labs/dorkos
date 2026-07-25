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
import type { GrantedApproval } from './tier-enforcement.js';

/**
 * Request-scoped context for one capability invocation.
 *
 * Threaded from whichever transport adapter received the call (the invoke
 * route, an MCP server) down to the registry, which is the single choke point
 * every surface funnels through — so attribution is recorded once, here, rather
 * than duplicated into every capability handler.
 */
export interface CapabilityInvocationContext {
  /**
   * The agent behind this call, when one presented a resolved identity token.
   * `undefined` means the human operator or an unattributed client, which is
   * the normal case and changes nothing about how the call runs.
   */
  identity?: AgentIdentity;
  /**
   * The approval the tier gate spent to let this call through, when the call was
   * gated (`destructive` tier) and a person granted it.
   *
   * Set by the choke point, never by a caller. A capability whose handler runs
   * its own confirmation flow treats this as consent already given for this exact
   * invocation, so the operator answers one card instead of two.
   */
  approval?: GrantedApproval;
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
  /** The context the transport adapter supplied. */
  context: CapabilityInvocationContext;
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
   * Validate `input` against the capability's schema, invoke its handler with
   * the captured dependency bag, and return the plain typed output (see the
   * result-wrapping seam note in `capability-definition.ts`).
   *
   * @param id - The capability id to invoke.
   * @param input - Raw input; parsed against the capability's `input` schema.
   * @param context - Optional request-scoped context (the calling agent's
   *   identity). Omitting it invokes exactly as before, unattributed.
   * @returns The capability's plain output.
   * @throws If no capability is registered under `id`, or if `input` fails
   *   schema validation (a `ZodError`).
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
      const parsed = capability.input.parse(input);
      // Always a real object, so a handler can read `context.approval` without
      // guarding for an absent context on every call site.
      const invocationContext = context ?? {};

      // No observer, or nothing to attribute: run the original path untouched
      // so an unattributed call stays byte-identical to before this seam
      // existed (spec §3.1 — absent identity is today's behavior).
      if (!onInvocation || !invocationContext.identity) {
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
