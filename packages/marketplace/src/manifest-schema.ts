/**
 * @dorkos/marketplace — Marketplace package manifest schema.
 *
 * Defines the canonical Zod schema for `.dork/manifest.json`, the source of
 * truth for a DorkOS marketplace package's identity, type, dependencies, and
 * metadata. The top-level schema is a discriminated union over `type` so that
 * type-specific fields (e.g. `adapterType` for adapters, `agentDefaults` for
 * agent templates) are validated in a single pass.
 *
 * This module is browser-safe — it imports only `zod`, `@dorkos/skills/schema`,
 * and the local `package-types` module, with no Node.js dependencies. It can
 * therefore be consumed by `apps/client` and `apps/site`.
 *
 * @module @dorkos/marketplace/manifest-schema
 */

import { z } from 'zod';
import { SkillNameSchema } from '@dorkos/skills/schema';
import { PackageTypeSchema } from './package-types.js';
import { MarketplaceCategorySchema } from './categories.js';

/**
 * Semver version string. Loose validation — full semver parsing is the
 * installer's responsibility.
 */
const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, 'Must be a valid semver string');

/**
 * A dependency declaration. Format: `<type>:<name>` or `<type>:<name>@<version>`.
 *
 * The `shape:` prefix lets a Shape compose another Shape (shape sets) with no
 * new mechanism — the same declaration grammar the other four types use.
 *
 * @example
 *   "adapter:slack"
 *   "adapter:slack@^1.0.0"
 *   "plugin:linear-integration"
 *   "shape:linear-ops@^1.0.0"
 */
const DependencyDeclarationSchema = z
  .string()
  .regex(
    /^(adapter|plugin|skill-pack|agent|shape):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$/,
    'Must be of the form <type>:<name> or <type>:<name>@<version>'
  );

/**
 * Layer declarations describe what kinds of content a package contains.
 * Used by the marketplace UI to filter and display package capabilities.
 */
const PackageLayerSchema = z.enum([
  'skills',
  'tasks',
  'commands',
  'hooks',
  'extensions',
  'adapters',
  'mcp-servers',
  'lsp-servers',
  'agents',
]);

/**
 * Common fields shared by all package types.
 */
const BasePackageManifestSchema = z.object({
  /** Schema version. Currently 1. */
  schemaVersion: z.literal(1).default(1),

  /** Package identifier. Kebab-case, must match the directory name. */
  name: SkillNameSchema,

  /** Semver version string. */
  version: SemverSchema,

  /** Package type — determines install flow and validation rules. */
  type: PackageTypeSchema,

  /** Short description shown in marketplace browse UI. 1-1024 chars. */
  description: z.string().min(1).max(1024),

  /** Optional human-readable display name. Falls back to humanized `name`. */
  displayName: z.string().max(128).optional(),

  /** Author name or organization. */
  author: z.string().max(256).optional(),

  /** SPDX license identifier or "UNLICENSED". */
  license: z.string().max(64).optional(),

  /** Repository URL (typically a git URL). */
  repository: z.string().url().optional(),

  /** Homepage URL. */
  homepage: z.string().url().optional(),

  /** Searchable tags. */
  tags: z.array(z.string().max(32)).max(20).default([]),

  /**
   * Primary category. Kept CC-interop and deliberately LENIENT (`z.string()`,
   * not the enum): installed packages' on-disk manifests may carry legacy
   * free-string categories, and the harness safeParses them
   * (`packages/harness/src/sources/installed.ts` `readPluginManifest` returns
   * `undefined` on a failed parse, which would make every legacy-categorized
   * installed package invisible to Harness projection — the DOR-264 regression
   * class). Coherence with the enum-typed `categories[0]` provides the
   * effective constraint for newly-authored packages.
   */
  category: z.string().max(64).optional(),

  /**
   * Controlled multi-membership categories (ADR-0236). Enum-constrained,
   * deduplicated, max 4. The first element is the primary category and must
   * equal the singular `category` when both are present (coherence refine
   * below). Rides the sidecar for CC-authored packages; carried inline here
   * in the DorkOS author source (`.dork/manifest.json`).
   */
  categories: z
    .array(MarketplaceCategorySchema)
    .max(4)
    .refine((c) => new Set(c).size === c.length, 'categories must be unique')
    .optional(),

  /** Icon emoji or icon identifier (e.g., "🔍" or "package"). */
  icon: z.string().max(64).optional(),

  /** Minimum DorkOS version required (semver). */
  minDorkosVersion: SemverSchema.optional(),

  /** Layers (content categories) this package contributes. Informational. */
  layers: z.array(PackageLayerSchema).default([]),

  /** Other packages this one depends on. */
  requires: z.array(DependencyDeclarationSchema).default([]),

  /** Whether to highlight in marketplace browse UI (registry sets this, not the package). */
  featured: z.boolean().optional(),
});

