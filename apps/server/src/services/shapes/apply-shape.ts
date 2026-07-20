/**
 * Apply-shape service (DOR-355, spec §5).
 *
 * Applying a Shape changes *what DorkOS is for you right now*: it enables the
 * Shape's extensions, resolves its connections, stands up its schedules, offers
 * its agents (never forces one — affinity, not ownership), returns the chrome
 * the client should restore, and records the Shape as active.
 *
 * The single hard failure is "Shape not installed" ({@link ShapeNotInstalledError});
 * every other missing piece degrades to a `warnings[]` entry and a still-`ok`
 * result, mirroring the per-runtime degradation model (ADR-0310). The return
 * value is the exact `POST /api/shapes/:name/apply` response body (spec §9): the
 * `applied` field carries the resolved chrome + outcomes so the client acts
 * without a second fetch.
 *
 * The service is pure and fully injected — every collaborator is a structural
 * interface, so it is exercised with lightweight fakes (no disk, no config
 * singleton, no scheduler). The concrete wiring lives in the routes layer.
 *
 * @module services/shapes/apply-shape
 */
import type { ShapePackageManifest } from '@dorkos/marketplace';
import type { ShapeUserPrefs } from '@dorkos/shared/config-schema';
import { describeCronSchedule } from '@dorkos/shared/cron';
import type { CreateTaskRequest } from '@dorkos/shared/schemas';
import { slugify } from '@dorkos/skills/slug';

/** A single agents[] entry as declared on a Shape manifest. */
type ShapeAgentEntry = ShapePackageManifest['agents'][number];

/** The resolved workspace chrome a Shape restores (spec §2 `ShapeLayoutSchema`). */
export type ShapeLayout = ShapePackageManifest['layout'];

/**
 * Thrown when {@link applyShape} is asked to apply a Shape that is not
 * installed. This is the ONLY fatal case (spec §7); the routes layer maps it to
 * a 404. Every other missing piece degrades to a warning.
 */
export class ShapeNotInstalledError extends Error {
  /**
   * Build the not-installed error for a Shape name.
   *
   * @param shapeName - The Shape name that could not be resolved on disk.
   */
  constructor(public readonly shapeName: string) {
    super(`Shape '${shapeName}' is not installed`);
    this.name = 'ShapeNotInstalledError';
  }
}

/**
 * An agent a Shape surfaces on arrival. Agents are *offered*, never
 * auto-created — a Shape holds agents by affinity, not ownership. An unsatisfied
 * entry is a scaffold offer (`template` carries the seed); a satisfied `default`
 * entry is the highlighted arrival offer, and `autoFollow` asks the client to
 * switch into it when the user opted in (`ui.shapes.autoFollowAgent`).
 */
export interface OfferedAgent {
  /** The Shape-local agent slug (`agents[].ref`). */
  ref: string;
  /** Soft affinity — `default` is the arrival offer, `suggested` is listed only. */
  affinity: ShapeAgentEntry['affinity'];
  /** True when an existing agent already satisfies this entry (`matchName` hit). */
  satisfied: boolean;
  /** The highlighted arrival offer (the single satisfied-or-offered `default`). */
  arrival: boolean;
  /** Ask the client to `switch_agent` into this agent (satisfied default + opt-in). */
  autoFollow: boolean;
  /** Resolved agent id, when satisfied. */
  agentId?: string;
  /** Resolved agent project path, when satisfied. */
  projectPath?: string;
  /** Display name for the offer card (template display name, `matchName`, or `ref`). */
  displayName: string;
  /** Scaffold seed for an unsatisfied offer (the manifest's `template`). */
  template?: ShapeAgentEntry['template'];
  /**
   * Human cadence line for the offer card ("Every weekday at 9:00 AM"),
   * derived from the first of this Shape's schedules bound to the agent
   * (`agentRef`) whose cron the shared describer recognizes. Absent when the
   * Shape declares no schedule for the agent or none is describable — the
   * offer card only claims a cadence that is real.
   */
  scheduleSummary?: string;
}

/**
 * The resolved outcome the client needs to act on without a second fetch — the
 * `applied` field of the apply response.
 */
