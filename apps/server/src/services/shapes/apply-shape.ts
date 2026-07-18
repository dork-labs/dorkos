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
import type { CreateTaskRequest } from '@dorkos/shared/schemas';

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
  /** Schedule names created this apply (idempotent skips are excluded). */
  schedulesCreated: string[];
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
 * Creates schedules idempotently (by name + target). `target` is a concrete
 * agent id or the sentinel `'global'`.
 */
export interface ShapeScheduleServiceLike {
  /**
   * @param target - Agent id or `'global'`.
   * @returns The names of schedules already present for that target.
   */
  existingScheduleNames(target: string): Promise<string[]> | string[];
  /**
   * @param req - The task-creation request built from a Shape schedule.
   */
  createSchedule(req: CreateTaskRequest): Promise<void>;
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

  // Step 2 — Activate extensions. A non-discoverable id skips + warns; a present
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
  // yields a disabled schedule + warning. Idempotent by name + target.
  const schedulesCreated: string[] = [];
  for (const schedule of manifest.schedules) {
    const resolved = agentByRef.get(schedule.agentRef);
    const match = resolved?.match ?? null;
    const target = match ? match.id : GLOBAL_TARGET;
    const agentPresent = match !== null;
    const enabled = agentPresent && !schedule.startDisabled;

    if (!agentPresent) {
      warnings.push(
        `Schedule '${schedule.name}' created disabled — agent '${schedule.agentRef}' missing`
      );
    }

    const existing = await deps.scheduleService.existingScheduleNames(target);
    if (existing.includes(schedule.name)) {
      // Idempotent no-op: an identically-named schedule already exists here.
      continue;
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
    await deps.scheduleService.createSchedule(request);
    schedulesCreated.push(schedule.name);
  }

  // Steps 5 + 7 — Agents (offer, never force) and the arrival agent.
  const autoFollowOptIn = deps.configStore.getShapePrefs().autoFollowAgent;
  const offeredAgents: OfferedAgent[] = [];
  for (const { entry, match } of agents) {
    const isDefault = entry.affinity === 'default';
    const displayName = entry.template?.displayName ?? entry.matchName ?? entry.ref;

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
      schedulesCreated,
    },
    warnings,
    offeredAgents,
  };
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
  const needle = agent.matchName.toLowerCase();
  return (
    registered.find(
      (a) => a.name.toLowerCase() === needle || a.displayName?.toLowerCase() === needle
    ) ?? null
  );
}
