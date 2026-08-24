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
 * `@dorkos/skills/task-schema` (itself zod-only), and the local `package-types`
 * module, with no Node.js dependencies. It can therefore be consumed by
 * `apps/client` and `apps/site`.
 *
 * @module @dorkos/marketplace/manifest-schema
 */

import { z } from 'zod';
import { SkillNameSchema } from '@dorkos/skills/schema';
import { TASK_PERMISSION_MODES } from '@dorkos/skills/task-schema';
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

// === The shared schedules slot ===========================================
//
// A package that ships recurring work declares it here, and the install (or, for
// a Shape, the apply) turns each declaration into a real scheduled task. The
// slot started life shape-only (DOR-355) and opened to every type that can carry
// an agent's work in DOR-1487 (spec `universal-scheduled-tasks` §6): being
// scheduled is a property of a skill file, not of the package type that shipped
// it, so a plugin or skill-pack has as much business declaring one as a Shape.

/**
 * The permission modes a package-declared schedule may run under.
 *
 * This is `TASK_PERMISSION_MODES` from `@dorkos/skills/task-schema`, not a
 * second copy of it. A schedule declaration becomes a skill file whose
 * `schedule.permissions` frontmatter carries this value, so the two sets have to
 * be the same set: when the manifest allowed a mode the frontmatter did not,
 * apply-time wrote a file its own parser rejected, and disk and DB disagreed
 * from then on (DOR-607). Both packages are on zod v3, so this is a plain
 * re-export; the zod-version mirror of `@dorkos/shared`'s `PermissionModeSchema`
 * now lives in one place, with the drift test beside it in `@dorkos/skills`.
 *
 * Declaring a mode here is not the same as getting it. `bypassPermissions` is
 * clamped when the schedule is materialized — a package cannot decide that its
 * own unattended cron runs with every approval prompt turned off.
 */
export const SCHEDULE_PERMISSION_MODES = TASK_PERMISSION_MODES;

/**
 * One scheduled task a package declares.
 *
 * An entry says what to run and how often, in one of two ways:
 *
 * - **By reference** — `skillRef` names a skill the package already ships. The
 *   installed copy of that skill gets a `schedule:` block written into its
 *   frontmatter, so the file a person can read and the schedule that fires it
 *   are one file. Nothing else is generated. `description` and `prompt` come
 *   from the skill itself, so declaring them here would only be a second place
 *   for them to disagree — they are rejected on a `skillRef` entry.
 * - **Inline** — `name` + `description` + `prompt` describe work the package
 *   does not otherwise ship as a skill. Installing generates a new skill
 *   directory for it, stamped with the package's provenance.
 *
 * Exactly one of the two forms per entry; {@link scheduleDeclChecks} enforces
 * that, because zod cannot express "these three together, or that one instead"
 * without turning the array element into a union that reports both branches'
 * errors on every mistake.
 *
 * **Nothing here arms anything.** A materialized schedule is a file, and a file
 * is nobody's approval: a file-discovered schedule parks for a person to approve
 * before it can ever fire, `startEnabled: true` or not (spec §3, never-auto-arm).
 * `startEnabled` travels into the file as `schedule.enabled` — the author's
 * stated intent, which is what the approval is *for*.
 */
const BaseScheduleDeclSchema = z.object({
  /**
   * Name of a skill this package ships, which this schedule runs. The skill must
   * exist in the package (checked when the schedule is materialized) — a
   * reference to a skill that was never shipped is a schedule that can never
   * run.
   */
  skillRef: SkillNameSchema.optional(),

  /** Schedule name. Required on an inline entry; a `skillRef` entry is named by its skill. */
  name: z.string().min(1).optional(),

  /** What this schedule does, in one line. Required on an inline entry. */
  description: z.string().min(1).optional(),

  /** What to send when the schedule fires. Required on an inline entry. */
  prompt: z.string().min(1).optional(),

  /**
   * Cron expression; null = manual-only (created but never auto-fires).
   *
   * Checked for being a non-empty string here and for *meaning something* at
   * install time, where croner lives (`services/marketplace/lib/validate-package-schedules.ts`).
   * This module is browser-safe and stays that way.
   */
  cron: z.string().min(1).nullable().default(null),

  /** IANA timezone the cron is read in. Null = the schedule's own default (UTC). */
  timezone: z.string().nullable().default(null),

  /**
   * Permission mode the schedule ASKS to run under. See
   * {@link SCHEDULE_PERMISSION_MODES} — `bypassPermissions` is clamped when the
   * schedule is materialized and the operator is told, so declaring it is a
   * request, not a grant.
   */
  permissionMode: z.enum(SCHEDULE_PERMISSION_MODES).default('acceptEdits'),

  /**
   * The author's stated intent: whether this schedule should be running.
   * Defaults to `false` — a package does not get to arm its own cron job, so a
   * manifest that wants one running on arrival has to say so in the file.
   *
   * `true` is still only a request. It becomes `schedule.enabled: true` in the
   * generated file, which a person then approves before anything fires.
   */
  startEnabled: z.boolean().default(false),

  /**
   * RETIRED (DOR-607), and declared here for exactly one reason: so install/apply
   * time can SEE that a manifest still carries it and tell the author.
   *
   * This is not a back-compat shim. Nothing reads its value, and it can never
   * change what a schedule does — `startEnabled` alone decides that, and a
   * manifest carrying only the old key gets the safe answer (off). Without this
   * declaration zod would strip the key, and the author of a package written
   * against the old schema would get a timer that quietly never fires with no
   * signal why. Silently ignored is the opposite of the loudness the rename was
   * chosen for.
   *
   * Remove once no package in the wild still declares it.
   */
  startDisabled: z.boolean().optional(),
});

