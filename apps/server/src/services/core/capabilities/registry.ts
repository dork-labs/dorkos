import { serializeCapability, computeCatalogVersion, notify } from './registry-catalog.js';
export { serializeCapability, computeCatalogVersion } from './registry-catalog.js';
import type { OriginalRoomMergeRegistryConstruction } from './registry-context.js';
export type { OriginalRoomMergeRegistryConstruction } from './registry-context.js';
import type {
  CapabilityInvocationContext,
  CapabilityHandlerContext,
  CapabilityInvocationObserver,
  ContributeResult,
} from './registry-context.js';
export type {
  CapabilityInvocationContext,
  CapabilityPreflightResult,
  HandToolReach,
  CapabilityHandlerContext,
  CapabilityInvocationObserver,
  ContributeResult,
} from './registry-context.js';
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
 * The core is frozen at boot. On top of it sits one live layer: a running
 * extension may {@link CapabilityRegistry.contribute | contribute} tools while
 * it runs and remove them when it stops (DOR-2685). That layer lives in its own
 * reserved namespace (`ext_<id>`), is checked against the same claim tables as
 * the core, and is reached through the same gate.
 *
 * @module services/core/capabilities/registry
 */
import type { Db } from '@dorkos/db';
import type { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import {
  requireRoomMergeRegistryConstruction,
  type RoomMergeService,
} from '../../rooms/repo/room-merge-service.js';

interface OriginalRoomMergeInvocation {
  readonly construction: OriginalRoomMergeRegistryConstruction;
  readonly context: CapabilityHandlerContext;
  readonly input: object;
  readonly values: Readonly<{ roomId: string; summary: string }>;
  readonly principal: ServerPrincipalProof;
  readonly signal?: AbortSignal;
  active: boolean;
}
const originalRoomMergeContexts = new WeakMap<object, object>();
const originalRoomMergeInvocations = new WeakMap<object, OriginalRoomMergeInvocation>();
/** Read only the handle minted by the actual captured handler invocation after its real gates. */
export function readOriginalRoomMergeInvocation(
  context: CapabilityHandlerContext,
  input: object,
  service: RoomMergeService
): object {
  const handle = originalRoomMergeContexts.get(context);
  const record = handle ? originalRoomMergeInvocations.get(handle) : undefined;
  if (
    !handle ||
    !record?.active ||
    record.context !== context ||
    record.input !== input ||
    record.construction.service !== service
  )
    throw new Error('Room merge requires its actual original gated invocation.');
  requireOriginalRoomMergeInvocation(
    handle,
    service,
    record.construction.nativePrincipals,
    record.construction.db
  );
  return handle;
}
/** Fixed constructor/identity/lifetime recognition. Native currentness and Room policy remain separate. */
export function requireOriginalRoomMergeInvocation(
  handle: object,
  service: RoomMergeService,
  nativePrincipals: ConnectorRuntimePrincipalService,
  db: Db
): Readonly<{
  roomId: string;
  summary: string;
  principal: ServerPrincipalProof;
  signal?: AbortSignal;
}> {
  const record = originalRoomMergeInvocations.get(handle);
  if (
    !record?.active ||
    record.construction.service !== service ||
    record.construction.nativePrincipals !== nativePrincipals ||
    record.construction.db !== db ||
    originalRoomMergeContexts.get(record.context) !== handle ||
    record.context.serverPrincipal !== record.principal ||
    record.context.signal !== record.signal ||
    record.signal?.aborted
  )
    throw new Error('Room merge invocation is foreign, retired or aborted.');
  const input = record.input as { roomId?: unknown; summary?: unknown };
  if (input.roomId !== record.values.roomId || input.summary !== record.values.summary)
    throw new Error('Room merge invocation input changed.');
  requireRoomMergeRegistryConstruction(service, nativePrincipals, db);
  if (!record.active || originalRoomMergeInvocations.get(handle) !== record)
    throw new Error('Room merge invocation retired during construction recognition.');
  return Object.freeze({ ...record.values, principal: record.principal, signal: record.signal });
}

import { runAsAgent } from '../../audit/audit-trail.js';
import {
  EXTENSION_TOOL_UNAVAILABLE_CODE,
  EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
  isExtensionCapabilityId,
  type CapabilityCatalog,
  type SerializedCapability,
} from '@dorkos/shared/capabilities';

import type {
  CapabilityDefinition,
  CapabilityDeps,
  CapabilityDomain,
} from './capability-definition.js';
import { CapabilityGateRefusal, enforceCapabilityTier } from './tier-enforcement.js';
import { isTrustedCaller } from './trusted-caller.js';
import { resolveCallPermission } from './permission-enforcement.js';
import { resolveApprovalSubject } from '../approvals/approval-subject.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import { isServerPrincipal } from '../../connectors/principal/server-principal.js';
import { isCapabilityAuthorityBinding } from '../../connectors/principal/capability-authority-binding.js';
import { CapabilityToolError } from './mcp-envelope.js';
import {
  buildExtensionDefinitions,
  checkExtensionContribution,
  EXTENSION_DOMAIN_PREFIX,
  EXTENSION_TOOLS_AREA,
  type ExtensionContribution,
} from './extension-contribution.js';

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

const originalRegistryInvocations = new WeakMap<CapabilityRegistry, CapabilityRegistry['invoke']>();

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
 *   method+path across any two capabilities;
 * - a domain named in the extension namespace (`ext_…`), or a capability that
 *   claims an extension `source` — both are the live layer's alone.
 *
 * @param domains - The service domains contributing capabilities.
 * @param deps - The boot-time service-dependency bag captured by the registry.
 * @param onInvocation - Optional observer called after every invocation, for
 *   attribution and audit. Omitted in tests and in the docs-only composer.
 * @returns The frozen, ready-to-serve registry. Its core never changes; only
 *   the extension layer does, through `contribute`.
 * @throws If any of the structural conflicts above is detected.
 */
export function composeRegistry(
  domains: readonly CapabilityDomain[],
  deps: CapabilityDeps,
  onInvocation?: CapabilityInvocationObserver,
  originalRoomMerge?: OriginalRoomMergeRegistryConstruction
): CapabilityRegistry {
  const mergeConstruction = originalRoomMerge ? Object.freeze({ ...originalRoomMerge }) : undefined;
  if (mergeConstruction)
    requireRoomMergeRegistryConstruction(
      mergeConstruction.service,
      mergeConstruction.nativePrincipals,
      mergeConstruction.db
    );
  let mergeDefinition: CapabilityDefinition | undefined;
  let mergeHandler: CapabilityDefinition['invoke'] | undefined;
  let mergeParse: ((input: unknown) => unknown) | undefined;
  const originalDocumentCalls = new Map<
    CapabilityDefinition,
    {
      parse: (input: unknown) => unknown;
      invoke: CapabilityDefinition['invoke'];
    }
  >();
  const documentIds = new Set([
    'ui.configure_doc_channel',
    'ui.approve_doc_route',
    'ui.revoke_doc_route',
    'ui.inspect_doc_channel',
    'ui.issue_doc_token',
    'ui.revoke_doc_token',
    'ui.replay_doc_batch',
  ]);
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
    if (domain.name.startsWith(EXTENSION_DOMAIN_PREFIX)) {
      throw new Error(
        `Capability registry: domain "${domain.name}" uses the "${EXTENSION_DOMAIN_PREFIX}" prefix, which is reserved for extension tools.`
      );
    }
    for (const capability of domain.capabilities) {
      const { id, surfaces } = capability;
      if (capability.source !== undefined) {
        throw new Error(
          `Capability registry: core capability "${id}" declares a source; only extension tools carry one.`
        );
      }

      if (!id.startsWith(`${domain.name}.`)) {
        throw new Error(
          `Capability registry: id "${id}" must be prefixed with its domain name "${domain.name}." (declared in domain "${domain.name}").`
        );
      }
      if (byId.has(id)) {
        throw new Error(`Capability registry: duplicate capability id "${id}".`);
      }
      if (id === 'rooms.merge' && mergeConstruction) {
        // Keep original permission/tier primitives and function pointers private and fixed.
        mergeDefinition = Object.freeze({ ...capability });
        mergeHandler = capability.invoke.bind(capability);
        mergeParse = capability.input.parse.bind(capability.input);
        byId.set(id, mergeDefinition);
      } else if (documentIds.has(id)) {
        const original = Object.freeze({ ...capability });
        originalDocumentCalls.set(original, {
          parse: capability.input.parse.bind(capability.input),
          invoke: capability.invoke.bind(capability),
        });
        byId.set(id, original);
      } else byId.set(id, capability);

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

  const core: readonly CapabilityDefinition[] = Object.freeze(
    domains.flatMap((domain) => domain.capabilities.map((capability) => byId.get(capability.id)!))
  );

  // The live extension layer (DOR-2685). Kept apart from the core tables so a
  // contribution can be checked against both and removed without ever touching
  // a core claim. Map insertion order is contribution order.
  const contributions = new Map<string, readonly CapabilityDefinition[]>();
  const extensionById = new Map<string, CapabilityDefinition>();
  const extensionToolNames = new Set<string>();
  const listeners = new Set<(version: number) => void>();
  let capabilities = core;
  let surfaceVersion = 0;

  // The JSON-Schema serialization and the content hash are computed lazily and
  // reused until the capability list changes (spec §Performance — "catalog
  // serialization cached by content hash"). A contribute or remove drops the
  // cache, and the hash is recomputed from the whole list, so removing a
  // contribution returns `catalogVersion` to exactly what it was before. Only
  // `generatedAt` is refreshed per read, which keeps the timestamp honest.
  let serializedCache: { capabilities: SerializedCapability[]; catalogVersion: string } | undefined;

  const lookup = (id: string): CapabilityDefinition | undefined =>
    byId.get(id) ?? extensionById.get(id);

  /** Rebuild the live list, drop the catalog cache, and tell every listener. */
  const changed = (): void => {
    capabilities = Object.freeze([...core, ...[...contributions.values()].flat()]);
    serializedCache = undefined;
    surfaceVersion += 1;
    const version = surfaceVersion;
    for (const listener of [...listeners]) {
      try {
        listener(version);
      } catch (err) {
        deps.logger.warn('[capabilities] a registry change listener threw', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const contribute = (contribution: ExtensionContribution): ContributeResult => {
    const checked = checkExtensionContribution(contribution);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const { owner, displayName } = checked.value;
    if (contributions.has(owner)) {
      return { ok: false, reason: `${displayName} already has tools registered` };
    }
    const definitions = Object.freeze(
      buildExtensionDefinitions(checked.value, EXTENSION_TOOLS_AREA)
    );
    // Check every claim before adding anything, so a refusal leaves the
    // registry exactly as it was: all of one extension's tools, or none.
    // While the id and tool-name rules hold, an extension's names cannot clash
    // with another extension's (the mapping is injective) and its ids cannot
    // clash with the core's (the `ext_` prefix is reserved); a core MCP tool
    // name, which is free-form, can. Every table is still consulted, so that
    // loosening a rule later fails closed instead of shadowing a tool.
    for (const definition of definitions) {
      if (lookup(definition.id)) {
        return { ok: false, reason: `"${definition.id}" is already registered` };
      }
      const toolName = definition.surfaces.mcp!.toolName;
      if (mcpToolNames.has(toolName) || extensionToolNames.has(toolName)) {
        return { ok: false, reason: `the tool name "${toolName}" is already taken` };
      }
    }
    for (const definition of definitions) {
      extensionById.set(definition.id, definition);
      extensionToolNames.add(definition.surfaces.mcp!.toolName);
    }
    contributions.set(owner, definitions);
    changed();

    let removed = false;
    return {
      ok: true,
      remove() {
        // Once only: the same owner may have contributed afresh since, and a
        // second call on this handle must never take that newer one away.
        if (removed) return;
        removed = true;
        contributions.delete(owner);
        for (const definition of definitions) {
          extensionById.delete(definition.id);
          extensionToolNames.delete(definition.surfaces.mcp!.toolName);
        }
        changed();
      },
    };
  };

  const registry: CapabilityRegistry = {
    get capabilities() {
      return capabilities;
    },
    get(id) {
      return lookup(id);
    },
    contribute,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async invoke(id, input, context) {
      const capability = lookup(id);
      if (!capability) {
        // A tool from a stopped or restarting extension is a normal moment,
        // not a wiring bug: an agent may still hold a tool list built while it
        // ran. Answer the way any tool error answers, so the agent reads why.
        if (isExtensionCapabilityId(id)) {
          throw new CapabilityToolError({
            error: EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
            code: EXTENSION_TOOL_UNAVAILABLE_CODE,
          });
        }
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

      if (supplied.serverPrincipal !== undefined && !isServerPrincipal(supplied.serverPrincipal)) {
        throw new Error(
          `Capability registry: "${id}" was invoked with an unauthenticated server principal.`
        );
      }

      // Parse ONCE, then gate on exactly the value that will execute — defaults
      // applied, unknown keys stripped. The approval binds to a hash of this
      // value, so hashing anything else (the raw body, or a re-parse) would make
      // the binding cover something other than what runs.
      const parsed =
        capability === mergeDefinition && mergeParse
          ? mergeParse(input)
          : originalDocumentCalls.has(capability)
            ? originalDocumentCalls.get(capability)!.parse(input)
            : capability.input.parse(input);

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
        ...(supplied.serverPrincipal ? { serverPrincipal: supplied.serverPrincipal } : {}),
        ...(supplied.mcpServer ? { mcpServer: supplied.mcpServer } : {}),
        ...(supplied.signal ? { signal: supplied.signal } : {}),
        ...(supplied.connectorAgentId ? { connectorAgentId: supplied.connectorAgentId } : {}),
        ...(supplied.connectorSurface ? { connectorSurface: supplied.connectorSurface } : {}),
      };
      const invocationContext: CapabilityHandlerContext = supplied.trusted
        ? { trusted: supplied.trusted, ...surface }
        : { ...(supplied.identity ? { identity: supplied.identity } : {}), ...surface };

      const preflight = capability.preflight
        ? await capability.preflight(deps, parsed, supplied)
        : undefined;
      if (preflight && !isCapabilityAuthorityBinding(preflight.authorityBinding)) {
        throw new Error(
          `Capability registry: "${id}" preflight returned an unauthenticated authority binding.`
        );
      }
      if (preflight) invocationContext.preflight = preflight;
      // Only the request tool forwards a token, to the action it asks for; see
      // `CapabilityDefinition.forwardsApproval`.
      if (capability.forwardsApproval) {
        if (supplied.approvalToken) invocationContext.approvalToken = supplied.approvalToken;
        if (supplied.retryChannel) invocationContext.retryChannel = supplied.retryChannel;
        if (supplied.handTools) invocationContext.handTools = supplied.handTools;
      }

      // Existing trusted callers retain their ordinary bypass. A capability with
      // live preflight always reaches the tier gate, so destructive connector
      // execution still consumes a bound approval even for a trusted operator.
      if (!supplied.trusted || preflight) {
        // The permission, resolved fresh for THIS call (spec `agent-permissions`
        // D6). A trusted caller is a person, whom no agent permission governs, so
        // it passes `null` and the tier alone decides, exactly as before.
        const permission = supplied.trusted
          ? null
          : await resolveCallPermission({
              action: capability,
              input: parsed,
              ...(supplied.identity ? { identity: supplied.identity } : {}),
            });
        // Named here rather than in the gate, which is synchronous (DOR-1929):
        // an action that can raise a card and declares its subject gets a card
        // that says WHICH thing it is about.
        const subject = await resolveApprovalSubject(capability.approvalSubject, parsed);
        // What would change, read from what is there now, for the card and for
        // the approval's binding (DOR-2328, `describeApprovalChange`).
        const change = capability.describeApprovalChange
          ? await capability.describeApprovalChange(deps, parsed)
          : undefined;
        const decision = enforceCapabilityTier({
          action: capability,
          input: parsed,
          permission,
          ...(subject ? { subject } : {}),
          ...(change !== undefined ? { change } : {}),
          ...(supplied.identity ? { identity: supplied.identity } : {}),
          ...(supplied.approvalToken ? { approvalToken: supplied.approvalToken } : {}),
          retryChannel: supplied.retryChannel ?? 'http-header',
          // Where a verdict decided after the in-session hold gave up should be
          // delivered (spec `approval-verdict-delivery`). The surface facts the
          // adapter already forwards, handed on as a delivery ADDRESS — the gate
          // reads nothing in it to decide anything. A sessionless surface (the
          // external `/mcp` server, HTTP) supplies none, which is exactly the set
          // with nowhere to deliver to.
          ...(supplied.sessionId
            ? {
                requestingSession: {
                  sessionId: supplied.sessionId,
                  ...(supplied.cwd ? { cwd: supplied.cwd } : {}),
                },
              }
            : {}),
          ...(preflight ? { connectorAuthority: preflight.authorityBinding.approvalScope } : {}),
          ...(preflight?.approvalServiceAction
            ? { serviceAction: preflight.approvalServiceAction }
            : {}),
          ...(supplied.blockedRequest ? { blockedRequest: supplied.blockedRequest } : {}),
        });
        if (decision.outcome !== 'allowed') throw new CapabilityGateRefusal(decision);
        if (decision.approval) invocationContext.approval = decision.approval;
        if (change !== undefined) invocationContext.approvedChange = change;
      }

      let mergeHandle: object | undefined;
      let mergeRecord: OriginalRoomMergeInvocation | undefined;
      if (id === 'rooms.merge' && mergeConstruction) {
        if (
          capability !== mergeDefinition ||
          !mergeHandler ||
          !invocationContext.serverPrincipal ||
          !isServerPrincipal(invocationContext.serverPrincipal) ||
          typeof parsed !== 'object' ||
          parsed === null
        )
          throw new Error('Room merge original construction or principal is unavailable.');
        const values = parsed as { roomId?: unknown; summary?: unknown };
        if (typeof values.roomId !== 'string' || typeof values.summary !== 'string')
          throw new Error('Room merge input is malformed.');
        mergeHandle = Object.freeze({});
        mergeRecord = {
          construction: mergeConstruction,
          context: invocationContext,
          input: parsed,
          values: Object.freeze({ roomId: values.roomId, summary: values.summary }),
          principal: invocationContext.serverPrincipal,
          signal: invocationContext.signal,
          active: true,
        };
        originalRoomMergeInvocations.set(mergeHandle, mergeRecord);
        originalRoomMergeContexts.set(invocationContext, mergeHandle);
      }
      const invokeHandler = (): Promise<unknown> =>
        capability === mergeDefinition && mergeHandler
          ? mergeHandler(deps, parsed, invocationContext)
          : originalDocumentCalls.has(capability)
            ? originalDocumentCalls.get(capability)!.invoke(deps, parsed, invocationContext)
            : capability.invoke(deps, parsed, invocationContext);
      // Keep caller audit attribution around the captured original handler.
      const run = () =>
        runAsAgent(invocationContext.identity, supplied.sessionId, invokeHandler, {
          inSession: supplied.mcpServer === 'in-session',
        });
      // Unidentified reads stay silent; identified and mutating calls are observed.
      const silent = !invocationContext.identity && capability.tier === 'observe';
      try {
        // Await both branches so the authentic invocation stays active for all admitted work.
        if (!onInvocation || silent) return await run();
        try {
          const result = await run();
          notify(onInvocation, capability, invocationContext, true);
          return result;
        } catch (err) {
          notify(onInvocation, capability, invocationContext, false, err);
          throw err;
        }
      } finally {
        if (mergeRecord && mergeHandle) {
          mergeRecord.active = false;
          originalRoomMergeContexts.delete(invocationContext);
          originalRoomMergeInvocations.delete(mergeHandle);
        }
      }
    },
    catalog() {
      if (!serializedCache) {
        // One entry that cannot be serialized is left out and logged rather
        // than throwing the whole catalog for everyone. `contribute` already
        // refuses an extension schema that cannot render; this is the second
        // wall, so no future entry can take discovery down either.
        const serialized = capabilities.flatMap((capability) => {
          try {
            return [serializeCapability(capability)];
          } catch (err) {
            deps.logger.error('[capabilities] a capability could not be serialized; left out', {
              capabilityId: capability.id,
              err: err instanceof Error ? err.message : String(err),
            });
            return [];
          }
        });
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

  originalRegistryInvocations.set(registry, registry.invoke);
  return Object.freeze(registry);
}

/** Dispatch through the exact original factory closure, retaining its parsing/tier/approval/audit gates. */
export function invokeOriginalCapabilityRegistry(
  registry: CapabilityRegistry,
  id: string,
  input: unknown,
  context: CapabilityInvocationContext
): Promise<unknown> {
  const invoke = originalRegistryInvocations.get(registry);
  if (!invoke) throw new Error('Original capability registry is unavailable.');
  return Reflect.apply(invoke, registry, [id, input, context]);
}
