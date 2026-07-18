---
slug: shapes
id: 260718-043822
created: 2026-07-18
status: specified
linearIssue: DOR-355
---

# The Shape primitive — Specification

**Status:** Draft <!-- Draft | Under Review | Approved | Implemented -->
**Author:** spec-shape-primitive (SPECIFY stage, Shapes program)
**Date:** 2026-07-18

## Overview

A **Shape** is the fifth DorkOS marketplace package type. Installing a Shape and switching into it changes _what DorkOS is for you right now_: it activates a set of extensions, arranges the workspace chrome (panels, sidebar, dashboard), makes one or more suggested agents available, and stands up the schedules and connections that make the place work. A Shape is a **place**, not an agent: it holds agents by **affinity, not ownership** (it can _suggest_ or _softly default_ an agent, but never binds one).

This spec defines: (1) the `shape` package type and its manifest schema; (2) the `apply_layout` UI command and the switching UX; (3) install/fork on the existing file-scoped transaction, with lineage; (4) per-piece degradation; and (5) a fully-worked **Linear Ops** example that proves the format needs zero escape hatches. It realizes `plans/shapes-program.md` D2 + W2 and unblocks P1 (Linear Ops) and P2 (Flow Board).

The consumer rule (from `research/20260717_shapes-byoa-positioning.md` §5): _if installing it changes what DorkOS is for you, it's a Shape; if it adds a capability, it's a plugin/extension._

## Background / Problem Statement

Today DorkOS ships every ingredient of a Shape but no way to bundle them: a 24-node widget catalog, 8 extension slots with agent-built extensions, a marketplace with four package types and a file-scoped install transaction, a scheduler, an agent registry where an agent is a directory, and `control_ui` UI commands. What's missing is the **whole**: a single installable unit that turns those parts into "a place." Without it, "shape-shifting" is a story with no noun behind it (`research` §2), the marketplace can't distribute installable experiences, and the reference shapes (P1/P2) have no schema to target.

The concrete gap (`research` §4): "no packaged _install one thing → complete app experience_ pattern demonstrated." This spec closes exactly that gap and nothing more — it does not add a full-page extension point, a connector vault, or a data layer (those are separate program items).

## Goals

- Define `shape` as the fifth `PackageType`, with a Zod-validated `ShapeManifestSchema` that composes existing packages/extensions and carries shape-specific glue.
- Every field Zod-expressible; every reference to existing code cites a real path; **Linear Ops fully describable with zero escape hatches** (§ Worked Example).
- Add an `apply_layout` UI command and a switching flow that applies chrome + _offers_ (never forces) the default agent, with clean preset semantics (no write-back; fork to capture).
- Reuse the existing file-scoped install transaction (ADR-0304) and add first-class **fork** with lineage metadata for the share loop.
- Per-piece, non-fatal degradation when a bundled extension/agent/connection is missing.
- Keep every schema change **additive** — no existing type changes, so the four shipped package types are untouched.

## Non-Goals

- The W1 wiring fixes themselves (DOR-354 `switchAgent`, real `agentId`, live re-mount, `visibleWhen` context) — a hard dependency, specified elsewhere.
- Full-page/route extension points (Assumption A2).
- The connector gateway / OAuth vault (program W5); `connections` are declarations today (A4).
- Marketplace category vocabulary + facet UI (program W3); Shapes participate but don't define the taxonomy.
- The eval harness (W4), the reference shapes' _content_ (P1/P2), and site share-loop pages (P7).
- Cross-machine sync beyond what `~/.dork/config.json` already provides (A3).

## Technical Dependencies

- **zod** — all schemas. New schemas live in browser-safe modules (`packages/marketplace/src/*`, `packages/shared/src/*`) importing only `zod` + local siblings, so `apps/client` and `apps/site` can consume them (matches the existing `manifest-schema.ts` module contract).
- **Existing DorkOS internals (no new libraries):** the marketplace install transaction (`apps/server/src/services/marketplace/transaction.ts`, ADR-0304); the tasks/scheduler service (`apps/server/src/services/tasks/`); the extension manager `enable`/`disable`; the config-manager + conf migration (`apps/server/src/services/core/config-manager.ts`, `adding-config-fields` skill); Harness Sync (`packages/harness`); the UI dispatcher (`apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`).
- **Program dependency:** W1 wiring fixes (see Non-Goals / Assumptions).

## Detailed Design

### 1. The `shape` package type

**1.1 Extend the type enum.** In `packages/marketplace/src/package-types.ts`:

```ts
export const PackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter', 'shape']);
```