/**
 * A schedule declared by a `plugin`, `agent`, or `skill-pack` package.
 *
 * **There is no `agentRef`.** That field names an agent slug a *Shape* declares
 * in its own `agents[]`, and no other package type has such a list to point at.
 * These schedules bind by LOCATION instead, which is the same thing the
 * scheduler's own discovery uses: a project-scoped install materializes into
 * `<projectPath>/.agents/skills/`, where the schedule belongs to that project's
 * agent; a global install materializes into `<dorkHome>/skills/`, where it is
 * global. The install already knows which one it is doing, so the manifest does
 * not have to guess, and there is no way for it to name an agent the installing
 * person never agreed to.
 */
export const PackageScheduleSchema = BaseScheduleDeclSchema;

/**
 * A schedule declared by any package type — narrow on the presence of
 * `skillRef` to tell the two forms apart.
 */
export type PackageScheduleDecl = z.infer<typeof PackageScheduleSchema>;

/**
 * The one rule that decides a schedule declaration is well-formed: exactly one
 * of the two declaration forms, with nothing borrowed from the other.
 *
 * Exported and shared rather than inlined per package type, because a plugin's
 * schedule and a Shape's schedule are the same kind of thing and an author who
 * moves a declaration between manifests must not meet a different rule on the
 * other side.
 *
 * @param schedules - The manifest's `schedules[]` entries.
 * @param ctx - Zod refinement context used to report field-scoped issues.
 * @param opts - `allowSkillRef: false` rejects the by-reference form outright
 *   (Shapes; see {@link ShapeScheduleSchema}).
 */
export function scheduleDeclChecks(
  schedules: readonly PackageScheduleDecl[],
  ctx: z.RefinementCtx,
  opts: { allowSkillRef: boolean } = { allowSkillRef: true }
): void {
  schedules.forEach((schedule, i) => {
    const label = schedule.skillRef ?? schedule.name ?? `#${i + 1}`;

    if (schedule.skillRef && !opts.allowSkillRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedules', i, 'skillRef'],
        message:
          `Schedule '${label}' uses 'skillRef', which a Shape cannot: a Shape stands its ` +
          `schedules up for an agent it names in agents[], from a prompt written here. To ` +
          `schedule a skill, ship it in a plugin or skill-pack and declare the schedule there.`,
      });
      return;
    }

    if (schedule.skillRef) {
      // A by-reference entry takes its description and prompt from the skill.
      // Accepting them here too would create a second place for the same two
      // strings to live, and the file would win — so say so instead of picking.
      for (const field of ['description', 'prompt'] as const) {
        if (schedule[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['schedules', i, field],
            message:
              `Schedule '${label}' sets both 'skillRef' and '${field}'. A skillRef schedule ` +
              `takes its ${field} from the skill it names; remove this one.`,
          });
        }
      }
      return;
    }

    // Inline: the three fields that describe the work are all required, because
    // there is no file to read them out of.
    for (const field of ['name', 'description', 'prompt'] as const) {
      if (schedule[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedules', i, field],
          message:
            `Schedule '${label}' must declare '${field}', or name a skill this package ships ` +
            `with 'skillRef'.`,
        });
      }
    }
  });
}

/**
 * Plugin-specific manifest fields.
 */
const PluginManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('plugin'),
  /** Optional list of extension IDs bundled in this package. */
  extensions: z.array(z.string()).default([]),
  /** Scheduled tasks this plugin stands up when it is installed. */
  schedules: z.array(PackageScheduleSchema).default([]),
});

/**
 * Agent (template) -specific manifest fields.
 */
const AgentManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('agent'),
  /** Scheduled tasks this agent template stands up when it is installed. */
  schedules: z.array(PackageScheduleSchema).default([]),
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
 * Skill-pack-specific manifest fields.
 */
const SkillPackManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('skill-pack'),
  /**
   * Scheduled tasks this pack stands up when it is installed. The type most
   * likely to use the `skillRef` form: a pack ships the skills, and a schedule
   * says which of them runs on a clock.
   */
  schedules: z.array(PackageScheduleSchema).default([]),
});

