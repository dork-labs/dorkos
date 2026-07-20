# Shapes

## Overview

A Shape is the fifth marketplace package type (`type: 'shape'`, DOR-355): a "place" that composes existing extensions, agents, schedules, and workspace chrome into one installable unit. This guide covers the Shape lifecycle that spans two service domains — the marketplace install/uninstall/update flows and the dedicated `services/shapes/` apply engine — and the invariants that keep it safe, above all the provenance rule that stops a name collision from ever deleting a user's own schedule.

The one idea that explains most of the design: **installing a Shape is not applying it.** Install stages files; apply is the separate, person-scoped act that turns the place on. Every seam below follows from that split.

**Pair this guide with:**

- [`contributing/marketplace-installs.md`](marketplace-installs.md) — the shared install pipeline, transaction engine, and uninstall flow the Shape flows plug into.
- [`contributing/marketplace-packages.md`](marketplace-packages.md) — the package manifest schema this builds on.
- `services/tasks/` and the [Task Scheduler guide](../docs/guides/task-scheduler.mdx) — schedules are ordinary scheduled tasks; a Shape only creates and tears them down.
- [ADR-0310](../decisions/0310-runtime-owned-session-storage-aggregated-listing.md) — the per-runtime degradation model apply mirrors: one fatal case, everything else degrades to a `warnings[]` entry.
- ADR 260717-001409 — why active-Shape config writes are whole-section (`deepMerge` replaces arrays), preserving sibling prefs.

## Key Files

| Concept                                      | Location                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Apply engine (pure, injected)                | `apps/server/src/services/shapes/apply-shape.ts`                                                                                      |
| Concrete schedule service (file-first)       | `apps/server/src/services/shapes/shape-schedule-service.ts`                                                                           |
| Agent-create re-bind seam                    | `apps/server/src/services/shapes/rebind-schedules.ts`                                                                                 |
| Production adapters (resolver, config, list) | `apps/server/src/services/shapes/shape-services.ts`                                                                                   |
| Shape routes (list + apply)                  | `apps/server/src/routes/shapes.ts`                                                                                                    |
| Install flow (stages, does not activate)     | `apps/server/src/services/marketplace/flows/install-shape.ts`                                                                         |
| Uninstall teardown                           | `apps/server/src/services/marketplace/flows/uninstall.ts`                                                                             |
| Update (advisory → replace)                  | `apps/server/src/services/marketplace/flows/update.ts`                                                                                |
| Manifest schema + cross-field rules          | `packages/marketplace/src/manifest-schema.ts` (`ShapeManifestSchema`)                                                                 |
| Client apply surface (the only caller)       | `apps/client/src/layers/features/shapes/ui/ShapeSwitcherDialog.tsx`                                                                   |
| Apply mutation + reusable action             | `apps/client/src/layers/features/shapes/model/use-apply-shape.ts`, `apps/client/src/layers/entities/shapes/lib/apply-shape-action.ts` |
| Switcher open-state + focus                  | `apps/client/src/layers/shared/model/app-store/app-store-panels.ts` (`openShapeSwitcherToShape`)                                      |

On-disk layout: an installed Shape lives at `{dorkHome}/shapes/<name>/.dork/manifest.json`. Shapes are **global-only** (person-scoped) — `install-shape.ts` accepts `projectPath` for signature symmetry but never uses it. The active pointer is `ui.shapes.active` in `~/.dork/config.json`.

## The lifecycle seams

Five seams move a Shape from "files on disk" to "a running place" and back. Each is idempotent.

| Seam                      | Trigger                               | What runs                                                                                             |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Install**               | `dorkos install <shape>`              | Stage files, compile bundled inline extensions. **No** extension enable — staging is not activation.  |
| **Apply**                 | `POST /api/shapes/:name/apply`        | Swap extensions, create/re-bind schedules, reconcile dropped ones, offer agents, record active.       |
| **Agent-created re-bind** | An agent is created/registered        | `rebindShapeSchedulesForAgent` flips any waiting global schedule to that agent — no re-apply needed.  |
| **Update**                | `dorkos update --apply <shape>`       | Uninstall-without-teardown → reinstall. Schedules survive; dropped ones are reconciled at next apply. |
| **Uninstall teardown**    | `POST /api/marketplace/.../uninstall` | Delete the Shape's schedules always; if active, disable its extensions and clear the active pointer.  |

### Install stages, it does not activate