/**
 * Plugin-specific manifest fields.
 */
const PluginManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('plugin'),
  /** Optional list of extension IDs bundled in this package. */
  extensions: z.array(z.string()).default([]),
});

/**
 * Agent (template) -specific manifest fields.
 */
const AgentManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('agent'),
  /** Default agent identity values applied during creation. */
  agentDefaults: z
    .object({
      persona: z.string().max(4000).optional(),
      capabilities: z.array(z.string()).default([]),
      traits: z
        .object({
          verbosity: z.number().int().min(1).max(5).optional(),
          autonomy: z.number().int().min(1).max(5).optional(),
          chaos: z.number().int().min(1).max(5).optional(),
          creativity: z.number().int().min(1).max(5).optional(),
          humor: z.number().int().min(1).max(5).optional(),
          spice: z.number().int().min(1).max(5).optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Skill-pack-specific manifest fields. (Currently no extra fields beyond base.)
 */
const SkillPackManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('skill-pack'),
});

/**
 * Adapter-specific manifest fields.
 */
const AdapterManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('adapter'),
  /** Adapter type identifier (e.g., "discord", "slack"). */
  adapterType: z.string().min(1).max(64),
});

// === Shape sub-schemas (DOR-355) =========================================
//
// A Shape (the fifth package type) is a "place": it composes existing packages
// and extensions, arranges the workspace chrome, offers suggested agents, and
// stands up schedules + connections. The sub-schemas below are all browser-safe
// (zod + local siblings only) so `apps/client` and `apps/site` can consume them.

/** How strongly a Shape pulls an agent in. Never binding — see affinity-not-ownership. */
const ShapeAgentAffinitySchema = z.enum(['suggested', 'default']);

/**
 * A suggested agent for a Shape. Either references an agent the user may already
 * have (matched by `matchName`, case-insensitive) or ships a `template` to
 * scaffold on demand. Affinity is soft: at most one `default` per Shape is used
 * for the arrival offer; `suggested` agents are listed but never auto-created.
 */
