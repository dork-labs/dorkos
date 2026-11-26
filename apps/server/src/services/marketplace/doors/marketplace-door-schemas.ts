/**
 * What the marketplace's reads on `/api/marketplace/*` answer (DOR-4978): the
 * output schemas their capabilities declare, and the ones the hand routes
 * still documented in `openapi-registry.ts` share.
 *
 * `@dorkos/shared/marketplace-schemas` is interfaces-only by design, so each
 * schema here mirrors its interface for the document. Nothing parses a
 * response with them.
 *
 * @module services/marketplace/doors/marketplace-door-schemas
 */
import { z } from 'zod';
import { PackageTypeSchema } from '@dorkos/marketplace';

import { DisclosedEffectsSchema } from '../preview/disclosed-effects.js';

/** One configured marketplace source. */
export const MarketplaceSourceSchema = z.object({
  name: z.string(),
  source: z.string(),
  enabled: z.boolean(),
  addedAt: z.string(),
});

/**
 * How the most recent fetch of a source's listing went (DOR-2324). Mirrors
 * `SourceLastFetch`.
 */
export const SourceLastFetchSchema = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('never') }),
    z.object({
      state: z.literal('fetched'),
      checkedAt: z.string(),
      packageCount: z.number().int().nonnegative(),
    }),
    z.object({ state: z.literal('failed'), checkedAt: z.string(), reason: z.string() }),
    z.object({
      state: z.literal('stale'),
      checkedAt: z.string(),
      reason: z.string(),
      copyFetchedAt: z.string(),
      packageCount: z.number().int().nonnegative(),
    }),
  ])
  .describe(
    'How the most recent attempt to fetch the listing went, from adding, refreshing, browsing ' +
      'or an update check. `stale`: it failed and an older copy, fetched at `copyFetchedAt`, ' +
      'is still listed. `failed`: it failed with no copy. Kept by the server, so it survives ' +
      'a reload.'
  );

/** Where an installation sits. */
const PackageScopeSchema = z.enum(['global', 'agent-local', 'override']);

/**
 * One installation, as `GET /api/marketplace/installed` lists it. One entry PER
 * INSTALLATION: a package installed globally and on two agents yields three,
 * each with its scope and, for an agent's, the agent. No `provides`: only the
 * single-package read counts those.
 */
export const InstalledPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: PackageTypeSchema,
  installPath: z.string(),
  installedFrom: z.string().optional(),
  installedAt: z.string().optional(),
  scope: PackageScopeSchema.optional(),
  agentPath: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  linked: z
    .literal(true)
    .optional()
    .describe(
      "Present only when the install folder is a symbolic link to a developer's working copy, which is never updated in place."
    ),
  heldBack: z
    .object({
      reason: z.enum(['unasked', 'refused', 'unrecorded', 'unreadable', 'unreadable-config']),
      note: z.string(),
      reviewable: z.boolean(),
      linkedPath: z.string().optional(),
    })
    .optional()
    .describe(
      'Present only on a global installation held back from every session until a person approves the install that put it there (DOR-2306). `linkedPath` marks a linked install, whose approval covers whatever is in that folder; an agent reads it without the folder.'
    ),
  devLink: z
    .object({
      path: z
        .string()
        .optional()
        .describe('The working folder it runs from. An agent reads it without this.'),
      state: z.enum(['active', 'folder-missing', 'link-missing', 'link-replaced']),
      parked: z.boolean(),
    })
    .optional()
    .describe('Present only on an installation a dev link replaces.'),
  integrity: z
    .union([
      z.object({
        status: z.literal('clean'),
        customized: z.array(z.string()),
        truncated: z.literal(true).optional(),
      }),
      z.object({
        status: z.literal('modified'),
        changed: z.array(z.string()),
        missing: z.array(z.string()),
        added: z.array(z.string()),
        customized: z.array(z.string()),
        truncated: z.literal(true).optional(),
      }),
      z.object({
        status: z.literal('unknown'),
        reason: z.enum(['no-record', 'unreadable-record', 'linked']),
      }),
    ])
    .optional()
    .describe(
      'Present only with verify=true: whether the installed files still match what was installed (DOR-2197).'
    ),
});

/** One installation as `GET /api/marketplace/installed/{name}` answers it: with what it provides. */
export const InstalledPackageDetailSchema = InstalledPackageSchema.extend({
  provides: z
    .object({
      commands: z.number().int().nonnegative(),
      skills: z.number().int().nonnegative(),
      hooks: z.boolean(),
    })
    .optional(),
  dependencyWarnings: z.array(z.string()).optional(),
});