/**
 * The `adapterType` value that marks an adapter package as a **connector** — a
 * `ConnectorProvider` backend (Composio managed, Nango self-host, a raw-MCP
 * baseline) that connects an agent to real third-party services and acts for the
 * user (connector-gateway spec §Detailed Design 6).
 *
 * `adapterType` stays a free-form string (relay adapters use their service slug,
 * e.g. `'slack'`); this is a well-known value on that same axis, not a new
 * discriminator — no `PackageTypeSchema` migration. A connector package sets
 * `type: 'adapter'` + `adapterType: 'connector'`; connecting an account is a
 * runtime step (`startConnect`), never an install step, so install behavior does
 * not diverge from any other adapter. Depend on one with
 * `adapter:connector-composio@^1.0.0` via the existing dependency grammar.
 */
export const CONNECTOR_ADAPTER_TYPE = 'connector';

/**
 * Adapter-specific manifest fields.
 *
 * **Deliberately no `schedules` slot**, and the omission is the decision rather
 * than an oversight. An adapter is a transport: it hands a relay service or a
 * connector gateway to whatever is already running, and it is the one package
 * type that ships no skills and installs globally with no project or agent
 * attached. A schedule needs an agent to run the turn and a skills root to live
 * in, and an adapter supplies neither — so a declaration here could only be
 * accepted and then quietly dropped. A declared-and-ignored schedule is the
 * failure mode DOR-607 was about; zod rejecting the unknown key names the
 * problem instead. An adapter that wants recurring work belongs in a plugin
 * that `requires` it.
 *
 * The refusal has to be declared, not left implicit: a zod object STRIPS keys it
 * does not know, so simply omitting the slot would accept the declaration and
 * drop it without a word — the very thing this is trying to avoid.
 */
const AdapterManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('adapter'),
  /**
   * Always absent. Present with any value, this fails the parse with the
   * message below rather than being silently stripped. See the type note above.
   */
  schedules: z
    .never({
      invalid_type_error:
        'Adapters cannot declare schedules: an adapter is a transport with no agent to run a ' +
        'turn and no skills directory to keep one in. Ship the schedule in a plugin that ' +
        'requires this adapter.',
    })
    .optional(),
  /**
   * Adapter type identifier (e.g. `'discord'`, `'slack'`). Free-form; the
   * well-known {@link CONNECTOR_ADAPTER_TYPE} (`'connector'`) marks a
   * `ConnectorProvider` gateway package.
   */
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
 * A scheduled task the Shape stands up — the shared declaration
 * ({@link PackageScheduleSchema}) plus the two things only a Shape has.
 *
 * A Shape schedule is always the INLINE form: `name`, `description` and
 * `prompt` are re-required here (they are optional on the shared base, which
 * also serves the by-reference `skillRef` form), and `skillRef` itself is
 * refused for a Shape by {@link scheduleDeclChecks}. The result is the same
 * shape this schema has always had, so every Shape manifest in the wild keeps
 * parsing unchanged; what is new is that the fields it shares with the other
 * package types now come from one place.
 *
 * Shape of `CreateTaskRequestSchema` (`packages/shared/src/schemas.ts`) minus
 * `target`, which is resolved from `agentRef` at apply time.
 */
const ShapeScheduleSchema = BaseScheduleDeclSchema.extend({
  name: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  /**
   * Which Shape agent (`ShapeAgentSchema.ref`) this schedule runs as. Shape-only:
   * it points into the Shape's own `agents[]`, which no other package type has.
   * The other types bind by install location instead — see
   * {@link PackageScheduleSchema}.
   */
  agentRef: z.string().regex(/^[a-z][a-z0-9-]*$/),
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
 * The five rules:
 * 1. Every `schedules[].agentRef` resolves to some `agents[].ref`.
 * 2. At most one `agents[]` entry has `affinity: 'default'`.
 * 3. Every `extension-secret` connection's `extension` is in `activates`/`extensions`.
 * 4. Every `agents[]` entry has a `template` or a `matchName` (else unsatisfiable).
 * 5. The shared schedule-declaration rules ({@link scheduleDeclChecks}), with the
 *    by-reference `skillRef` form refused — a Shape declares its prompts inline.
 *
 * @param m - The parsed shape manifest to check.
 * @param ctx - Zod refinement context used to report field-scoped issues.
 */
export function shapeCrossFieldChecks(m: ShapePackageManifest, ctx: z.RefinementCtx): void {
  // 5) The rules every package type's schedules obey, plus the Shape-only
  //    refusal of `skillRef`. Run first so a malformed declaration is reported
  //    on its own terms before the agentRef rule below adds a second complaint.
  scheduleDeclChecks(m.schedules, ctx, { allowSkillRef: false });

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
 * 2. The schedule-declaration rules ({@link scheduleDeclChecks}) for every type
 *    that carries the shared slot, and the shape cross-field rules
 *    ({@link shapeCrossFieldChecks} — which runs the schedule rules itself, with
 *    `skillRef` refused) for `type === 'shape'`. `adapter` has no slot at all
 *    and is skipped.
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
    if (m.type === 'shape') {
      // Runs scheduleDeclChecks itself (with skillRef refused) alongside the
      // four Shape-only rules.
      shapeCrossFieldChecks(m, ctx);
      return;
    }
    if (m.type === 'adapter') return; // no schedules slot — see AdapterManifestSchema
    scheduleDeclChecks(m.schedules, ctx);
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