`requiresClaudePlugin(type)` returns `true` for `shape` (a Shape is surfaced to Claude Code via a plugin manifest when it bundles CC-visible content such as skills/commands; a Shape with only DorkOS-native content still ships a minimal `.claude-plugin/plugin.json`, consistent with how `plugin`/`skill-pack`/`adapter` already do — only `agent` is exempt). The enum order is append-only so existing snapshots/dropdowns are unchanged (the module comments already promise order-stability).

**1.2 Extend dependency declarations.** In `manifest-schema.ts`, widen `DependencyDeclarationSchema` to permit `shape:`:

```ts
const DependencyDeclarationSchema = z
  .string()
  .regex(
    /^(adapter|plugin|skill-pack|agent|shape):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$/,
    'Must be of the form <type>:<name> or <type>:<name>@<version>'
  );
```

This lets a Shape compose another Shape (shape sets — Ikechi's multi-company case, `research` §5) with no new mechanism.

### 2. `ShapeManifestSchema`

A discriminated-union member on `type: 'shape'`, extending `BasePackageManifestSchema` (so it inherits `name`, `version`, `description`, `displayName`, `author`, `license`, `category`, `tags`, `icon`, `minDorkosVersion`, `layers`, `requires`, `featured`). All new sub-schemas are browser-safe.

```ts
/** How strongly a Shape pulls an agent in. Never binding — see affinity-not-ownership. */
const ShapeAgentAffinitySchema = z.enum(['suggested', 'default']);

/**
 * A suggested agent for a Shape. Either references an agent the user may already
 * have (`ref` = a stable slug used only within this Shape, resolved against
 * existing agents by name, or scaffolded from `template`) or ships a template to
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
  /**
   * DRIFT NOTE: mirrors `PermissionModeSchema` (`packages/shared/src/schemas.ts:27`)
   * by value — `packages/marketplace` (Zod 3, browser-safe) cannot import the
   * Zod-4 `@dorkos/shared` schema, so the six values are inlined. Any change to
   * `PermissionModeSchema` must be reconciled here (a unit test comparing the
   * two value sets keeps them honest — task 1.1).
   */
  permissionMode: z
    .enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'])
    .default('acceptEdits'),
  /** Created disabled when true (or when its agent is missing at apply time). */
  startDisabled: z.boolean().default(false),
});

/**
 * A connection the Shape needs. Two kinds today (A4): an extension secret to
 * prompt for, or a raw MCP server the bundled agents should have. A future
 * `provider` kind targets the W5 connector gateway; unknown kinds degrade to a
 * warning rather than a hard failure.
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
 * Deliberately EXCLUDES `SidebarPrefsSchema` (agent-list groups/pinned) — that
 * filing is a cross-Shape personal preference (ADR 260717-001409) and a Shape
 * must never clobber it.
 */
const ShapeLayoutSchema = z.object({
  /** Sidebar open on arrival. */
  sidebarOpen: z.boolean().default(true),
  /** Default built-in sidebar tab (UiSidebarTabSchema values). */
  sidebarTab: z.enum(['overview', 'sessions', 'schedules', 'connections']).optional(),
  /** Panels to open on arrival (UiPanelIdSchema values). */
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
  /** ISO-8601. */
  forkedAt: z.string(),
});

const ShapeManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('shape'),
  /** Extension ids to enable when this Shape is applied (core, bundled, or from `requires`). */
  activates: z.array(z.string()).default([]),
  /** Extensions embedded inline in this Shape's package dir (like PluginManifestSchema.extensions). */
  extensions: z.array(z.string()).default([]),
  /** The workspace chrome. */
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
```

Add `ShapeManifestSchema` to the `MarketplacePackageManifestSchema` discriminated union and export `ShapePackageManifest = z.infer<…>`. `SemverSchema` is the existing local schema in `manifest-schema.ts`.

**Cross-field validity — placement is load-bearing.** `packages/marketplace` pins **Zod 3** (`"zod": "^3.25.76"` in its `package.json`), where a `z.discriminatedUnion` member must be a plain `ZodObject` — `.superRefine()` returns a `ZodEffects`, which cannot be a union member. The codebase documents this exact constraint at `packages/shared/src/schemas.ts` (`OperationProgressEventShapeSchema` TSDoc: "a `discriminatedUnion` member must be a plain object, and `.superRefine()` returns a `ZodEffects` with no `.shape`"). Resolution — **option (a)**: `ShapeManifestSchema` stays a plain `ZodObject` member, and the four cross-field rules lift into a **top-level `.superRefine` on the union itself**, narrowing on the discriminant:

```ts
/**
 * Shape cross-field rules, exported standalone so the shape validator
 * (`dorkos package validate`, task 2.5) applies the SAME rules as the union.
 * Each violation calls ctx.addIssue with a precise `path`
 * (e.g. ['schedules', i, 'agentRef']), so errors stay field-scoped.
 */
export function shapeCrossFieldChecks(m: ShapePackageManifest, ctx: z.RefinementCtx): void {
  // 1) every schedules[].agentRef matches some agents[].ref
  // 2) at most one agents[] entry has affinity 'default'
  // 3) every extension-secret connection's `extension` is in activates/extensions
  // 4) every agents[] entry has a `template` or a `matchName`
}

export const MarketplacePackageManifestSchema = z
  .discriminatedUnion('type', [
    PluginManifestSchema,
    AgentManifestSchema,
    SkillPackManifestSchema,
    AdapterManifestSchema,
    ShapeManifestSchema, // plain ZodObject — Zod 3 union-member constraint
  ])
  .superRefine((m, ctx) => {
    if (m.type === 'shape') shapeCrossFieldChecks(m, ctx);
  });
```

The four rules:

1. Every `schedules[].agentRef` matches some `agents[].ref`.
2. At most one `agents[]` entry has `affinity: 'default'`.
3. Every `connections[kind=extension-secret].extension` appears in `activates` or `extensions` (you can't prompt for a secret of an extension the Shape never turns on).
4. Every `agents[]` entry has either a `template` or a `matchName` (otherwise it's unsatisfiable).

**Where install-path validation executes:** the install pipeline validates every package through `MarketplacePackageManifestSchema.safeParse` at `packages/marketplace/src/package-validator.ts:165` (installer step 3, "Validate package via @dorkos/marketplace/package-validator" — `contributing/marketplace-installs.md` §2), so with the rules on the top-level union, no shape manifest reaches a flow without them — `installer.install → package-validator → union.safeParse → shapeCrossFieldChecks`. Wrapping the union in `ZodEffects` is safe: its consumers are parse-path or type-level only: `package-validator.ts:165`, `packages/harness/src/sources/installed.ts:117` (both `safeParse` — the harness scan now gets the cross-field checks too), and `z.infer` (`manifest-schema.ts:189`); nothing accesses `.options`/`.shape` on the union. Option (b) — a bare member plus a separately-refined schema validated at a named installer boundary — was rejected in one sentence: the generic parse path would silently skip the cross-field rules, which is precisely the drift this section exists to prevent. Corollary: parsing the bare `ShapeManifestSchema` member directly skips the rules by construction, so its TSDoc must carry the codebase's established warning ("validate through `MarketplacePackageManifestSchema`, never this member alone" — the `OperationProgressEventShapeSchema` pattern).

### 3. `apply_layout` UI command

Add one variant to `UiCommandSchema` (`packages/shared/src/schemas.ts:2892`), preserving the discriminated-union-on-`action` shape. Count note: the union already holds **21** variants today while its doc comment (`schemas.ts:2887`) stales at "20" — this change makes it **22** and must correct the stale comment in the same edit:

```ts
// Shape switching
z.object({
  action: z.literal('apply_layout'),
  /** Installed Shape name to apply. The client resolves its manifest server-side. */
  shape: z.string().min(1),
}),
```

Rationale for referencing by `shape` name rather than inlining a layout: the manifest is the source of truth, an agent can say "switch me into my Linear Ops shape" by name, and the applier (server) owns resolution + degradation. Inlining a raw layout would duplicate the manifest and skip degradation/connection handling.

The dispatcher (`ui-action-dispatcher.ts`) gains a `case 'apply_layout'` that calls a new context method `ctx.applyShape?.(command.shape)` — the same optional-context pattern `switch_agent` uses (`ctx.switchAgent?.(command.cwd)`, line 275). `applyShape` triggers the apply flow (§5). Extensions may trigger it via `api.executeCommand({ action: 'apply_layout', shape })` (origin `'agent'`).

### 4. `ui.shapes` config state

Add to `UserConfigSchema` (`packages/shared/src/config-schema.ts`) via a semver-keyed conf migration (`adding-config-fields` skill):

```ts
const ShapeUserPrefsSchema = z.object({
  /** Installed Shape name currently applied, or null. */
  active: z.string().nullable().default(null),
  /**
   * Reverse affinity hint: agent `projectPath` → preferred Shape name. The
   * "soft default hint on an agent" from D2, kept OFF the agent manifest and in
   * person-scoped config, exactly per ADR 260717-001409.
   */
  agentDefaults: z.record(z.string(), z.string()).default(() => ({})),
  /**
   * When true, applying a Shape auto-follows to its `default` agent instead of
   * only offering. Off by default (offer, don't force).
   */
  autoFollowAgent: z.boolean().default(false),
});
// UserConfigSchema.ui gains: shapes: ShapeUserPrefsSchema.default(() => ({...}))
```

Whole-object writes per section (the `deepMerge`-replaces-arrays rule from ADR 260717-001409). No Shape state ever lands on `.dork/agent.json`.

### 5. Apply-shape flow (server) — `services/shapes/apply-shape.ts`

`applyShape(name, opts)` is **idempotent** and returns `{ ok, applied, warnings[], offeredAgents[] }`, where **`applied` carries the resolved outcome the client needs to act without a second fetch**: `{ layout: ShapeLayout, activatedExtensions: string[], schedulesCreated: string[] }` — the manifest's chrome after resolution, the extension ids actually enabled (post-degradation), and the schedules created this apply. This same object is the `POST /api/shapes/:name/apply` response body (§9); the client (task 3.1) applies `applied.layout` through the dispatcher. Steps, each independently degradable:

1. **Resolve** the installed Shape manifest from `{dorkHome}/shapes/<name>/.dork/manifest.json`. Missing → hard error (can't apply what isn't installed).
2. **Activate extensions:** for each id in `activates`, add to `UserConfigSchema.extensions.enabled` (the "turned ON that defaults OFF" list, `config-schema.ts:238`). If an id isn't discoverable (not core, not installed, not inline) → **skip + warn** (`extension '<id>' not found; install it to complete this Shape`).
3. **Connections:** for each `extension-secret`, if the extension's declared secret is unset (`GET /api/extensions/:id/secrets` `isSet:false`), record an `offeredConnection` warning so the UI can prompt (`PUT /api/extensions/:id/secrets/:key`). For `mcp-server`, surface a setup hint. Nothing here blocks.
4. **Schedules:** for each schedule, resolve `agentRef` → a concrete agent `target` (the agent's `projectPath`). If the agent exists, create the task via the tasks service (`CreateTaskRequestSchema`) with `enabled = !startDisabled`. If the agent is absent, create it **disabled** and warn. Creating an existing identically-named schedule is a no-op (idempotent by `name`+`target`).
5. **Agents (offer, never force):** collect `agents[]`. For each, resolve satisfaction: `matchName` hits an existing agent → satisfied; else it's an **offer** (returned in `offeredAgents[]`, scaffolded only on user accept via the existing `AgentInstallFlow`/agent-create). Do **not** auto-create.
6. **Apply chrome:** write `layout.sidebarOpen`/`sidebarTab`/`openPanels`/`focusDashboardSections` into the live UI. The client half runs through the dispatcher (open/close sidebar, `switch_sidebar_tab`, open panels) and the extension re-mount (W1c) so newly-activated extensions appear without a page reload.
7. **Arrival agent:** if a single `affinity: 'default'` agent is satisfied and `ui.shapes.autoFollowAgent` is true, ride `switch_agent` (`{cwd: agentProjectPath}`, W1a) to it; otherwise include it in `offeredAgents[]` as the highlighted arrival offer.
8. **Record** `ui.shapes.active = name`.

All config writes go through the validated config manager; all warnings accumulate; **the apply never throws for a missing piece** — only step 1 (Shape not installed) is fatal.

### 6. Install & fork

**6.1 Install** — a new flow `apps/server/src/services/marketplace/flows/install-shape.ts` following the §9 recipe in `contributing/marketplace-installs.md`:

- `install(packagePath, manifest, opts)` wraps `runTransaction` with `target = {dorkHome}/shapes/<name>`; `stage` copies the package (incl. any inline `extensions`), `activate` does the atomic `atomicMove` and returns `InstallResult` with `type: 'shape'`.
- Bundled inline extensions compile through the existing `ExtensionCompiler` (same as `install-plugin.ts`), but are **not auto-enabled** — enabling is `applyShape`'s job (activation is a place decision, not an install decision), so a user can install several Shapes and switch between them.
- Register `'shape'` in the `MarketplaceInstaller` dispatch `switch` (`dispatchFlow`, `marketplace-installer.ts`) and construct `ShapeInstallFlow` in the `index.ts` marketplace block (gated on `extensionManager && adapterManager`). Note: the switch today has **no `assertNever`/default arm** — its doc comment claims exhaustive routing, but a missing case is only caught indirectly (implicit-return checking), so task 2.1 adds an explicit exhaustiveness guard (`default: { const _exhaustive: never = manifest; … }`) rather than relying on a check that isn't there.
- **Conflict detection** (`conflict-detector.ts`) gains shape-aware checks: warn when an installed Shape already owns the name; a Shape's `schedules` are checked against existing cron collisions only at _apply_ time (install just stages), so install-time conflict is limited to the Shape dir + inline extension ids.

**6.2 Fork** — a new operation `services/shapes/fork.ts` + `POST /api/shapes/:name/fork` (and a CLI `dorkos shape fork <name> [--as <newName>]`):

- Clone `{dorkHome}/shapes/<name>` → `{dorkHome}/shapes/<newName>` through `runTransaction` (same atomicity guarantees).
- Rewrite the new manifest's `name` and stamp `lineage = { forkedFrom: '<name>@<source>', forkedFromVersion: <version>, forkedAt: <iso> }`.
- **Capture-current-arrangement fork** (the flywheel): when forking the _active_ Shape, optionally snapshot the live chrome (`ui.*`, currently-enabled extension ids among `activates` candidates, live schedules bound to the Shape's agents) into the new manifest's `layout`/`activates`/`schedules`. This is how "I made my own version" produces a shareable artifact.
- Publishing a forked Shape to a marketplace source is out of scope here (P7 owns the share pages); `lineage` is the durable metadata they read.

### 7. Degradation rules (normative)

| Missing piece                              | Behavior on apply                                                                                         | Warning                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Shape not installed                        | **Fatal** — only fatal case                                                                               | `Shape '<name>' is not installed`                               |
| Activated extension not found              | Skip enabling it; layout still applies; its slots simply aren't contributed                               | `Extension '<id>' not found; install it to complete this Shape` |
| Extension secret unset                     | Extension renders its own configure state (e.g. linear-issues "Configure Linear API key"); offer a prompt | `Connection '<secret>' for '<ext>' needs setup`                 |
| MCP server connection absent               | Agents run without it; surface setup hint                                                                 | `MCP server '<server>' not configured`                          |
| Suggested/default agent absent             | Not created; returned as an offer; affinity is soft so nothing breaks                                     | `Agent '<ref>' not present — offered`                           |
| Schedule's target agent absent             | Schedule created **disabled**                                                                             | `Schedule '<name>' created disabled — agent '<ref>' missing`    |
| Bundled inline extension failed to compile | Recorded at install (same as plugin flow); `activates` skips it at apply                                  | `Extension '<id>' failed to compile`                            |

The switch is always usable; a half-satisfied Shape is a partially-furnished office, not a locked door. This mirrors ADR-0310 per-runtime degradation and the install `warnings[]` contract.

### 8. Code structure & file organization

```
packages/marketplace/src/
  package-types.ts          # + 'shape' in the enum; requiresClaudePlugin unchanged logic
  manifest-schema.ts        # + ShapeManifestSchema (+ sub-schemas) into the union; widen DependencyDeclaration
packages/shared/src/
  schemas.ts                # + apply_layout UiCommand variant
  config-schema.ts          # + ui.shapes (ShapeUserPrefsSchema) + conf migration
apps/server/src/
  services/shapes/
    apply-shape.ts          # idempotent apply flow (§5)
    fork.ts                 # fork + lineage (§6.2)
    __tests__/…
  services/marketplace/
    flows/install-shape.ts  # §9-recipe install flow
    marketplace-installer.ts# + 'shape' dispatch case
    conflict-detector.ts    # + shape-aware checks
    fixtures/valid-shape/    # Linear Ops fixture (worked example)
  routes/shapes.ts          # GET /api/shapes, POST /api/shapes/:name/apply, /fork
  index.ts                  # construct ShapeInstallFlow + apply/fork services in the marketplace block
apps/client/src/layers/
  shared/lib/ui-action-dispatcher.ts   # + apply_layout case → ctx.applyShape
  features/shapes/          # shape switcher UI, apply/reset, degradation warnings surface
packages/marketplace/       # validator + scaffolder: `dorkos package scaffold shape`
```

### 9. API changes

- `GET /api/shapes` — installed Shapes (name, displayName, active flag, lineage).
- `POST /api/shapes/:name/apply` → `{ ok, applied, warnings[], offeredAgents[] }` — the exact §5 return value, `applied` included, so the client applies `applied.layout` from the response without a second fetch (one contract across §5, this route, and task 3.1).
- `POST /api/shapes/:name/fork` (body `{ as?, captureCurrent? }`) → new Shape descriptor.
- `PATCH /api/config` — already exists; `ui.shapes` rides it.
- Marketplace install/uninstall routes are generic (`installer.install(req)`) — no route changes beyond the dispatch case.

All routes registered in the OpenAPI registry (openapi-fresh CI check) with TSDoc'd Zod schemas.

## User Experience

**Install → switch.** From the marketplace, a user installs "Linear Ops." Nothing changes yet (install stages; activation is a place decision). They open the **Shape switcher** (a control in the shell) and pick Linear Ops. The dashboard grows the Linear Loop section, the sidebar opens to it, and a banner offers: _"Linear Ops suggests a Linear Tender agent and a 15-minute inbox check — set up now?"_ with a one-tap accept. If the Linear API key isn't set, the Linear Loop card shows its own "Configure Linear API key" state (no crash). Switching to another Shape later re-arranges the chrome; switching back restores Linear Ops.

**Fork → tweak → share.** A user tweaks their live arrangement, then "Fork this Shape" captures the current chrome + schedules into a new Shape stamped with lineage. That artifact is theirs to keep or (via P7) share; the original is untouched.

**Agent independence.** Inside Linear Ops, the user can summon any agent; the Shape doesn't change. The tending agent is a _suggestion_, not the Shape's owner.

Entry points: the marketplace (install), the Shape switcher (apply/fork/reset), an agent's `control_ui apply_layout` (agent-initiated switch), the command palette. Error/exit paths: every missing piece degrades to a warning (§7); "Reset to Shape defaults" re-applies; leaving a Shape is just applying another (or clearing `ui.shapes.active`).

## Testing Strategy

- **Unit — schema (`packages/marketplace`, `packages/shared`):**
  - `ShapeManifestSchema` accepts the Linear Ops fixture and round-trips (`parse(serialize(x)) === x`). _Purpose: proves zero escape hatches for P1._
  - Each cross-field rule fails on a crafted invalid manifest (dangling `agentRef`; two `default` agents; `extension-secret` for a non-activated extension; an `agents[]` entry with neither `template` nor `matchName`) — **parsed through `MarketplacePackageManifestSchema`, the install path's entry point** (`package-validator.ts:165`), not the bare member. _Purpose: the cross-field invariants actually reject where install validation runs._
  - `DependencyDeclarationSchema` accepts `shape:foo@^1.0.0` and still rejects `theme:foo`. _Purpose: widening didn't over-open._
  - `apply_layout` parses; the union stays discriminated (an unknown `action` is rejected). _Purpose: additive variant is clean._
- **Unit — apply-shape (`services/shapes`):** with a fake extension manager / tasks service / agent registry, assert (a) all-present manifest enables every extension, creates every schedule enabled, offers the default agent, records `active`; (b) each degradation row in §7 produces exactly its warning and a still-`ok` result; (c) idempotency — applying twice yields no duplicate schedules and identical config. _Purpose: degradation is real, not narrative; apply is idempotent._
- **Unit — fork:** clone stamps lineage, rewrites `name`, leaves the original manifest byte-identical; `captureCurrent` snapshots live chrome. _Purpose: lineage + no-mutation-of-original._
- **Integration — install (`services/marketplace/__tests__`):** drive the real `MarketplaceInstaller` against `fixtures/valid-shape` and a temp `dorkHome` (reuse `buildInstallerForTests`); assert the Shape dir lands, inline extensions compile, nothing is auto-enabled, and a forced `activate` failure leaves zero residue (the transaction contract). _Purpose: rides ADR-0304 with no regressions._
- **Client — dispatcher (`ui-action-dispatcher.test.ts`):** `apply_layout` calls `ctx.applyShape` with the name; absent context is a safe no-op (matches `switch_agent`). _Purpose: additive dispatch, no crash when unwired._
- **E2E (deferred to P1/W4):** the true "install → switch → Linear Loop appears → schedule created" round-trip is a W4 eval against the real runtime; this spec's tests stop at API/filesystem outcomes (the `sse-test-helpers`/`collectDurableEvents` boundary), per `research` §8.2.

Each test carries a purpose comment; no always-green tests; edge cases (every degradation row, double-apply, forced-activate-failure) are covered because they can fail and reveal real issues.

## Worked Example — Linear Ops (zero escape hatches)

The **validation criterion**: Linear Ops must be fully describable in this manifest with no escape hatches. Linear Ops = the `linear-issues` core extension UI + a tending agent + an inbox-tick schedule + a saved layout. Every field below maps to real code cited in the ideation pre-reading log.

```json
{
  "schemaVersion": 1,
  "name": "linear-ops",
  "version": "1.0.0",
  "type": "shape",
  "displayName": "Linear Ops",
  "description": "Your Linear issues on the dashboard, tended by an agent on a 15-minute inbox check.",
  "author": "dorkos",
  "category": "project-management",
  "icon": "📋",
  "layers": ["extensions", "agents", "tasks"],
  "requires": [],
  "activates": ["linear-issues"],
  "extensions": [],
  "layout": {
    "sidebarOpen": true,
    "sidebarTab": "overview",
    "openPanels": [],
    "focusDashboardSections": ["linear-issues:linear-loop-dashboard"]
  },
  "agents": [
    {
      "ref": "linear-tender",
      "affinity": "default",
      "matchName": "Linear Tender",
      "template": {
        "displayName": "Linear Tender",
        "runtime": "claude-code",
        "persona": "You tend the Linear tracker like a teammate: each tick you poll your inbox, act on what you can, and ask when you're genuinely stuck.",
        "capabilities": ["linear", "triage"],
        "skills": ["flow__tending-tracker", "flow__linear-adapter"]
      }
    }
  ],
  "schedules": [
    {
      "name": "inbox-tick",
      "description": "Poll the Linear inbox and act on assigned/mentioned issues.",
      "prompt": "Run one tending tick: poll your inbox (assigned-to-me + @mentions + new comments) and respond/act/ignore per the tending rules.",
      "cron": "*/15 * * * *",
      "agentRef": "linear-tender",
      "permissionMode": "acceptEdits",
      "startDisabled": false
    }
  ],
  "connections": [
    {
      "kind": "extension-secret",
      "extension": "linear-issues",
      "secret": "linear_api_key",
      "required": true
    }
  ]
}
```

**Field-by-field grounding (the architect's audit):**

- `activates: ["linear-issues"]` — `linear-issues` is a **core** extension (`apps/server/src/core-extensions/linear-issues/`, `defaultEnabled: false`), so no `requires` entry is needed; apply adds it to `extensions.enabled[]`. Its `LoopDashboard` and `LoopSidebar` contribute to `dashboard.sections` and `sidebar.tabs` automatically once enabled (`index.ts` `activate()`), so the layout doesn't need to name them beyond the optional `focusDashboardSections` ordering hint (`linear-issues:linear-loop-dashboard` is the real registry id `${extId}:${id}`).
- `layout` — pure chrome from existing primitives (`UiSidebarTabSchema`, `UiPanelIdSchema`); no agent-list filing touched.
- `agents[0]` — `matchName` reuses an existing "Linear Tender" if present; else the `template` (mirroring `AgentManifestSchema.agentDefaults` + `skills`) is offered. `skills` are the real flow skills, delivered via Harness Sync — not embedded. `affinity: 'default'` → the arrival offer.
- `schedules[0]` — shape of `CreateTaskRequestSchema` minus `target`; `agentRef` resolves to the Tender's `projectPath` at apply. `cron: "*/15 * * * *"` = the inbox tick. `permissionMode: "acceptEdits"` is a real `PermissionModeSchema` value.
- `connections[0]` — the extension's own declared secret (`extension.json` → `serverCapabilities.secrets[0].key = "linear_api_key"`, required). Apply prompts via `PUT /api/extensions/linear-issues/secrets/linear_api_key`; if unset, the Loop card shows "Configure Linear API key" (its built-in empty state) — degradation, not failure.

No field required an escape hatch, a free-text blob, or a "misc" bag. **P2 (Flow Board)** is describable the same way: `requires: ["plugin:flow"]`, `activates` the flow board extension it ships, `agents` = the flow tender, `schedules` = the Pulse tick, `layout` = the board chrome.

## Performance Considerations

Apply is a handful of config writes + task creations + one extension re-mount — all already-cheap operations. The extension re-mount (W1c) replaces a full `location.reload()`, so switching is _faster_ than today's cwd-change reload. Install/fork reuse the existing transaction (no new I/O pattern). No polling is added; extensions keep their existing 5s-floor poll.

## Security Considerations

- **Secrets never travel in a manifest.** `connections` name _which_ secret to prompt for; values are set write-only via the existing `PUT /api/extensions/:id/secrets/:key` (`ExtensionSecretStore`, never returned). A Shape cannot exfiltrate or embed a credential.
- **No new permission surface.** Applying a Shape enables extensions and creates schedules the user already can create; the permission preview at _install_ (existing `permission-preview.ts`) shows what the Shape will bring. Schedules inherit the existing `permissionMode` gating.
- **Agents are offered, never auto-created**, so a Shape cannot silently stand up an autonomous agent; the arrival offer is an explicit accept.
- **Inline extensions** compile through the same `ExtensionCompiler` as plugin extensions — no new code-execution path, same (current) client-extension sandbox posture noted as a gap in `research` §4 (unchanged by this spec).
- Install rides the file-scoped transaction: a malformed Shape leaves zero residue (ADR-0304).

## Documentation

- `contributing/marketplace-installs.md` — add the Shape flow to the flows list and note the apply/activation split (install stages; apply activates).
- A new `contributing/shapes.md` developer guide (authoring a Shape manifest, the apply/degradation model, fork/lineage) — via `writing-developer-guides`.
- `docs/` concept page "What is a Shape?" is **S2's** deliverable, not this spec's; this spec provides the schema it documents.
- ADR extraction (`/adr:from-spec`) for the load-bearing decisions: composition-not-monolith; reverse-affinity-in-config; layout-excludes-filing; offer-not-force; preset-semantics/fork.

## Implementation Phases

- **Phase 1 — Schema & types (unblocks P1/P2 authoring).** `shape` enum + `ShapeManifestSchema` (plain member) + the top-level union `.superRefine` (`shapeCrossFieldChecks`); widen `DependencyDeclaration`; `apply_layout` UI command; `ui.shapes` config + migration; the Linear Ops fixture + schema round-trip test. _After this phase the manifest format is frozen and P1/P2 can be authored against it._
- **Phase 2 — Install & fork (server).** `install-shape.ts` + dispatch case + `index.ts` wiring + conflict checks; `apply-shape.ts` (idempotent, degrading); `fork.ts` + lineage; `routes/shapes.ts`; validator + scaffolder.
- **Phase 3 — Switching UX (client).** `apply_layout` dispatcher case + `applyShape` context; `features/shapes` switcher UI, offers surface, reset; depends on W1a (`switchAgent`) + W1c (live re-mount).
- **Phase 4 — Docs & ADRs.** `contributing/shapes.md`, marketplace-installs patch, ADR extraction.

## Open Questions

- **Q1.** Should `focusDashboardSections` grow into full dashboard section ordering/visibility, or stay an ordering hint? _Leaning: stay a hint until a reference Shape needs more (YAGNI)._
- **Q2.** Does "capture current arrangement on fork" (§6.2) snapshot _all_ live schedules bound to the Shape's agents, or only those the Shape originally created? _Leaning: only Shape-originated schedules, to avoid vacuuming unrelated tasks — resolve in Phase 2._
- **Q3.** When two installed Shapes both `activate` the same extension and one is un-applied, does the extension stay enabled? _Leaning: `apply` computes the enabled set from the active Shape only; extensions not in the newly-active Shape's `activates` and not user-pinned are disabled — but a user who manually enabled an extension keeps it (the `extensions.enabled[]` "deviation" semantics already distinguish user intent). Resolve with the Phase-2 apply tests._
- ~~Should affinity live on the agent manifest?~~ **(RESOLVED)** No — reverse hint in `ui.shapes` config (ADR 260717-001409). _Rationale: personal cockpit preference, not agent property._
- ~~Is "workspace" the name?~~ **(RESOLVED)** No — taken by git worktrees; the primitive is "Shape."

## Related ADRs

- ADR 260717-001409 — sidebar organization in user config (the precedent for reverse-affinity + active-shape state).
- ADR-0304 — file-scoped rollback for marketplace installs (the transaction Shapes ride).
- ADR-0236 — sidecar `dorkos.json` (taxonomy home; why `categories[]` is W3's, not this spec's).
- ADR-0230 — the four package types (this spec adds the fifth).
- ADR-0043 — agent storage file-first write-through (why UI/shape state stays off `.dork/agent.json`).
- ADR-0310 — per-runtime degradation (the degradation model this spec mirrors).
- To be extracted from this spec (`/adr:from-spec`): composition-manifest model; reverse-affinity-in-config; layout-excludes-filing; offer-not-force switching; preset-semantics-and-fork.

## References

- `plans/shapes-program.md` (D2, W2, P1, P2, harness-derived-shapes principle).
- `research/20260717_shapes-byoa-positioning.md` §4 (capability ground truth), §5 (Shape working design), §6 (priorities/demos), §8 (taxonomy/evals/connectors).
- `contributing/marketplace-installs.md` §9 (adding a package type), ADR-0304.
- `packages/marketplace/src/{package-types.ts,manifest-schema.ts}`; `packages/shared/src/{schemas.ts,config-schema.ts,mesh-schemas.ts}`; `packages/extension-api/src/{extension-api.ts,manifest-schema.ts}`; `apps/server/src/core-extensions/linear-issues/{index.ts,extension.json}`; `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`, `.../features/extensions/model/{extension-api-factory.ts,use-cwd-extension-sync.ts}`.