const ShapeAgentSchema = z.object({
  /** Stable within-Shape slug, referenced by schedules' `agentRef`. Kebab-case. */
  ref: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Soft affinity. `default` is the arrival offer; `suggested` is listed only. */
  affinity: ShapeAgentAffinitySchema.default('suggested'),
  /**
   * Template to scaffold this agent if the user accepts the offer. Mirrors the
   * existing `AgentManifestSchema.agentDefaults` shape plus `skills` (projected
   * via Harness Sync). Omit when the Shape expects an agent the user already has,
   * matched by `matchName`.
   */
  template: z
    .object({
      displayName: z.string().max(100).optional(),
      persona: z.string().max(4000).optional(),
      runtime: z.enum(['claude-code', 'codex', 'opencode']).default('claude-code'),
      capabilities: z.array(z.string()).default([]),
      /** Skill ids the agent needs; delivered through Harness Sync, not embedded. */
      skills: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * If set, first try to satisfy this entry by an existing agent whose `name`
   * matches (case-insensitive) before offering to scaffold from `template`.
   */
  matchName: z.string().optional(),
});

/**
 * The permission modes a Shape schedule may run under.
 *
 * DRIFT NOTE: an inlined mirror of `PermissionModeSchema`
 * (`packages/shared/src/schemas.ts:27`) by value — `packages/marketplace`
 * (Zod 3, browser-safe) cannot import the Zod-4 `@dorkos/shared` schema, so the
 * six values are inlined here. Any change to `PermissionModeSchema` must be
 * reconciled here. Exported so a drift test asserts the two value sets stay
 * equal (task 1.1); the marketplace test imports `@dorkos/shared`'s
 * `PermissionModeSchema.options` and compares — a version-safe string-array
 * read, never a cross-version schema composition.
 */
export const SHAPE_SCHEDULE_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'auto',
] as const;

/**
 * A scheduled task the Shape stands up. Shape of `CreateTaskRequestSchema`
 * (`packages/shared/src/schemas.ts`) minus `target`, which is resolved from
 * `agentRef` at apply time.
 */
const ShapeScheduleSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  /** Cron expression; null = manual-only (created but never auto-fires). */
  cron: z.string().min(1).nullable().default(null),
  timezone: z.string().nullable().default(null),
  /** Which Shape agent (`ShapeAgentSchema.ref`) this schedule runs as. */
  agentRef: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Permission mode the schedule runs under. See {@link SHAPE_SCHEDULE_PERMISSION_MODES}. */
  permissionMode: z.enum(SHAPE_SCHEDULE_PERMISSION_MODES).default('acceptEdits'),
  /** Created disabled when true (or when its agent is missing at apply time). */
  startDisabled: z.boolean().default(false),
});

/**
 * A connection the Shape needs. Two kinds today (Assumption A4): an extension
 * secret to prompt for, or a raw MCP server the bundled agents should have. A
 * future `provider` kind targets the W5 connector gateway; unknown kinds degrade
 * to a warning rather than a hard failure at apply time.
 */
const ShapeConnectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('extension-secret'),
    /** Extension id that declares the secret (its `serverCapabilities.secrets`). */
    extension: z.string(),
    /** Secret key to prompt for (must match the extension's declared key). */
    secret: z.string(),
    required: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('mcp-server'),
    /** MCP server name the Shape's agents should be able to reach. */
    server: z.string(),
    /** Streamable-HTTP/SSE URL or a documented setup pointer. */
    url: z.string().optional(),
    required: z.boolean().default(false),
  }),
]);

/**
 * The workspace chrome a Shape restores. Composes existing UI primitives only.
 * Deliberately EXCLUDES the agent-list sidebar filing (groups/pinned) — that
 * filing is a cross-Shape personal preference (ADR 260717-001409) and a Shape
 * must never clobber it.
 */
const ShapeLayoutSchema = z.object({
  /** Sidebar open on arrival. */
  sidebarOpen: z.boolean().default(true),
  /**
   * Sidebar tab to select on arrival (mirrors `UiSidebarTabSchema`). The sidebar
   * tab strip now exists ONLY in the embedded (Obsidian) shell, where it carries
   * the four built-ins (`overview` | `sessions` | `schedules` | `connections`);
   * the web cockpit retired the strip, so a pinned tab is a no-op there. A pinned
   * id that isn't one of the built-ins falls back to the overview tab at apply
   * time. The `:` stays accepted so old manifests that pinned a namespaced
   * (extension) tab keep validating. Bounds keep manifest garbage out of the
   * client (keep in sync with `UiSidebarTabSchema` in `@dorkos/shared` and the
   * server's `LocalShapeLayoutSchema`).
   */
  sidebarTab: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, 'Not a valid sidebar tab id')
    .optional(),
  /** Panels to open on arrival (mirrors `UiPanelIdSchema` values). */
  openPanels: z.array(z.enum(['settings', 'tasks', 'relay', 'picker'])).default([]),
  /**
   * Extension dashboard-section contribution ids (`${extId}:${id}`) to order
   * first on the dashboard. Ordering hint only; unknown ids are ignored.
   */
  focusDashboardSections: z.array(z.string()).default([]),
});