export interface AppliedShape {
  /** The chrome to restore (sidebar, panels, dashboard focus). */
  layout: ShapeLayout;
  /** Extension ids actually enabled this apply (post-degradation). */
  activatedExtensions: string[];
  /**
   * Extension ids turned OFF this apply because they belonged to the outgoing
   * Shape's `activates` set and this Shape does not declare them — the swap that
   * keeps switching Shapes from piling every Shape's extensions on. Empty when
   * no Shape was active, the same Shape is re-applied, or the two sets fully
   * overlap.
   *
   * Caveat: a Shape owns its declared extension set for this swap. An extension
   * the user enabled by hand that happens to sit in the outgoing Shape's
   * `activates` is indistinguishable from one that Shape turned on, so the swap
   * may disable it. Accepted rather than tracking per-extension provenance.
   */
  deactivatedExtensions: string[];
  /** Schedule names created this apply (idempotent skips are excluded). */
  schedulesCreated: string[];
  /**
   * Schedule names re-bound to a now-present agent this apply. A schedule an
   * earlier apply created global/disabled (its agent was missing, §7) is
   * re-targeted to the agent and enabled once that agent exists. Idempotent: a
   * schedule that is already agent-bound is never re-bound again, so a user who
   * disabled their own bound schedule keeps that choice.
   */
  schedulesRebound: string[];
  /**
   * Schedule names deleted this apply because an earlier version of THIS Shape
   * created them but the current manifest no longer declares them (a rename or
   * drop between versions). Provenance-gated to this Shape and swept across both
   * global and agent-bound scopes; a user's own schedule and another Shape's are
   * never touched. This is what stops a v1 schedule from lingering after a v2
   * update.
   */
  schedulesRemoved: string[];
}

/** The full result of {@link applyShape} — also the `POST /api/shapes/:name/apply` body. */
export interface ApplyShapeResult {
  ok: boolean;
  applied: AppliedShape;
  warnings: string[];
  offeredAgents: OfferedAgent[];
}

/**
 * Loads an installed Shape's manifest from disk. Returns `null` when the Shape
 * is not installed (the fatal case).
 */
export interface ShapeManifestResolverLike {
  /**
   * @param name - Installed Shape name.
   * @returns The parsed manifest, or `null` when the Shape is not installed.
   */
  resolve(name: string): Promise<ShapePackageManifest | null>;
}

/**
 * The subset of the extension manager the apply flow needs: enable an extension
 * (returns `null` when it is not discoverable or failed to compile) and look one
 * up to read its declared secrets.
 */
export interface ShapeExtensionManagerLike {
  /**
   * @param id - Extension id.
   * @returns The extension record (for its declared secrets), or `undefined`.
   */
  get(
    id: string
  ): { manifest: { serverCapabilities?: { secrets?: { key: string }[] } } } | undefined;
  /**
   * @param id - Extension id to enable.
   * @returns A truthy result when enabled, or `null` when the id is not
   *   discoverable / not compilable.
   */
  enable(id: string): Promise<{ reloadRequired: boolean } | null>;
  /**
   * Turn an extension off — the reverse of {@link enable}, used when a Shape
   * swap turns off the outgoing Shape's extensions.
   *
   * @param id - Extension id to disable.
   * @returns Any result; the apply flow ignores it (best-effort teardown).
   */
  disable(id: string): Promise<unknown>;
}

/** Checks whether an extension's declared secret already has a value. */
export interface ShapeSecretCheckerLike {
  /**
   * @param extensionId - Extension that declares the secret.
   * @param key - Secret key.
   * @returns Whether a value is set (never returns the value itself).
   */
  isSet(extensionId: string, key: string): Promise<boolean>;
}

/** A lightweight view of a registered agent, used to satisfy `matchName`. */
export interface RegisteredAgentView {
  id: string;
  name: string;
  displayName?: string;
  projectPath: string;
}

/** Lists registered agents so `matchName` can resolve against them. */
export interface ShapeAgentRegistryLike {
  /** @returns Every registered agent with its resolved project path. */
  listWithPaths(): RegisteredAgentView[];
}

/**
 * A minimal view of an existing schedule, keyed by its cross-scope identity
 * (its name). Two facts gate the re-bind flow:
 *
 * - `agentId === null` — the schedule is global (unbound). A *Shape* schedule
 *   is only ever global when its target agent was absent at apply time (§7).
 * - `shapeOrigin` — the provenance marker stamped into the schedule file at
 *   creation (`origin: shape` + `shape: <name>` frontmatter). A user can
 *   create their own global schedule with a colliding name via the tasks API,
 *   so name + unbound alone is NOT proof a schedule belongs to a Shape —
 *   re-bind requires the marker too, and never touches user-created schedules.
 */
