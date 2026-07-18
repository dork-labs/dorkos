---
slug: shapes
id: 260718-043822
created: 2026-07-18
status: ideation
linearIssue: DOR-355
---

# The Shape primitive — the fifth marketplace package type

**Slug:** shapes
**Author:** spec-shape-primitive (IDEATE stage, Shapes program)
**Date:** 2026-07-18

---

## 1) Intent & Assumptions

- **Task brief:** Design the **Shape** primitive — a fifth DorkOS marketplace package type (alongside `agent`, `plugin`, `skill-pack`, `adapter`) that bundles **extensions + a saved layout + suggested agents + skills + MCP connections + schedules** into one installable, forkable unit. A Shape is a _place_ ("shape-as-place"), applied by switching into it; it holds agents by **affinity, not ownership**. This spec realizes program items **D2** (shape ontology) and **W2** (shape primitive spec) from `plans/shapes-program.md`, and must let **P1 (Linear Ops)** and **P2 (Flow Board)** be fully described in the manifest format it defines.
- **Founder decisions to build on (not relitigate):** Shape = fifth package type; shape-as-place with affinity not ownership; not named "workspace" (taken by git worktrees, `services/workspace/`); marketplace taxonomy is `categories[]` via the ADR-0236 sidecar (DOR-368). These are settled — this spec ratifies them into a concrete schema.
- **Assumptions (each marked and carried into §Decisions and the spec's Assumptions section):**
  - **A1.** The W1 wiring fixes (`plans/shapes-program.md` W1) land _before or alongside_ Shape switching: `switchAgent` wired into the dispatcher context (DOR-354), real `agentId` in `ExtensionAPI.getState()`, live extension re-mount replacing `location.reload()`, and `visibleWhen` context carrying `agentId`/`cwd`. This spec **depends on** W1 but does not re-specify it. Where a Shape feature needs a W1 fix, the dependency is called out.
  - **A2.** A Shape does **not** introduce a full-page/route extension point. Shapes arrange the _existing_ shell surfaces (dashboard sections, sidebar tabs, panels, right-panel workbench). The "extension owns a whole route" gap noted in `research/20260717_shapes-byoa-positioning.md` §4 stays out of scope.
  - **A3.** Cross-machine layout sync is out of scope beyond what `~/.dork/config.json` already gives (server-persisted; syncs across browsers + desktop against one server, per ADR 260717-001409). No hosted multi-user sync.
  - **A4.** MCP **connections** in a Shape are, at launch, _declarations of what the Shape needs_ (an MCP server the bundled agents should have, plus which extension secrets to prompt for) — not a managed OAuth vault. The connector gateway (`ConnectorProvider`, program W5) is a separate spike; a Shape references it once it exists but degrades to "raw MCP server config + secret prompt" today.
- **Out of scope:** the connector gateway itself (W5); marketplace category vocabulary/facet UI (W3); the eval harness (W4); the reference shapes' _content_ (P1/P2 build on this schema); site share-loop pages (P7); any Act-2 positioning copy.

## 2) Pre-reading Log

- `plans/shapes-program.md` — D2 defines the ontology (bundle model, affinity-not-ownership); W2 is this spec; P1/P2 are the downstream validators. **Harness-derived-shapes principle:** the first shapes are _assembly_ of already-shipped parts, which sets the design constraint — a Shape must compose existing pieces, not require new greenfield primitives.
- `research/20260717_shapes-byoa-positioning.md` §4–§6 — capability ground truth. Key facts used below: an agent **is a directory** (`.dork/agent.json`; `switch_agent` is literally `{cwd}`); extension discovery is cwd-scoped but enable/disable is one global list; `ExtensionAPI.getState().agentId` is a stub (`null`); a cwd change that alters the extension set triggers a full page reload; "workspace" is taken; ADR 260717-001409 put sidebar org in _user config_, explicitly rejecting agent-manifest UI state.
- `packages/marketplace/src/package-types.ts` — `PackageTypeSchema = z.enum(['agent','plugin','skill-pack','adapter'])` (ADR-0230). `requiresClaudePlugin(type)` returns `true` for everything except `agent`.
- `packages/marketplace/src/manifest-schema.ts` — `BasePackageManifestSchema` (name, version, type, description, `category` singular free-text, `tags`, `layers`, `requires`, `featured`); `MarketplacePackageManifestSchema` is a `z.discriminatedUnion('type', […])`. `PluginManifestSchema` carries `extensions: string[]`; `AgentManifestSchema` carries `agentDefaults` (persona/capabilities/traits); `AdapterManifestSchema` carries `adapterType`. `DependencyDeclarationSchema` = `^(adapter|plugin|skill-pack|agent):<name>(@ver)?$` — note it does **not** yet allow `shape:`.
- `packages/shared/src/schemas.ts` — `UiCommandSchema` (2892) is a 20-variant discriminated union on `action`; `switch_agent` is `{ action, cwd }` (2993). `UiPanelIdSchema = ['settings','tasks','relay','picker']` (2813); `UiSidebarTabSchema = ['overview','sessions','schedules','connections']` (2820). `TaskSchema`/`CreateTaskRequestSchema` (2474/2529) define scheduled tasks: `{ name, description, prompt, cron, timezone, target, enabled, maxRuntime, permissionMode }`; `PermissionModeSchema = ['default','plan','acceptEdits','dontAsk','bypassPermissions','auto']` (27).
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` — the dispatcher switches on `command.action`; `switch_agent` calls `ctx.switchAgent?.(command.cwd)` (275). `switchAgent` is an **optional** context field (91) and is a no-op in production today (DOR-354). Any new UI command rides the same dispatcher.
- `packages/extension-api/src/extension-api.ts` + `apps/client/.../extension-api-factory.ts` — 8 slots (`ExtensionPointId`): `sidebar.footer`, `sidebar.tabs`, `dashboard.sections`, `header.actions`, `command-palette.items`, `dialog`, `settings.tabs`, `right-panel`. `activate(api)` registers components via `api.registerComponent(slot, id, …)`; registry id is `${extId}:${id}`. `projectState()` hardcodes `agentId: null` (the W1 stub).
- `packages/extension-api/src/manifest-schema.ts` — `ExtensionManifestSchema`: `id`, `contributions`, `capabilities.events`, `serverCapabilities` (`serverEntry`, `externalHosts`, `secrets[]`, `settings[]`), `dataProxy`, `defaultEnabled`, `canDisable`. Extension **secrets** are declared here and set write-only via `PUT /api/extensions/:id/secrets/:key` (`apps/server/src/routes/extensions.ts:344`, backed by `ExtensionSecretStore`; never returned).
- `apps/server/src/core-extensions/linear-issues/{index.ts,extension.json,server.ts}` — the P1 worked example's UI. `extension.json`: `id: linear-issues`, `defaultEnabled: false`, `canDisable: true`, contributions `dashboard.sections` + `sidebar.tabs`, required secret `linear_api_key`, setting `team_key` (default `DOR`). `index.ts` `activate()` registers `LoopDashboard` into `dashboard.sections` and `LoopSidebar` into `sidebar.tabs`; both render an empty/"configure API key" state when data is absent — the built-in degradation this spec leans on.
- `packages/shared/src/config-schema.ts` — `UserConfigSchema` (117). `ui.sidebar` = `SidebarPrefsSchema` (groups/pinned/sort/collapse), the sidebar _filing_ (90); `extensions.enabled[]`/`extensions.disabled[]` record **deviations from each extension's default state** (233); `ui.workbench` (410), `scheduler` (180). Config is written through validated `PATCH /api/config` with a semver-keyed conf migration (`adding-config-fields` skill).
- `decisions/260717-001409-sidebar-organization-in-user-config.md` — the load-bearing precedent: UI/organization state lives in **user config keyed to the person**, _not_ on the agent manifest ("a group is a personal cockpit preference, not a property of the agent"). This spec follows the same rule for the reverse (agent→shape) affinity hint.
- `contributing/marketplace-installs.md` + `decisions/0304-*.md` — every install runs through the file-scoped `runTransaction` (stage in tmpdir → backup target → atomic rename → restore on failure). §9 is a step-by-step recipe for **adding a fifth package type**: extend the type enum, add a flow file, add the dispatch `case`, wire it in `index.ts`, add a fixture + flow test + integration test. Conflict detection covers slot/skill/task/cron/adapter collisions.
- `decisions/0236-sidecar-dorkos-json-for-marketplace-extensions.md` — CC's `marketplace.json` validator uses `additionalProperties: false`, so DorkOS-only fields (incl. a future `categories[]`) live in the `.claude-plugin/dorkos.json` sidecar. The internal package manifest (`.dork/manifest.json`) is _not_ the CC file and may carry richer fields.
- `packages/harness/src/*` — Harness Sync projects installed skills/commands/plugins into every agent's harness (`.claude/…`). A Shape's suggested-agent skills reach the agent through this existing projection; the Shape does not invent a second skill-delivery path.

## 3) Codebase Map

- **Primary modules a Shape touches:**
  - **Schema (browser-safe):** `packages/marketplace/src/{package-types.ts,manifest-schema.ts}` (add `shape` type + `ShapeManifestSchema`); `packages/shared/src/schemas.ts` (add `apply_layout` UI command + a `ShapeLayoutSchema` built from existing UI primitives); `packages/shared/src/config-schema.ts` (add `ui.shapes` state).
  - **Install (server):** `apps/server/src/services/marketplace/flows/install-shape.ts` (new flow), the dispatch `switch` in `marketplace-installer.ts`, the wiring block in `apps/server/src/index.ts`, `conflict-detector.ts`, and a new `fork.ts` operation. A new **apply-shape** service that writes `extensions.enabled[]`, `ui.sidebar` chrome bits, creates schedules via the tasks service, and offers agents.
  - **Switching (client):** `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` (`apply_layout` case), a `features/shapes` slice (shape switcher UI + apply/reset), and reuse of the `switchAgent` context (W1a).
  - **Distribution:** `packages/marketplace` validator + scaffolder (`dorkos package scaffold shape`), and the external `dork-labs/marketplace` registry for P1/P2.
- **Shared dependencies:** the config-manager migration path (`adding-config-fields` skill), the tasks/scheduler service (`apps/server/src/services/tasks/`), the extension manager (`enable`/`disable`), the agent registry + `AgentInstallFlow` (for suggested agents), and Harness Sync (skills projection).
- **Data flow (apply a Shape):** user picks a Shape → `apply_layout` UI command (or the switcher) → apply-shape service resolves the installed Shape manifest → writes chrome to `ui.*` config + `extensions.enabled[]` → schedules created/enabled → suggested agents _offered_ (not forced) → dispatcher applies live UI (panels/sidebar/re-mount) → `ui.shapes.active` recorded. Degradation collects `warnings[]`; the switch never blocks.
- **Feature flags/config:** Shapes ride the existing marketplace install machinery (already conditional on `extensionManager && adapterManager` in `index.ts`). New config section `ui.shapes` behind a conf migration.
- **Potential blast radius:** the `MarketplacePackageManifestSchema` discriminated union (adding a variant is additive and type-checked exhaustively at the dispatch switch); `UiCommandSchema` (additive variant); `UserConfigSchema` (additive section + migration). No existing type changes — every touch is additive, which keeps the blast radius small and the four shipped package types untouched.

## 4) Research — options considered

### 4.1 What _is_ a Shape on disk? (the core modeling choice)

**Option A — Monolithic bundle.** A Shape is a self-contained directory that physically embeds its extensions, agent definitions, skills, and schedules.
_Pros:_ one artifact, no dependency resolution. _Cons:_ massive duplication (Linear Ops would re-embed `linear-issues`, which already ships as a core extension); no reuse; fork copies megabytes; violates the harness-derived principle that shapes are _assembly_.

**Option B — Pure reference manifest.** A Shape is _only_ a list of `requires` (existing packages) plus glue (layout, schedules, affinity). It embeds nothing.
_Pros:_ tiny, reuses everything, forks are cheap. _Cons:_ a Shape that wants a bespoke one-off extension or agent persona has nowhere to put it; forces every part to be separately published first.

**Option C — Composition manifest with optional inline payload (chosen).** A Shape **references** existing packages via the existing `requires` mechanism _and_ **activates** already-present extensions by id (core or installed), and may **optionally embed** its own extensions/agent-template glue inline — exactly the way `PluginManifestSchema` already carries `extensions: string[]` and `AgentManifestSchema` carries `agentDefaults`. The manifest adds shape-specific fields: `layout`, `agents` (affinity), `schedules`, `connections`, `activates`.
_Why:_ Linear Ops needs **zero** new payload — it `activates: ['linear-issues']` (a core extension already on disk) and defines a tending agent template + a schedule inline. Flow Board references the already-published `flow` plugin. Composition is the default; inline is the escape valve for bespoke glue, and it reuses install patterns that already exist (§9 of `marketplace-installs.md`). This is the only option that satisfies the zero-escape-hatch validation for P1 without embedding a copy of a core extension.

### 4.2 Where does agent affinity live? (affinity-not-ownership, made concrete)

The founder settled "affinity, not ownership: a shape suggests agents; at most a soft default hint on an agent — never binding." Two directions of the relation:

- **Shape → agents (forward):** lives in the **Shape manifest** as `agents[]`, each with `affinity: 'suggested' | 'default'`. This is a property of the Shape (the office lists the roles it expects), so the manifest is its natural home.
- **Agent → shape (reverse, the "soft default hint"):** three candidates, mirroring ADR 260717-001409's exact deliberation for sidebar groups —
  1. on `AgentManifestSchema`/`.dork/agent.json` — **rejected**, same reason ADR 260717-001409 rejected sidebar groups on the agent manifest: an agent's home shape is a _personal cockpit preference_, not a property of the agent; it would leak one operator's filing into shared agent state and drag in ADR-0043 write-through obligations for pure UI state.
  2. localStorage — rejected (doesn't survive browser/desktop split; the same failure ADR 260717-001409 cites).
  3. **`UserConfigSchema.ui.shapes` keyed by agent `projectPath` (chosen)** — the reverse hint is a person-scoped preference living exactly where sidebar org lives, written through the same `PATCH /api/config`.

**Chosen:** forward affinity in the manifest; reverse hint (and the active-shape pointer + any per-shape local override) in `ui.shapes` config. Nothing about a Shape ever binds an agent; the strongest effect is that switching into a Shape _offers_ its `default` agent.

### 4.3 What is a "saved layout"? (what a Shape may and may not touch)

A tempting reading is "a Shape restores your whole sidebar" — including `SidebarPrefsSchema` groups/pinned. **Rejected.** The agent-list filing (groups, pinned agents) is a _cross-shape personal preference_; a Shape overwriting it would clobber the operator's own organization every time they switch context — hostile, and inconsistent with ADR 260717-001409 (which made that filing person-owned). So the Shape's `layout` is the **workspace chrome**: which panels are open (`UiPanelIdSchema`), whether the sidebar is open + its default built-in tab (`UiSidebarTabSchema`), and which extensions are active (`activates`, applied to `extensions.enabled[]`) plus optional dashboard-section emphasis. The layout composes only existing UI primitives, so it is fully Zod-expressible from schemas that already ship. The agent-list filing is deliberately excluded.

### 4.4 What happens on switch, and what persists?

- **Option A — Shape switch == agent switch.** Reject: conflates place and staff; multi-agent shapes (content pipeline) have no single agent; contradicts affinity-not-ownership.
- **Option B — Shape switch applies chrome only; agent unchanged.** Safe but misses the "walk into the office and your default assistant is there" feel.
- **Option C (chosen) — Shape switch applies chrome + _offers_ the default agent.** Applying a Shape sets the workspace chrome and records `ui.shapes.active`. If the Shape has an `affinity: 'default'` agent that exists, the switch _offers_ to switch to it (or, if the operator opts into "auto-follow," rides the existing `switch_agent`/`switchAgent` path — W1a). Switching agents _within_ a Shape does **not** change the Shape. This keeps place and staff independent while still delivering the arrival experience.
- **Persistence:** a Shape is a **preset/template**, not a live document. After applying, the live layout is the user's own config; local tweaks are _not_ written back into the Shape (no silent drift). Re-applying the Shape resets to its defaults; **forking** captures the current arrangement as a new Shape. This is the fork→tweak→share flywheel (`research` §6) and it means "install a Shape" and "my customized version" are cleanly separated artifacts.

### 4.5 Install & fork transaction

Shapes ride the **existing** file-scoped `runTransaction` (ADR-0304) via a new `install-shape.ts` flow, per the §9 recipe — no new install engine. Install stages the Shape dir under `{dorkHome}/shapes/<name>/`, then runs a post-activate **apply** step (config writes, schedule creation, agent offer) that is idempotent. **Fork** is a first-class operation: clone an installed Shape's dir, stamp `lineage` (`forkedFrom`, `forkedFromVersion`, `forkedAt`), and register the new Shape locally — the lineage feeds the share loop's "forked from @kai's, N installs" (P7).

### 4.6 Degradation

Modeled on ADR-0310's per-runtime degradation and the install `warnings[]` pattern: applying a Shape with a missing piece **never blocks**. Each missing piece degrades locally and emits a warning (missing extension → the slot simply isn't contributed, matching the linear-issues "configure API key" empty state; missing agent → offer to create, affinity is soft so nothing breaks; missing secret/connection → the extension shows its own configure state; schedule whose target agent is absent → created **disabled** with a warning). Detailed in the spec.

## 5) Recommendation

Adopt **Option C** end to end: a **composition manifest** (`ShapeManifestSchema`) that references + activates existing packages/extensions and carries shape-specific glue (`layout`, `agents` with forward affinity, `schedules`, `connections`, `activates`, `lineage`); the reverse agent→shape hint and active-shape state in `ui.shapes` config; an `apply_layout` UI command riding the existing dispatcher; install/fork on the existing file-scoped transaction; per-piece non-fatal degradation. Validate against **Linear Ops** with zero escape hatches (worked example carried into the spec).

## 6) Decisions

| #   | Decision                              | Choice                                                                                                                                                       | Rationale                                                                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Disk model                            | **Composition manifest + optional inline payload** (§4.1 Opt C)                                                                                              | Linear Ops needs zero new payload; reuses `requires`/`extensions`/`agentDefaults` patterns and the §9 install recipe; avoids re-embedding core extensions. |
| 2   | Forward affinity home                 | **Shape manifest `agents[]` with `affinity: suggested\|default`**                                                                                            | The expected roles are a property of the place.                                                                                                            |
| 3   | Reverse affinity + active-shape state | **`UserConfigSchema.ui.shapes`, keyed by agent `projectPath`**                                                                                               | Person-scoped cockpit preference; follows ADR 260717-001409 exactly; never on `.dork/agent.json`.                                                          |
| 4   | What "layout" means                   | **Workspace chrome only** (panels, sidebar open + built-in tab, `activates`, dashboard emphasis) — **excludes** the agent-list filing (`SidebarPrefsSchema`) | Composes existing UI primitives; refuses to clobber the operator's personal filing.                                                                        |
| 5   | Switch behavior                       | **Apply chrome + _offer_ default agent; agent≠shape** (§4.4 Opt C)                                                                                           | Independent place/staff; delivers the arrival experience without binding.                                                                                  |
| 6   | Persistence                           | **Preset semantics: no write-back; re-apply resets; fork captures**                                                                                          | Clean separation of "installed Shape" vs "my version"; drives the fork→tweak→share loop; no silent drift.                                                  |
| 7   | Install/fork                          | **Existing file-scoped `runTransaction` + new `install-shape.ts`/`fork.ts`; `lineage` stamped on fork**                                                      | Reuses ADR-0304; §9 is a written recipe; lineage feeds P7.                                                                                                 |
| 8   | Degradation                           | **Per-piece, non-fatal, `warnings[]`**                                                                                                                       | Mirrors ADR-0310 + install warnings; a Shape is useful even half-satisfied.                                                                                |
| 9   | Taxonomy                              | **Keep `category` (singular) on the internal manifest now; `categories[]` is W3's sidecar deliverable**                                                      | Internal `.dork/manifest.json` ≠ CC `marketplace.json`; no conflict with ADR-0236; don't fork the taxonomy here.                                           |
| 10  | `shape:` dependencies                 | **Allowed** — extend `DependencyDeclarationSchema` to permit `shape:<name>` so a Shape can compose another Shape                                             | Enables shape sets (Ikechi's multi-company use in `research` §5) without a new mechanism.                                                                  |