`ShapeInstallFlow.activate` (`flows/install-shape.ts`) atomically moves the staged dir onto `{dorkHome}/shapes/<name>/` and returns — deliberately with **no** `extensionManager.enable` step. Bundled inline extensions land compiled-but-disabled. Turning extensions on is a "place decision" that belongs to apply, so a user can install several Shapes without their extensions all coming on at once. This is the install/apply split at the file layer.

### Apply is the engine

`applyShape(name, deps)` (`apply-shape.ts`) is pure and fully injected — every collaborator is a structural interface, so it runs against lightweight fakes (no disk, no config singleton, no scheduler). The concrete wiring lives in the routes layer; the production adapters are in `shape-services.ts`.

The **only fatal case** is "Shape not installed" (`ShapeNotInstalledError` → 404). Every other missing piece degrades to a `warnings[]` entry and a still-`ok` result, mirroring ADR-0310. The return value is the exact `POST /api/shapes/:name/apply` body — `{ ok, applied, warnings, offeredAgents }` — so the client acts without a second fetch (`applied.layout` is the chrome to restore).

Apply runs these steps in order:

1. **Resolve the manifest** (fatal if missing).
2. **Swap out the outgoing Shape's extensions** (see [swap semantics](#extension-swap-semantics-and-the-manual-enable-caveat)).
3. **Activate this Shape's extensions.** A non-discoverable or non-compilable id skips + warns.
4. **Resolve connections.** Nothing here blocks — an unset secret or an MCP server just adds a warning.
5. **Create / re-bind schedules** (see [schedule provenance](#schedule-provenance-and-the-fail-closed-invariant)).
6. **Reconcile away dropped/renamed schedules** the current manifest no longer declares.
7. **Offer agents** (offer, never force — see below).
8. **Record the active Shape** (`configStore.setActiveShape`, whole-section write).

Apply is idempotent: applying the same Shape twice enables the same extensions, creates no duplicate schedules, offers the same agents, and leaves identical config. The client's **Reset to defaults** button just re-applies the active Shape.

### Agents are offered, never forced

A Shape holds agents by _affinity, not ownership_. Each `agents[]` entry is resolved against the registry by `matchName` (case-insensitive, via `matchesAgentByName` — the single rule shared by apply and the re-bind seam). An unsatisfied entry becomes a scaffold offer (its `template` is the seed); the single satisfied-or-offered `default` entry is the highlighted arrival offer. `applyShape` returns these as `offeredAgents[]`; the client renders offer cards and the user confirms creation. Nothing is auto-created. The offer card's cadence line comes from `summarizeAgentSchedule`, which returns a plain-language string only when the Shape declares a describable schedule for that agent.

## Schedule provenance and the fail-closed invariant

This is the safety-critical part of Shapes. Read it before touching schedule code.

A Shape schedule is an ordinary scheduled task (`services/tasks/`), created file-first by `ShapeScheduleService` (`shape-schedule-service.ts`) exactly like the tasks router does. It is stored under `slugify(name)` in the global `{dorkHome}/tasks/<slug>/` dir or, once bound, the agent's `{projectPath}/.dork/tasks/<slug>/`. The one thing that makes it a _Shape_ schedule is a **provenance marker** stamped into its frontmatter at creation:

```yaml
origin: shape
shape: <shape-name>
```

`readShapeOrigin` reads that marker and **fails closed**: any read failure, parse failure, or missing marker returns `null`, which every caller treats as "not a Shape schedule — do not touch."

### Why the marker, and not the name

A user can create their own global schedule with a colliding name through the tasks API. So **name + unbound is never proof a schedule belongs to a Shape.** Both mutating operations gate on the marker naming _this exact Shape_:

- **Re-bind** (`rebindSchedule`) refuses to move a schedule with no marker, or one bound already, or one whose agent has no project path.
- **Teardown** (`deleteSchedulesForShape`) skips any schedule whose marker is missing, unreadable, or names a different Shape.

The invariant in one line: **a name collision must never delete or hijack a user's schedule.** Every change to re-bind or teardown must preserve it, and the tests below assert it directly.

### The global → agent flip

A Shape schedule bound to an agent that does not exist yet is created **global + disabled** (a warning is recorded). It flips to agent-bound + enabled through one of two seams:

1. **Re-apply.** On the next `applyShape`, step 5 finds the existing global copy, confirms the agent now exists and the marker matches this Shape, and re-binds it.
2. **Agent creation.** The user should not have to re-apply. `rebindShapeSchedulesForAgent` (`rebind-schedules.ts`), wired at the agent-create/register seam in the routes/index layer, scans installed Shapes for schedules waiting on the new agent (matched by `matchName` + marker + still-global) and flips them.

Existence is checked by schedule **name (the slug) across every scope — never by name + target.** A Shape schedule's target legitimately flips `global → agentId` between applies, so a per-target check would miss the earlier global copy and create a duplicate. `createSchedule`/`listSchedules` speak slugs, so apply matches on `slugify(schedule.name)`; a non-kebab manifest name ("Inbox Tick" → "inbox-tick") that keyed off the raw name would miss its stored copy and the flip would silently never fire (fixed in #372).

`rebindSchedule` physically **moves** the file from the global `tasks/` dir into the agent's `.dork/tasks/` (on-disk location is what makes a schedule agent-owned): write the agent-scoped copy first, then tear down the global one. The move is deliberately not atomic — if the process dies between the two writes, both copies exist under one name, but the stale one is global + disabled (never fires), the reconciler re-syncs both as-is, and the next apply/agent-create sees the agent-bound copy first and no-ops. Worst case is a leftover disabled global schedule the user can delete.

## Extension swap semantics and the manual-enable caveat

Applying a Shape is a **swap, not an accumulation** (`apply-shape.ts` step 2a). Before enabling the incoming Shape's `activates`, apply reads the still-current active pointer, resolves the _outgoing_ Shape's manifest, and disables every extension in `outgoing.activates` that is **not** in `incoming.activates`. Extensions in both sets stay on with no disable/enable flap. A no-longer-installed outgoing Shape yields a `null` manifest — its declared set is unknown, so apply leaves every extension alone rather than guess.

**The accepted caveat:** a Shape "owns" its declared extension set for the purpose of this swap. Apply cannot distinguish an extension the user enabled by hand that _happens_ to sit in the outgoing Shape's `activates` from one that Shape turned on. So a swap may disable such an overlap. This is accepted rather than tracking per-extension provenance, and it is surfaced in `deactivatedExtensions[]` on the apply result and documented in the user guide. If you are tempted to "fix" it by tracking who enabled each extension, that is a real feature with real cost — do not add it silently.

## Update: replace without teardown

`UpdateFlow` (`flows/update.ts`) is advisory by default (ADR-0233). With `apply: true` it delegates to the installer's `update()`, which runs uninstall-without-purge → reinstall. The crucial detail for Shapes: that internal uninstall sets **`deactivateShape: false`**, which suppresses `teardownShape` entirely. During a version replace the schedules are **not** deleted, the extensions stay on, and the active pointer is preserved — because the same Shape lands back at the same path moments later. That flag is installer-only; the HTTP uninstall body schema does not expose it, so an external uninstall always gets the honest clear-on-remove behavior.

Reconciliation of a renamed/dropped schedule therefore happens at the next **apply**, not at update: `applyShape` step 6 calls `deleteSchedulesForShape(name, declaredScheduleNames)` where `declaredScheduleNames` is the set of currently-declared names in **slug** form. Provenance-marked schedules whose slug is not in that set are swept (across global + agent-bound scopes); the just-created/re-bound names are kept. Match on the slug, not the raw name, or the sweep would delete the very schedule this apply just created.

## Uninstall teardown

`UninstallFlow.teardownShape` (`flows/uninstall.ts`) runs when a `type: 'shape'` package is removed and `deactivateShape !== false`:

1. **Delete the Shape's schedules — always, active or not.** `deleteSchedulesForShape(shapeName)` with no `keepNames` removes every provenance-marked schedule across scopes, so a Shape's tick never keeps firing after the Shape is gone.
2. **If this is the active Shape:** disable the extensions it turned on (`manifest.activates`, the reverse of apply's enable step) and `clearActiveShape()` so the pointer never dangles at a deleted install.

A **non-active** Shape's uninstall deletes its schedules but leaves extensions alone — they were never turned on by this Shape's apply, and the active Shape may depend on them. Both Shape-aware hooks (`shapeScheduleTeardown`, `shapeDeactivator`) are optional on the deps; a Shape-unaware caller simply skips those steps.

## The single apply surface (client)

**`ShapeSwitcherDialog` is the only user-facing apply surface.** It is the sole caller of the apply mutation (`use-apply-shape` → `applyShapeAction`), so every affordance a person can click is an _entry point that opens the switcher_, never a second apply path:

- The install success toast's **Apply…** action (`use-install-with-toast.ts`) fires only for `type: 'shape'` installs and calls `openShapeSwitcherToShape(packageName)`.
- Each Shape row in `InstalledPackagesView` gets an **Apply…** action that calls `openShapeSwitcherToShape(name)`; the active row shows an **Active** badge and no button (the badge is the state).
- The command palette's **Switch Shape** entry opens the switcher plainly.

`openShapeSwitcherToShape` sets `shapeSwitcherFocus` (`app-store-panels.ts`); the switcher highlights and scrolls that card into view via a callback ref, but the user still clicks to apply — nothing auto-applies. Keeping one user surface means degradation notes, the arrival offer, and the auto-follow decision live in exactly one component, and there is one place to reason about "what did applying just do."

There is exactly one other caller of `applyShapeAction`: the agent-driven path. `apps/client/src/main.tsx` wires the agent's `control_ui apply_layout` command straight to `applyShapeAction` (dispatch origin `'agent'`, not `'user'`), so an agent can restore a Shape's chrome without going through the switcher. If you refactor apply semantics, both call sites — the switcher hook and this `main.tsx` wiring — need to move together.

## Anti-patterns

```typescript
// ❌ Enabling a Shape's extensions at install time.
await extensionManager.enable(id); // in install-shape.ts activate()
// ✅ Install stages only. Extensions are enabled by applyShape, so installing
//    several Shapes never piles their extensions on at once.

// ❌ Deciding a schedule is a Shape's by its name (or name + unbound).
if (task.name === schedule.name && task.agentId === null) delete task;
// ✅ Gate on the provenance marker for THIS shape. A user can create a global
//    schedule with a colliding name; name is never proof of ownership.
const origin = await readShapeOrigin(task.filePath);
if (origin === shapeName) teardown(task);

// ❌ Checking schedule existence by name + target.
schedules.find((s) => s.name === slug && s.agentId === agentId);
// ✅ Check by slug across ALL scopes. The target flips global → agent between
//    applies; a per-target check misses the earlier global copy and duplicates it.
existingByName.get(slugify(schedule.name));

// ❌ Deleting a non-active Shape's extensions on uninstall.
for (const id of manifest.activates) await extensionManager.disable(id);
// ✅ Only the ACTIVE shape's extensions were turned on by its apply. Disable them
//    on uninstall only when getActiveShapeName() === shapeName.
```

## Testing

Every seam has a co-located suite. The pure engines run against fakes; the flows run against a temp `dorkHome`.

| Suite                                                                           | Covers                                                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/shapes/__tests__/apply-shape.test.ts`                 | Apply: fatal-vs-degrade, extension swap, schedule create/re-bind/reconcile, offers, active write, slug keying. |
| `apps/server/src/services/shapes/__tests__/shape-schedule-service.test.ts`      | File-first create, provenance stamping, `readShapeOrigin` fail-closed, re-bind move, teardown.                 |
| `apps/server/src/services/shapes/__tests__/rebind-schedules.test.ts`            | Agent-create seam: matchName + marker + still-global gating; user/other-Shape schedules untouched.             |
| `apps/server/src/services/marketplace/__tests__/flows/install-shape.test.ts`    | Stage-not-activate; no extension enable at install.                                                            |
| `apps/server/src/services/marketplace/__tests__/flows/uninstall.test.ts`        | Teardown: schedules always, extensions + active-clear only when active, `deactivateShape: false` suppression.  |
| `apps/server/src/services/marketplace/__tests__/flows/update.test.ts`           | Advisory-by-default; apply → replace path.                                                                     |
| `apps/server/src/routes/__tests__/shapes.test.ts`                               | Route wiring, slug validation, 404 mapping.                                                                    |
| `apps/client/src/layers/features/shapes/__tests__/ShapeSwitcherDialog.test.tsx` | Single apply surface, arrival offer + schedule-summary line, focus highlight, degradation notes.               |
| `apps/client/src/layers/entities/shapes/__tests__/apply-shape-*.test.ts`        | The reusable apply action + client-side layout apply.                                                          |

```bash
pnpm vitest run apps/server/src/services/shapes                         # apply + schedule + re-bind
pnpm vitest run apps/server/src/services/marketplace/__tests__/flows    # install-shape, uninstall, update
pnpm vitest run apps/client/src/layers/features/shapes                  # switcher
```