export interface ExistingSchedule {
  /** The schedule name — its identity across every scope. */
  name: string;
  /** The bound agent id, or `null` when the schedule is global (unbound). */
  agentId: string | null;
  /** Whether the schedule is currently enabled. */
  enabled: boolean;
  /**
   * The name of the Shape that created this schedule, read from the schedule
   * file's provenance marker — or `null` when the schedule carries no marker
   * (user-created) or is agent-bound (re-bind never considers those, so the
   * service may skip reading their files).
   */
  shapeOrigin: string | null;
}

/** Provenance stamped into a schedule created by a Shape apply. */
export interface ScheduleOrigin {
  /** The Shape (package name) standing this schedule up. */
  shape: string;
}

/** How a global (unbound) schedule is re-bound to a now-present agent. */
export interface ScheduleRebind {
  /** The agent id to re-target the schedule to. */
  agentId: string;
  /** Whether the schedule is enabled once bound (mirrors `!startDisabled`). */
  enabled: boolean;
}

/**
 * Creates and re-binds schedules idempotently. Existence is checked by schedule
 * NAME across every scope (global + all agents) — never by name + target —
 * because a Shape schedule's target legitimately flips between applies: the
 * first apply may create it globally-disabled (agent missing, §7), and once the
 * offered agent exists a re-apply (or the agent's creation) re-targets the same
 * schedule to the agent's id and enables it. A per-target check would miss the
 * earlier copy and create a duplicate.
 */
export interface ShapeScheduleServiceLike {
  /**
   * @returns Every existing schedule (name + binding + enabled + provenance),
   *   across all scopes (global + agents).
   */
  listSchedules(): Promise<ExistingSchedule[]> | ExistingSchedule[];
  /**
   * @param req - The task-creation request built from a Shape schedule.
   * @param origin - Provenance to stamp into the schedule file (`origin: shape`
   *   + `shape: <name>`) — the marker the re-bind flow later gates on.
   */
  createSchedule(req: CreateTaskRequest, origin?: ScheduleOrigin): Promise<void>;
  /**
   * Re-target a global (unbound) schedule to a now-present agent and set its
   * enabled state — the second half of the global → agent flip. A no-op when
   * the named schedule is absent, already agent-bound (so an explicitly
   * user-disabled bound schedule is never force-enabled), or missing the Shape
   * provenance marker (so a user's own global schedule with a colliding name
   * is never hijacked).
   *
   * @param name - The existing schedule's name.
   * @param rebind - The agent id to bind to and the resulting enabled state.
   */
  rebindSchedule(name: string, rebind: ScheduleRebind): Promise<void>;
  /**
   * Delete every schedule stamped with this Shape's provenance marker
   * (`origin: shape` + `shape: <shapeName>`), across both global and
   * agent-bound scopes. Full teardown per schedule — file, task-store row, and
   * scheduler registration — so nothing keeps firing after its Shape is gone.
   * Fail-closed: a schedule whose marker is missing, unreadable, or names a
   * different Shape is left untouched, so a user's own schedule that collides on
   * name is never deleted.
   *
   * @param shapeName - The owning Shape whose schedules to delete.
   * @param keepNames - When given, schedules whose name is in this set are
   *   spared — the apply reconciliation passes the Shape's currently-declared
   *   names so only renamed/dropped schedules are removed. These must be STORED
   *   names (i.e. `slugify`'d), the same form schedules are created under, so a
   *   manifest that declares "Inbox Tick" (stored "inbox-tick") is matched.
   *   Omit to delete every one of this Shape's schedules (the uninstall teardown).
   * @returns The names of the schedules deleted.
   */
  deleteSchedulesForShape(shapeName: string, keepNames?: ReadonlySet<string>): Promise<string[]>;
}

/**
 * Reads the person-scoped Shape prefs and records the active Shape. Writes are
 * whole-object per section (deepMerge replaces arrays), preserving
 * `agentDefaults`/`autoFollowAgent`.
 */
export interface ShapeConfigStoreLike {
  /** @returns The current `ui.shapes` prefs. */
  getShapePrefs(): ShapeUserPrefs;
  /**
   * @param name - The Shape name to record as active.
   */
  setActiveShape(name: string): void;
}

