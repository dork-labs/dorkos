/**
 * The self-description domain: one capability, `capabilities.list`, that returns
 * the live catalog of everything the registry exposes (spec `capability-registry`,
 * task 2.3), narrowed into a bounded page (filter, paginate, compact-by-default;
 * DOR-940) so a discovery call cannot overflow an agent's context.
 *
 * This domain is special: its capability reads the very registry it is composed
 * into. That self-reference is resolved with the late-binding dependency pattern —
 * the registry is written back onto the shared {@link CapabilityDeps} bag by
 * {@link composeDorkOsCapabilityRegistry} immediately after composition, before
 * any request is served. `catalog()` returns plain data (memoized by content
 * hash) and {@link projectCatalog} narrows it, so there is no recursion: composing
 * the registry never invokes a capability, and invoking `capabilities.list` only
 * reads already-serialized data.
 *
 * It lives OUTSIDE the registry spine (`services/core/capabilities/`) so that
 * spine stays domain-free (it imports no domain); this module, like the operator
 * and marketplace domains, migrates ONTO the spine.
 *
 * @module services/core/self-description/capabilities-domain
 */
import { defineCapability, type CapabilityDomain } from '../capabilities/index.js';
import type { CapabilityDeps } from '../capabilities/index.js';
import type { CapabilityRegistry } from '../capabilities/index.js';
import {
  listCapabilitiesInputSchema,
  listCapabilitiesResultSchema,
  projectCatalog,
} from './catalog-projection.js';

/**
 * Extend the shared dependency bag with the composed registry itself. Written
 * back by {@link composeDorkOsCapabilityRegistry} after composition (the
 * self-reference the catalog needs), so it is intentionally optional and asserted
 * at invoke time via {@link requireRegistry} rather than at compose time — the
 * registry does not exist yet while the bag is being captured.
 */
declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The composed registry, back-written after composition for self-description. */
    registry?: CapabilityRegistry;
  }
}

/**
 * Narrow the shared bag to the composed registry, throwing if `capabilities.list`
 * was invoked before the registry was back-written onto the bag (a wiring bug —
 * {@link composeDorkOsCapabilityRegistry} always sets it).
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The composed registry.
 */
function requireRegistry(deps: CapabilityDeps): CapabilityRegistry {
  if (!deps.registry) {
    throw new Error(
      'capabilities.list invoked without the registry back-written onto the deps bag.'
    );
  }
  return deps.registry;
}

/**
 * The tool families that are NOT on the capability registry, named in the
 * `list_capabilities` description so a model knows what the catalog omits.
 *
 * Exported, and written as the DOMAIN PREFIX a migrated capability id would carry
 * (`tasks.*`, not `task.*`), because the drift guard in
 * `__tests__/capabilities-domain.test.ts` asserts each entry is genuinely absent
 * from the composed registry. That is what makes the caveat self-retiring: migrate
 * one of these onto the registry and the guard fails, forcing the family out of
 * this list and out of the description rather than leaving a now-false sentence in
 * the highest-traffic model-facing text in the product.
 *
 * `agent` is deliberately NOT here. Agent *creation* is a hand-registered tool
 * (`create_agent`), but `operator.update_agent` and
 * `operator.agents_recent_activity` are real catalog entries with tiers, so
 * naming `agent` wholesale as absent would be its own overclaim.
 */
export const UNREGISTERED_TOOL_FAMILIES: readonly string[] = [
  'tasks',
  'relay',
  'mesh',
  'binding',
  'trace',
  'extension',
  'devtools',
  'ui',
];

/**
 * The self-description domain. A single `observe`-tier capability, advertised as
 * the `list_capabilities` tool on both MCP servers and — through its `http`
 * surface — the `GET /api/capabilities/catalog` route. Its `invoke` returns the
 * live catalog of the composed registry.
 *
 * ## The description says what the catalog covers, and what it does not
 *
 * The catalog covers exactly the capabilities composed onto the registry (operator,
 * marketplace, and this one). Roughly two dozen further DorkOS tools, the
 * {@link UNREGISTERED_TOOL_FAMILIES}, are still hand-registered on the MCP servers
 * and have no registry entry, so they are absent here. The earlier description told
 * the model this was "everything you can do" and to "call this first to discover
 * what actions and tools are available", which is a false premise an obedient model
 * reasons correctly from: it sees no task or relay entry and concludes it cannot
 * manage tasks or message another agent. The wording is therefore scoped to what
 * the catalog is (the by-id surface) and points at the tool list for the rest. The
 * honest fix ends when those domains migrate onto the registry, at which point the
 * catalog really is exhaustive and this caveat should be deleted, not reworded.
 *
 * ## Absent from the catalog is not the same as untiered (DOR-509)
 *
 * Until DOR-509 the caveat also said those tools "carry no permission tier". That
 * was true when it was written and stopped being true at DOR-468, which gave every
 * one of the 47 hand-registered tools a tier in `core/mcp-tool-tiers.ts` behind the
 * choke point in `core/mcp-tool-gate.ts`. Two of them are `destructive` and really
 * do stop for a person. The sentence therefore told every model that calls
 * `list_capabilities` that a whole half of the product runs unasked, which is the
 * premise an agent reasons from when it deletes something without warning anybody
 * first. The description now separates the two facts it was conflating: what the
 * CATALOG lists, and what carries a TIER. Keep them separate if you reword this.
 */
export const capabilitiesDomain: CapabilityDomain = {
  name: 'capabilities',
  capabilities: [
    defineCapability({
      id: 'capabilities.list',
      title: 'List capabilities',
      description:
        'List the DorkOS capabilities you can invoke by id: the live, versioned catalog of every ' +
        'entry on the capability registry, each with its id, title, description, permission tier ' +
        '(observe/act/destructive), input/output JSON Schema, and the surfaces (MCP tool, CLI verb, ' +
        "HTTP route) it projects onto. Run any of them with `dorkos call <id> [--input '<json>']`. " +
        'This is NOT the full list of DorkOS tools: the ' +
        UNREGISTERED_TOOL_FAMILIES.join(', ') +
        ' tools are registered directly on the MCP server, so they appear in your own tool list ' +
        'rather than in this catalog and cannot be reached by `dorkos call`. They carry a ' +
        'permission tier all the same and answer to the same approval gate, so a tool being ' +
        'absent here is not a tool that runs unasked: deleting a schedule and unregistering an ' +
        'agent are ' +
        'destructive and stop for a person. A destructive tool advertises an `approvalToken` ' +
        'argument, which is how you can tell one from its own schema. Call this to find out what ' +
        'is invocable by capability id and at what tier; look at your tool list for the rest. ' +
        'By default a call returns a compact entry per capability (id, title, tier, and a one line ' +
        'summary), bounded to a page, so discovery does not flood your context. Pass ' +
        "`detail:'full'` for the input and output JSON Schema, `domain` to keep one id prefix " +
        "(for example `domain:'mcp'`), `query` for a case insensitive substring over id, title, and " +
        'description, and `limit` with `cursor` to page. When a page is capped it says how many were ' +
        'left out and how to narrow.',
      tier: 'observe',
      input: listCapabilitiesInputSchema,
      output: listCapabilitiesResultSchema,
      surfaces: {
        mcp: {
          toolName: 'list_capabilities',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
        http: { method: 'get', path: '/api/capabilities/catalog' },
      },
      invoke: async (deps, input) => projectCatalog(requireRegistry(deps).catalog(), input),
    }),
  ],
};