/** The package cache's counts and size, and whether its cleanup is paused. */
export const MarketplaceCacheStatusSchema = z.object({
  marketplaces: z.number().int().nonnegative(),
  packages: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  cleanup: z
    .object({
      paused: z.boolean(),
      reason: z.string().nullable(),
      since: z.string().nullable(),
    })
    .describe(
      'Automatic cleanup of cached packages. Paused while the server cannot read every install, in which case nothing is removed; `reason` says what it could not read.'
    ),
});

/** One package a marketplace lists, tagged with the marketplace. Mirrors `AggregatedPackage`. */
export const AggregatedPackageSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  source: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  type: PackageTypeSchema.optional(),
  adapterType: z.string().optional(),
  category: z.string().optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  icon: z.string().optional(),
  featured: z.boolean().optional(),
  installCount: z.number().optional(),
  updatedAt: z.string().optional(),
  marketplace: z.string(),
});

/** A package's manifest, the fields the API shows. Mirrors `MarketplacePackageManifest`. */
export const MarketplacePackageManifestSchema = z.object({
  schemaVersion: z.number(),
  name: z.string(),
  version: z.string(),
  type: PackageTypeSchema,
  description: z.string().optional(),
});

/** What an install did. Mirrors `InstallResult`. */
export const InstallResultSchema = z.object({
  ok: z.boolean(),
  packageName: z.string(),
  version: z.string(),
  type: PackageTypeSchema,
  installPath: z.string(),
  manifest: MarketplacePackageManifestSchema,
  warnings: z.array(z.string()),
  dependencyWarnings: z.array(z.string()).optional(),
});

/** One package's advisory update check. Mirrors `UpdateCheckResult`. */
export const UpdateCheckResultSchema = z.object({
  packageName: z.string(),
  installedVersion: z.string(),
  latestVersion: z.string(),
  hasUpdate: z.boolean(),
  marketplace: z.string(),
  status: z.enum(['current', 'update-available', 'unknown']),
  installedVersionSource: z.enum(['package', 'index', 'commit']).optional(),
  latestVersionSource: z.enum(['package', 'index', 'commit']).optional(),
  note: z.string().optional(),
});

/**
 * One installation's check, its identity in the installed list's own field
 * names, and after an apply, its outcome. Mirrors `InstallationUpdateCheck`.
 */
const InstallationUpdateCheckSchema = UpdateCheckResultSchema.extend({
  installPath: z.string(),
  type: PackageTypeSchema,
  scope: PackageScopeSchema,
  agentPath: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  linked: z
    .literal(true)
    .optional()
    .describe(
      "Present only for an install linked to a developer's working copy: always unknown, never reinstalled."
    ),
  applied: InstallResultSchema.optional(),
  applyError: z.string().optional(),
  disclosed: DisclosedEffectsSchema.nullable()
    .optional()
    .describe(
      'On every update-available check: what the new version runs on its own. An apply sends it back untouched.'
    ),
  contentHash: z
    .string()
    .optional()
    .describe("The new version's staged files, hashed. An apply sends it back untouched."),
  installedDisclosed: DisclosedEffectsSchema.nullable()
    .optional()
    .describe('What the installed version runs now; null when it could not be read.'),
});

/** One check per installation in view. Mirrors `InstallationUpdatesResult`. */
export const InstallationUpdatesResultSchema = z.object({
  checks: z.array(InstallationUpdateCheckSchema),
});

/** A global package held back from every session, and why. Mirrors `HeldBackPackage`. */
export const HeldBackPackageSchema = z.object({
  name: z.string(),
  reason: z.enum(['unasked', 'refused', 'unrecorded', 'unreadable', 'unreadable-config']),
  note: z.string(),
  reviewable: z.boolean(),
  linkedPath: z.string().optional().describe('A linked install’s folder; never sent to an agent.'),
  version: z.string().optional(),
  source: z.string().optional(),
  changedSinceApproval: z.boolean(),
  effects: DisclosedEffectsSchema.optional(),
  bindsTo: z.string().optional(),
});

/** One dev link and whether it is in force. Mirrors `DevLinkStatus`. */
export const DevLinkStatusSchema = z.object({
  name: z.string(),
  type: z.enum(['plugin', 'skill-pack']),
  scope: z.enum(['global', 'project']),
  projectPath: z.string().optional(),
  path: z.string().describe('The real path of the folder the package runs from.'),
  state: z.enum(['active', 'folder-missing', 'link-missing', 'link-replaced']),
  parked: z
    .object({ version: z.string().optional() })
    .nullable()
    .describe('The installed copy set aside for the link, or null.'),
  linkedAt: z.string(),
  lastReloadAt: z.string().optional(),
});
