/**
 * The marketplace domain's capabilities (migrated onto the Capability Registry
 * in spec `capability-registry`, task 2.2).
 *
 * This module replaces `marketplace-tool-descriptors.ts`: every entry becomes a
 * {@link CapabilityDefinition} preserving the tool name, model-facing
 * description, Zod input schema, and MCP annotation semantics. The transport-
 * neutral handlers in the sibling `tool-*.ts` files are unchanged — each
 * capability's `invoke` calls one and {@link unwrapMcpEnvelope}s its MCP text
 * envelope down to the plain payload the registry contract requires (the two
 * MCP adapters re-wrap it).
 *
 * The confirmation-token trust boundary for the mutation capabilities
 * (`marketplace.install`, `marketplace.update`, `marketplace.uninstall`,
 * `marketplace.create_package`) is preserved exactly: the approval state machine
 * lives inside the handler on `deps.confirmationProvider`. The five read-only
 * lookups carry `readOnlyCarveOut: true`; the four mutations do not.
 *
 * ## Cooperating with the tier gate
 *
 * Since spec `agent-trust` §3.2 the mutation handlers also receive the invocation
 * context, which carries two things they cannot work out for themselves: WHO asked
 * (so the approval card names the agent) and whether a person has ALREADY approved
 * this exact call at the choke point. Without the second, `marketplace.uninstall`
 * — the one `destructive` capability here — would show an operator two cards for
 * one uninstall: the tier gate's, then its own.
 *
 * @module services/marketplace-mcp/marketplace-capabilities
 */
import { z } from 'zod';

import {
  AREA_PENDING_PHASE_3,
  defineCapability,
  type CapabilityDomain,
} from '../core/capabilities/index.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../core/capabilities/index.js';
import { unwrapMcpEnvelope } from '../core/capabilities/mcp-envelope.js';
import type { MarketplaceConfirmationContext } from './confirmation-provider.js';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import { createSearchHandler, SearchInputSchema } from './tool-search.js';
import { createGetHandler, GetInputSchema } from './tool-get.js';
import { createListMarketplacesHandler } from './tool-list-marketplaces.js';
import { createListInstalledHandler, ListInstalledInputSchema } from './tool-list-installed.js';
import { createRecommendHandler, RecommendInputSchema } from './tool-recommend.js';
import { createInstallHandler, InstallInputSchema } from './tool-install.js';
import { createUpdateHandler, UpdateInputSchema } from './tool-update.js';
import { createUninstallHandler, UninstallInputSchema } from './tool-uninstall.js';
import { createCreatePackageHandler, CreatePackageInputSchema } from './tool-create-package.js';

/**
 * Extend the shared dependency bag with the marketplace domain's service
 * bundle. Optional so a registry composed from other domains alone need not
 * supply it; every marketplace `invoke` asserts its presence via
 * {@link requireMarketplaceDeps}.
 */
declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Marketplace service bundle consumed by the marketplace capabilities. */
    marketplaceDeps?: MarketplaceMcpDeps;
  }
}

/**
 * Narrow the shared bag to the marketplace service bundle, throwing if a
 * registry that owns marketplace capabilities was composed without it (a wiring
 * bug).
 *
 * @param deps - The registry's shared dependency bag.
 * @returns The marketplace service bundle.
 */
function requireMarketplaceDeps(deps: CapabilityDeps): MarketplaceMcpDeps {
  if (!deps.marketplaceDeps) {
    throw new Error('Marketplace capability invoked without marketplaceDeps in the registry bag.');
  }
  return deps.marketplaceDeps;
}

/**
 * Translate a capability invocation context into what a marketplace handler needs
 * from it: who asked, and whether the tier gate already got a person's yes for
 * this exact call.
 *
 * @param context - The context the registry handed this handler.
 * @returns The handler-facing caller context.
 */