/** Injected collaborators for {@link applyShape}. */
export interface ApplyShapeDeps {
  manifestResolver: ShapeManifestResolverLike;
  extensionManager: ShapeExtensionManagerLike;
  secretChecker: ShapeSecretCheckerLike;
  agentRegistry: ShapeAgentRegistryLike;
  scheduleService: ShapeScheduleServiceLike;
  configStore: ShapeConfigStoreLike;
}

/** The sentinel `target` for a schedule not bound to a concrete agent. */
const GLOBAL_TARGET = 'global';

/**
 * Apply an installed Shape. Idempotent: applying the same Shape twice enables
 * the same extensions, creates no duplicate schedules, offers the same agents,
 * and leaves identical config.
 *
 * @param name - The installed Shape name to apply.
 * @param deps - Injected collaborators.
 * @returns The apply result (`{ ok, applied, warnings, offeredAgents }`).
 * @throws {ShapeNotInstalledError} When the Shape is not installed (the only fatal case).
 */
export async function applyShape(name: string, deps: ApplyShapeDeps): Promise<ApplyShapeResult> {
  // Step 1 — Resolve the installed manifest. Missing is the ONLY fatal case.
  const manifest = await deps.manifestResolver.resolve(name);
  if (!manifest) {
    throw new ShapeNotInstalledError(name);
  }

  const warnings: string[] = [];

  // Step 2a — Swap out the outgoing Shape's extensions. Applying a Shape is a
  // *swap*, not an accumulation: first turn OFF the extensions the currently
  // active Shape turned ON that this Shape does not also declare, so switching
  // between Shapes never leaves every Shape's extensions piled on (the design
  // intent stated in flows/install-shape.ts). The active pointer still names the
  // outgoing Shape here — Step 8 overwrites it — so read it now. An extension in
  // BOTH sets stays enabled untouched (no disable/enable flap).
  //
  // CAVEAT: a Shape "owns" its declared extension set for the purpose of this
  // swap. We cannot distinguish an extension the user enabled by hand that
  // happens to sit in the outgoing Shape's `activates` from one the Shape turned
  // on, so a swap may disable such an overlap. We accept that rather than track
  // per-extension provenance.
  const deactivatedExtensions: string[] = [];
  const previousActive = deps.configStore.getShapePrefs().active;
  if (previousActive && previousActive !== name) {
    const outgoing = await deps.manifestResolver.resolve(previousActive);
    // A no-longer-installed outgoing Shape yields a null manifest — its declared
    // set is unknown, so leave every extension alone rather than guess.
    if (outgoing) {
      const incoming = new Set(manifest.activates);
      for (const id of outgoing.activates) {
        if (incoming.has(id)) continue; // in both sets → stays on, no flap
        await deps.extensionManager.disable(id);
        deactivatedExtensions.push(id);
      }
    }
  }

  // Step 2b — Activate extensions. A non-discoverable id skips + warns; a present
  // id that will not enable (invalid / failed to compile) skips + warns too.
  const activatedExtensions: string[] = [];
  for (const id of manifest.activates) {
    if (!deps.extensionManager.get(id)) {
      warnings.push(`Extension '${id}' not found; install it to complete this Shape`);
      continue;
    }
    const enabled = await deps.extensionManager.enable(id);
    if (!enabled) {
      warnings.push(`Extension '${id}' failed to compile`);
      continue;
    }
    activatedExtensions.push(id);
  }

  // Step 3 — Connections. Nothing here blocks the apply.
  for (const connection of manifest.connections) {
    if (connection.kind === 'extension-secret') {
      const alreadySet = await deps.secretChecker.isSet(connection.extension, connection.secret);
      if (!alreadySet) {
        warnings.push(
          `Connection '${connection.secret}' for '${connection.extension}' needs setup`
        );
      }
    } else {
      // mcp-server: connections are declarations today (Assumption A4) — there
      // is nothing to verify, so surface the setup hint unconditionally.
      warnings.push(`MCP server '${connection.server}' not configured`);
    }
  }

  // Resolve each Shape agent (by matchName) up front — schedules bind to these.
  const agents = manifest.agents.map((agent) => ({
    entry: agent,
    match: resolveAgentMatch(agent, deps.agentRegistry.listWithPaths()),
  }));
  const agentByRef = new Map(agents.map((a) => [a.entry.ref, a] as const));

  // Step 4 — Schedules. Bind each to its agent (via agentRef); a missing agent
  // yields a disabled schedule + warning. Idempotent by NAME across all scopes:
  // the target flips 'global' → agentId once an offered agent appears, so a
  // per-target existence check would miss the earlier global copy and create a
  // duplicate on re-apply (plus an orphaned disabled global schedule). When the
  // earlier global copy IS found and its agent now exists, re-bind it (§7's
  // promised flip) instead of skipping.
  const existingByName = new Map(
    (await deps.scheduleService.listSchedules()).map((s) => [s.name, s] as const)
  );
  const schedulesCreated: string[] = [];
  const schedulesRebound: string[] = [];
  for (const schedule of manifest.schedules) {
    const resolved = agentByRef.get(schedule.agentRef);
    const match = resolved?.match ?? null;
    const target = match ? match.id : GLOBAL_TARGET;
    const enabled = match !== null && !schedule.startDisabled;

    // Schedules are stored under `slugify(name)` — `createSchedule` and the
    // tasks router both do this — so `listSchedules` returns slugs and the
    // re-bind service finds a schedule by its stored slug. Match on the slug,
    // not the raw manifest name, or a non-kebab name ("Inbox Tick") never lines
    // up with its stored form ("inbox-tick"): the existence check misses, the
    // global→agent flip silently never fires, and the reconciliation below
    // spares the lingering disabled global copy (its slug is in the kept set).
    // `slugify` is idempotent on already-kebab names, so this is a no-op there.
    const storedName = slugify(schedule.name);
    const existing = existingByName.get(storedName);
    if (existing) {
      // A schedule with this name already exists (possibly created
      // globally-disabled by an earlier apply of THIS Shape, when its agent was
      // missing). If the agent is now present, the schedule is still unbound
      // (global), and its provenance marker names this Shape, re-target it to
      // the agent and enable it (unless the manifest starts it disabled). An
      // already-bound schedule is left untouched — a user who disabled their
      // own bound schedule keeps that choice — and a global schedule WITHOUT
      // this Shape's provenance (a user's own, or another Shape's) is never
      // touched: a name collision must not hijack it.
      if (match && existing.agentId === null && existing.shapeOrigin === name) {
        const rebindEnabled = !schedule.startDisabled;
        await deps.scheduleService.rebindSchedule(storedName, {
          agentId: match.id,
          enabled: rebindEnabled,
        });
        existingByName.set(storedName, {
          name: storedName,
          agentId: match.id,
          enabled: rebindEnabled,
          shapeOrigin: name,
        });
        schedulesRebound.push(schedule.name);
      }
      continue;
    }

    if (!match) {
      warnings.push(
        `Schedule '${schedule.name}' created disabled — agent '${schedule.agentRef}' missing`
      );
    }

    const request: CreateTaskRequest = {
      name: schedule.name,
      description: schedule.description,
      prompt: schedule.prompt,
      cron: schedule.cron,
      timezone: schedule.timezone,
      target,
      enabled,
      permissionMode: schedule.permissionMode,
    };
    await deps.scheduleService.createSchedule(request, { shape: name });
    existingByName.set(storedName, {
      name: storedName,
      agentId: match ? match.id : null,
      enabled,
      shapeOrigin: name,
    });
    schedulesCreated.push(schedule.name);
  }

  // Step 4b — Reconcile away schedules this Shape no longer declares. An earlier
  // version of this Shape may have created a schedule the current manifest
  // renamed or dropped; the create/rebind loop above never removes anything, so
  // without this sweep a v1 schedule would keep firing alongside v2's. Delete
  // every schedule carrying THIS Shape's provenance marker whose name is not in
  // the currently-declared set — provenance-gated (a user's own and other
  // Shapes' schedules are safe) and swept across global + agent-bound scopes.
  // The names just created/rebound are the declared set, so they are kept.
  //
  // Match by the SLUG, not the raw manifest name: `createSchedule` stores a
  // schedule under `slugify(name)`, so a manifest that declares "Inbox Tick"
  // lands as "inbox-tick". Comparing raw names would miss it, and the sweep
  // would delete the very schedule this apply just created (`schedulesCreated`)
  // on every apply. `slugify` is idempotent on already-kebab names.
  const declaredScheduleNames = new Set(manifest.schedules.map((s) => slugify(s.name)));
  const schedulesRemoved = await deps.scheduleService.deleteSchedulesForShape(
    name,
    declaredScheduleNames
  );

  // Steps 5 + 7 — Agents (offer, never force) and the arrival agent.
  const autoFollowOptIn = deps.configStore.getShapePrefs().autoFollowAgent;
  const offeredAgents: OfferedAgent[] = [];
  for (const { entry, match } of agents) {
    const isDefault = entry.affinity === 'default';
    const displayName = entry.template?.displayName ?? entry.matchName ?? entry.ref;
    const scheduleSummary = summarizeAgentSchedule(manifest, entry.ref);

    if (!match) {
      // Absent — offered, never created. Affinity is soft, so nothing breaks.
      warnings.push(`Agent '${entry.ref}' not present — offered`);
      offeredAgents.push({
        ref: entry.ref,
        affinity: entry.affinity,
        satisfied: false,
        arrival: isDefault,
        autoFollow: false,
        displayName,
        template: entry.template,
        ...(scheduleSummary ? { scheduleSummary } : {}),
      });
      continue;
    }

    // Satisfied. A suggested agent already exists and needs no offer; only the
    // default agent is surfaced, as the highlighted arrival offer.
    if (!isDefault) continue;
    offeredAgents.push({
      ref: entry.ref,
      affinity: entry.affinity,
      satisfied: true,
      arrival: true,
      autoFollow: autoFollowOptIn,
      agentId: match.id,
      projectPath: match.projectPath,
      displayName,
      template: entry.template,
      ...(scheduleSummary ? { scheduleSummary } : {}),
    });
  }

  // Step 8 — Record the active Shape (whole-object write; preserves the rest).
  deps.configStore.setActiveShape(name);

  // Step 6 — Chrome is applied client-side from `applied.layout`.
  return {
    ok: true,
    applied: {
      layout: manifest.layout,
      activatedExtensions,
      deactivatedExtensions,
      schedulesCreated,
      schedulesRebound,
      schedulesRemoved,
    },
    warnings,
    offeredAgents,
  };
}