/** Fork lineage — feeds the share loop's "forked from …" (P7). Absent on originals. */
const ShapeLineageSchema = z.object({
  /** `<name>@<source>` the Shape was forked from. */
  forkedFrom: z.string(),
  forkedFromVersion: SemverSchema.optional(),
  /** ISO-8601 timestamp. */
  forkedAt: z.string(),
});

/**
 * Shape-specific manifest fields (DOR-355). A plain `ZodObject` member of
 * {@link MarketplacePackageManifestSchema}: `packages/marketplace` pins Zod 3,
 * where a `z.discriminatedUnion` member MUST be a plain object — `.superRefine()`
 * returns a `ZodEffects` with no `.shape`, which cannot be a union member (the
 * codebase documents this same constraint at `packages/shared/src/schemas.ts` on
 * `OperationProgressEventShapeSchema`). The four cross-field rules therefore live
 * in {@link shapeCrossFieldChecks}, attached as a TOP-LEVEL `.superRefine` on the
 * union.
 *
 * **Validate through {@link MarketplacePackageManifestSchema}, never this member
 * alone** — parsing the bare member skips the cross-field rules by construction
 * (the same warning `OperationProgressEventShapeSchema` carries).
 */
const ShapeManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('shape'),
  /** Extension ids to enable when this Shape is applied (core, bundled, or from `requires`). */
  activates: z.array(z.string()).default([]),
  /** Extensions embedded inline in this Shape's package dir (like `PluginManifestSchema.extensions`). */
  extensions: z.array(z.string()).default([]),
  /** The workspace chrome restored on arrival. */
  layout: ShapeLayoutSchema.default({}),
  /** Suggested agents with soft affinity. At most one `default` is used for the arrival offer. */
  agents: z.array(ShapeAgentSchema).default([]),
  /** Schedules the Shape stands up, each bound to a Shape agent by `agentRef`. */
  schedules: z.array(ShapeScheduleSchema).default([]),
  /** Connections the Shape needs (extension secrets, MCP servers). */
  connections: z.array(ShapeConnectionSchema).default([]),
  /** Fork lineage; present only on forked Shapes. */
  lineage: ShapeLineageSchema.optional(),
});

/**
 * Validated shape package manifest variant. Narrow {@link MarketplacePackageManifest}
 * on `type === 'shape'` to reach these fields.
 */
export type ShapePackageManifest = z.infer<typeof ShapeManifestSchema>;

/**
 * Shape cross-field rules, exported standalone so the shape validator
 * (`dorkos package validate`, task 2.5) applies the SAME rules as the union.
 * Attached as a top-level `.superRefine` on {@link MarketplacePackageManifestSchema}
 * (narrowing on `type === 'shape'`), so every install-path parse
 * (`package-validator.ts` → `union.safeParse`) runs them. Each violation calls
 * `ctx.addIssue` with a precise `path` (e.g. `['schedules', i, 'agentRef']`) so
 * errors stay field-scoped.
 *
 * The four rules:
 * 1. Every `schedules[].agentRef` resolves to some `agents[].ref`.
 * 2. At most one `agents[]` entry has `affinity: 'default'`.
 * 3. Every `extension-secret` connection's `extension` is in `activates`/`extensions`.
 * 4. Every `agents[]` entry has a `template` or a `matchName` (else unsatisfiable).
 *
 * @param m - The parsed shape manifest to check.
 * @param ctx - Zod refinement context used to report field-scoped issues.
 */