function callerContext(context: CapabilityHandlerContext): MarketplaceConfirmationContext {
  const requestedBy = context.identity
    ? context.identity.displayName || context.identity.agentPath
    : undefined;
  return {
    ...(requestedBy ? { requestedBy } : {}),
    // Two different proofs that this person has already said yes to this exact
    // call, and the handler must not ask again for either: an approval the tier
    // gate spent, or a caller that proved it may DECIDE approvals — for whom the
    // confirmation this flow would go and fetch is its own.
    ...(context.approval || context.trusted ? { preApproved: true } : {}),
  };
}

/**
 * The marketplace domain: read-only lookups first, then the four
 * confirmation-gated mutations. This is the registration order on both MCP
 * servers.
 */
export const marketplaceDomain: CapabilityDomain = {
  name: 'marketplace',
  assertDeps: requireMarketplaceDeps,
  capabilities: [
    // ── Read-only lookups ───────────────────────────────────────────────────
    defineCapability({
      id: 'marketplace.search',
      title: 'Search marketplace',
      description:
        'Search the DorkOS marketplace for installable packages (agents, plugins, skill packs, adapters). ' +
        'Returns matching entries from every enabled marketplace source. ' +
        'Filters: type (agent/plugin/skill-pack/adapter), category, tags, marketplace, query (free-text).',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object(SearchInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_search',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(await createSearchHandler(requireMarketplaceDeps(deps))(input)),
    }),
    defineCapability({
      id: 'marketplace.get',
      title: 'Get marketplace package',
      description:
        'Get full details for a marketplace package by name. Returns the package manifest, README, marketplace metadata, and any DorkOS-specific fields (type, category, tags).',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object(GetInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_get',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(await createGetHandler(requireMarketplaceDeps(deps))(input)),
    }),
    defineCapability({
      id: 'marketplace.list_marketplaces',
      title: 'List marketplace sources',
      description:
        'List configured marketplace sources. Each source includes name, source URL/path, enabled flag, and total package count.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({}),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_list_marketplaces',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps) =>
        unwrapMcpEnvelope(await createListMarketplacesHandler(requireMarketplaceDeps(deps))()),
    }),
    defineCapability({
      id: 'marketplace.list_installed',
      title: 'List installed packages',
      description:
        'List packages currently installed in this DorkOS instance, one entry per installation across scopes. ' +
        'A package installed globally and on two agents returns three entries, each tagged with scope ' +
        '(global | agent-local | override) and, for agent installs, the owning agent id and name. ' +
        'Filter by type (agent/plugin/skill-pack/adapter). Includes install path, version, and provenance. ' +
        'Pass checkUpdates:true to also get, per entry, update.status (update-available | current | unknown), ' +
        "update.latestVersion and a note. That checks each package's marketplace, so it is slower; " +
        'without it nothing is fetched.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object(ListInstalledInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_list_installed',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          // `checkUpdates` reads each package's (possibly remote) marketplace.
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(await createListInstalledHandler(requireMarketplaceDeps(deps))(input)),
    }),
    defineCapability({
      id: 'marketplace.recommend',
      title: 'Recommend packages',
      description:
        'Recommend marketplace packages based on a context description (e.g., "I need to track errors in my Next.js app"). Uses keyword + tag matching. Returns top matches with relevance scores and reasons.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object(RecommendInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_recommend',
          servers: ['in-session', 'external'],
          readOnlyCarveOut: true,
          annotations: { idempotentHint: true, openWorldHint: true },
        },
      },
      invoke: async (deps, input) =>
        unwrapMcpEnvelope(await createRecommendHandler(requireMarketplaceDeps(deps))(input)),
    }),

    // ── Mutations (gated by the confirmation provider) ──────────────────────
    defineCapability({
      id: 'marketplace.install',
      title: 'Install package',
      description:
        'Install a package from a configured marketplace. Requires user confirmation. ' +
        'For external AI agents: the first call returns status:requires_confirmation with a token. ' +
        'After the user approves in DorkOS, re-call with confirmationToken to complete the install.',
      tier: 'act',
      area: null,
      areaNote: AREA_PENDING_PHASE_3,
      input: z.object(InstallInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_install',
          servers: ['in-session', 'external'],
          // Fetches the package from its configured (possibly remote) source.
          annotations: { openWorldHint: true },
        },
      },
      invoke: async (deps, input, context) =>
        unwrapMcpEnvelope(
          await createInstallHandler(requireMarketplaceDeps(deps))(input, callerContext(context))
        ),
    }),
    defineCapability({
      id: 'marketplace.update',
      title: 'Update packages',
      description:
        'Check installed marketplace packages for newer versions, and install them. ' +
        'By default it only checks: one entry per installation, with status (update-available | current | unknown), ' +
        'installedVersion, latestVersion, a note saying why when it could not tell, and where it is installed ' +
        '(installPath, scope, agentPath). Nothing changes. ' +
        'Narrow it with names (every copy of those packages) and/or installPaths (exact copies, as a check reported them). ' +
        'Pass apply:true to reinstall every selected package that has a newer version, each where it is installed. ' +
        'Requires user confirmation: the first apply call checks, then returns status:requires_confirmation with a token ' +
        'and the updates it would make (versions, and every command, scheduled job, server, monitor and skill tool the new versions bring). ' +
        'After the user approves in DorkOS, re-call with the same arguments plus confirmationToken. If a new version changed ' +
        'in between, it asks again. Too many updates for one approval are refused: apply fewer, by installPaths. ' +
        'A linked (symlinked) install is never reinstalled.',
      tier: 'act',
      // Same area as install: an applied update is an install of a new version.
      area: null,
      areaNote: AREA_PENDING_PHASE_3,
      input: z.object(UpdateInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_update',
          servers: ['in-session', 'external'],
          // Reads each package's (possibly remote) marketplace, and fetches it on apply.
          annotations: { openWorldHint: true },
        },
      },
      invoke: async (deps, input, context) =>
        unwrapMcpEnvelope(
          await createUpdateHandler(requireMarketplaceDeps(deps))(input, callerContext(context))
        ),
    }),
    defineCapability({
      id: 'marketplace.uninstall',
      title: 'Uninstall package',
      description:
        'Uninstall a previously installed marketplace package. Requires user confirmation. ' +
        'By default, keeps the files you and your agents added or changed; purge:true removes them. ' +
        'Uninstalling an agent package removes the agent from the team (rooms, schedules, sign-ins, access), ' +
        'and reinstalling does not restore that.',
      tier: 'destructive',
      area: null,
      areaNote: AREA_PENDING_PHASE_3,
      input: z.object(UninstallInputSchema),
      output: z.unknown(),
      // What a person needs to decide, and nothing else. `confirmationToken` is a
      // field of this schema, so without this allowlist the card — and the
      // agent-readable pending list, and the SSE broadcast — echoed whatever token
      // a model put there.
      approvalDisplayFields: ['name', 'purge', 'projectPath'],
      surfaces: {
        mcp: {
          toolName: 'marketplace_uninstall',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: async (deps, input, context) =>
        unwrapMcpEnvelope(
          await createUninstallHandler(requireMarketplaceDeps(deps))(input, callerContext(context))
        ),
    }),
    defineCapability({
      id: 'marketplace.create_package',
      title: 'Create package',
      description:
        "Scaffold a new package in the user's personal marketplace. Creates files on disk under " +
        '~/.dork/personal-marketplace/packages/<name>/ and registers the package in personal marketplace.json. ' +
        'Requires user confirmation. Publishing to a public marketplace is a separate step.',
      tier: 'act',
      area: null,
      areaNote: AREA_PENDING_PHASE_3,
      input: z.object(CreatePackageInputSchema),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'marketplace_create_package',
          servers: ['in-session', 'external'],
        },
      },
      invoke: async (deps, input, context) =>
        unwrapMcpEnvelope(
          await createCreatePackageHandler(requireMarketplaceDeps(deps))(
            input,
            callerContext(context)
          )
        ),
    }),
  ],
};