/**
 * Whether a Shape agent entry's `matchName` is satisfied by an agent's name or
 * display name (case-insensitive). The single match rule shared by the apply
 * flow ({@link resolveAgentMatch}) and the agent-create re-bind seam
 * (`rebindShapeSchedulesForAgent`), so both decide "does this agent satisfy this
 * Shape entry?" identically. Returns `false` when no `matchName` is declared.
 *
 * @param matchName - The Shape agent entry's `matchName`, if any.
 * @param agent - The candidate agent's name + optional display name.
 * @returns Whether the agent satisfies `matchName`.
 */
export function matchesAgentByName(
  matchName: string | undefined,
  agent: { name: string; displayName?: string }
): boolean {
  if (!matchName) return false;
  const needle = matchName.toLowerCase();
  return agent.name.toLowerCase() === needle || agent.displayName?.toLowerCase() === needle;
}

/**
 * Resolve a Shape agent to an existing registered agent by `matchName`
 * (case-insensitive against the agent's display name or slug). Returns `null`
 * when no `matchName` is declared or no agent matches.
 *
 * @param agent - The Shape agent entry to satisfy.
 * @param registered - Every registered agent.
 * @returns The matched agent view, or `null`.
 */
function resolveAgentMatch(
  agent: ShapeAgentEntry,
  registered: RegisteredAgentView[]
): RegisteredAgentView | null {
  if (!agent.matchName) return null;
  return registered.find((a) => matchesAgentByName(agent.matchName, a)) ?? null;
}

/**
 * Derive the human cadence line for an offered agent from the Shape's
 * schedules: the first schedule bound to the agent (`agentRef`) whose cron
 * the shared describer recognizes. Returns `null` when the Shape declares no
 * schedule for this agent or none is describable — the offer card then shows
 * no schedule line at all rather than a raw cron string. A declared timezone
 * is appended ("… (America/New_York)") so the time never silently reads as
 * the viewer's local hour.
 *
 * @param manifest - The Shape manifest being applied.
 * @param agentRef - The Shape-local agent slug to look up schedules for.
 * @returns The plain-language cadence, or `null`.
 */
function summarizeAgentSchedule(manifest: ShapePackageManifest, agentRef: string): string | null {
  for (const schedule of manifest.schedules) {
    // A null cron is a manual-only schedule — no cadence to describe.
    if (schedule.agentRef !== agentRef || schedule.cron === null) continue;
    const summary = describeCronSchedule(schedule.cron);
    if (!summary) continue;
    // A declared timezone qualifies the time — an unqualified "9:00 AM" would
    // read as the user's local time, which may be a different hour entirely.
    return schedule.timezone ? `${summary} (${schedule.timezone})` : summary;
  }
  return null;
}