export function shapeCrossFieldChecks(m: ShapePackageManifest, ctx: z.RefinementCtx): void {
  // 1) Every schedules[].agentRef must resolve to some agents[].ref.
  const agentRefs = new Set(m.agents.map((a) => a.ref));
  m.schedules.forEach((schedule, i) => {
    if (!agentRefs.has(schedule.agentRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedules', i, 'agentRef'],
        message: `Schedule '${schedule.name}' references agent '${schedule.agentRef}', which is not declared in agents[]`,
      });
    }
  });

  // 2) At most one agents[] entry may carry affinity 'default' (the arrival offer).
  const defaultAgentIndices = m.agents
    .map((agent, i) => (agent.affinity === 'default' ? i : -1))
    .filter((i) => i >= 0);
  if (defaultAgentIndices.length > 1) {
    // Flag every 'default' past the first so the error points at the surplus.
    for (const i of defaultAgentIndices.slice(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agents', i, 'affinity'],
        message: "At most one agent may have affinity 'default' (the arrival offer)",
      });
    }
  }

  // 3) Every extension-secret connection must target an extension the Shape
  //    turns on (in activates or bundled inline in extensions) — you cannot
  //    prompt for a secret of an extension the Shape never enables.
  const enabledExtensions = new Set([...m.activates, ...m.extensions]);
  m.connections.forEach((connection, i) => {
    if (connection.kind === 'extension-secret' && !enabledExtensions.has(connection.extension)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connections', i, 'extension'],
        message: `Connection secret targets extension '${connection.extension}', which is not in activates or extensions`,
      });
    }
  });

  // 4) Every agents[] entry needs a template or a matchName, else it is
  //    unsatisfiable (nothing to scaffold and nothing to match against).
  m.agents.forEach((agent, i) => {
    if (!agent.template && !agent.matchName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agents', i],
        message: `Agent '${agent.ref}' must declare a template or a matchName`,
      });
    }
  });
}

/**
 * Discriminated union over package type. Validates type-specific fields
 * based on the `type` discriminator.
 *
 * Two top-level cross-field effects wrap the union (Zod cannot `.refine` a
 * `discriminatedUnion` member and keep the discriminator, so both sit at the top
 * level, chained):
 *
 * 1. The primary-category coherence refine (`category === categories[0]` when
 *    both are present).
 * 2. The shape cross-field rules ({@link shapeCrossFieldChecks}), applied only to
 *    `type === 'shape'` manifests.
 *
 * The inferred {@link MarketplacePackageManifest} type is unaffected — chained
 * refinement effects on a discriminated union preserve the union, so consumers
 * still narrow on `manifest.type`. Because `categories[0]` is enum-typed,
 * coherent manifests are effectively enum-constrained on their primary category,
 * while legacy singular-only manifests (no `categories`) still parse (the
 * singular field stays lenient).
 */
export const MarketplacePackageManifestSchema = z
  .discriminatedUnion('type', [
    PluginManifestSchema,
    AgentManifestSchema,
    SkillPackManifestSchema,
    AdapterManifestSchema,
    ShapeManifestSchema, // plain ZodObject — Zod 3 union-member constraint
  ])
  .refine((m) => !(m.category && m.categories?.length) || m.category === m.categories[0], {
    message: 'category must equal categories[0] when both are present',
    path: ['category'],
  })
  .superRefine((m, ctx) => {
    if (m.type === 'shape') shapeCrossFieldChecks(m, ctx);
  });

/**
 * The package `name` field schema (kebab-case slug, 1-64 chars), exported for
 * consumers that must validate a package name outside a full manifest parse —
 * e.g. the harness scanner's `.claude-plugin/plugin.json` fallback, where the
 * name is interpolated into filesystem paths and must never be an arbitrary
 * string.
 */
export const PackageNameSchema = SkillNameSchema;

/**
 * Validated marketplace package manifest. Discriminated union — narrow on
 * `manifest.type` to access type-specific fields.
 */
export type MarketplacePackageManifest = z.infer<typeof MarketplacePackageManifestSchema>;

/**
 * Validated plugin package manifest variant.
 */
export type PluginPackageManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Validated agent package manifest variant.
 */
export type AgentPackageManifest = z.infer<typeof AgentManifestSchema>;

/**
 * Validated skill-pack package manifest variant.
 */
export type SkillPackPackageManifest = z.infer<typeof SkillPackManifestSchema>;

/**
 * Validated adapter package manifest variant.
 */
export type AdapterPackageManifest = z.infer<typeof AdapterManifestSchema>;
