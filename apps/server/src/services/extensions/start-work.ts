/**
 * Starting work in a new chat (spec `flow-multiproject` §7.7; V7, N12, D13):
 * the one door behind `api.startWork` (`POST /api/extensions/:id/start-work`),
 * `ctx.sessions.start`, and the limits a `session_start` inside a started chat
 * counts against.
 *
 * An extension's button names an outcome ("Sort them"). One click starts the
 * work in a NEW chat in the project's root: the prompt goes through the turn
 * port (`services/runs`, spec `turns-survive-restarts` §3) as the chat's first
 * message, the chat gets the extension's title, and who started it and why is
 * kept in `session_started_by`, which the chat draws as its first line. The
 * current chat is never touched and nothing navigates.
 *
 * The answer comes at acceptance: the chat's id, before its turn starts. When
 * every launch slot under `runtimes.maxAgentChats` is taken the start is not
 * refused; its run waits for room (§3.5). The prompt and title are saved in
 * the start's own row (the run's `sourceRef`), so a restart before its turn is
 * handed to the agent hands it over again, and titles the chat once it starts;
 * both are let go when the run ends. What a start's run changing means here
 * (the row following a rebind, the title, a launch warning, forgetting a start
 * that never ran) is one watch registered at attach, keyed by the run's
 * source, so a restart in between loses none of it. An answered start can
 * still not run (a refusal at the door, a chat gone, its words lost); its
 * owner is told, once.
 *
 * ## The limits
 *
 * Per extension, counted across `api` and `ctx` together, and across every chat
 * whose chain of starters leads back to it (a chat's `session_start` inherits
 * its origin extension): at most {@link START_WORK_LIMITS.perHour} starts in a
 * rolling hour, and at most {@link START_WORK_LIMITS.running} of its chats
 * running a turn at once. The hourly count is read from the table, so a
 * restart does not reset it. "Running" means working or waiting: the live
 * projector's lifecycle, the starts this process is launching, and, read from
 * saved rows, its chats with a run that has not ended (a start waiting for a
 * launch slot or for a paused agent included), so neither a burst of clicks
 * nor a restart gets past it.
 *
 * The check and the row that claims the slot are written with no await
 * between them, so concurrent starts cannot overshoot either limit.
 *
 * @module services/extensions/start-work
 */
import type { TaskStore } from '../tasks/task-store.js';
import { scheduledOriginStamp } from '../tasks/agent-mode/agent-mode-run-origin.js';
import crypto from 'node:crypto';
import { StartWorkError } from '@dorkos/extension-api/server';
import type { ProjectInfo, ProjectRef } from '@dorkos/extension-api/server';
import {
  START_WORK_LIMITS,
  StartWorkRequestSchema,
  type StartWorkRequest,
  type StartWorkResponse,
} from '@dorkos/shared/extension-decision-schemas';
import { sessionPath } from '@dorkos/shared/session-link';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { logError, logger } from '../../lib/logger.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { ProjectRegistry } from '../projects/project-registry.js';
import {
  RUN_ENDS,
  TurnStartRefusedError,
  turnPort,
  type SpaceTurnPort,
  type TurnRun,
} from '../runs/index.js';
import { listProjectorStatuses } from '../session/session-state-projector.js';
import type {
  SessionStartedByStore,
  StartedByInsert,
} from '../session/origin/session-started-by-store.js';
import { checkStartWorkEligibility, type StartWorkEligibility } from './start-work-eligibility.js';

/** The source kind a start keeps its words under: its `session_started_by` row. */
const START_SOURCE = 'start-work';

/** How long the hourly limit looks back. */
const HOUR_MS = 60 * 60 * 1000;

/** How far back saved starts are read for the running count. */
const DAY_MS = 24 * HOUR_MS;

/** A projector lifecycle that means a turn is in flight. */
const RUNNING_LIFECYCLES = new Set(['streaming', 'blocked']);

/**
 * How a start arrived, which decides which projects it may name:
 *
 * - `api` — the extension's page, behind the person bar (`api.startWork`).
 *   The projects it may see, and the projects the person works in.
 * - `ctx` — the extension's server half, with no person (`ctx.sessions.start`).
 *   Only the projects it may see: ones holding a copy of it, or ones it reported.
 */
export type StartWorkVia = 'api' | 'ctx';

/** What the start-work seam needs. */
export interface StartWorkDeps {
  /** Where starts are kept and counted. */
  store: SessionStartedByStore;
  /** The project registry. Only read: a refused start must leave no `reported` row behind. */
  projects: Pick<ProjectRegistry, 'rootWithin' | 'listForExtension' | 'list'>;
  /** An extension's manifest name, or its id when it is not installed. */
  extensionName: (extensionId: string) => string;
  /** Activity, for the history line a start leaves. */
  activity?: Pick<ActivityService, 'emit'>;
  /** The account check; see `start-work-eligibility.ts`. */
  eligibility?: StartWorkEligibility;
  /** Clock. */
  now?: () => number;
  /** The sessions whose turn is in flight right now, by id (tests replace it). */
  runningSessionIds?: () => string[];
  /**
   * The task store, read at call time: a carry-over asks it whether the chat it
   * replaces was a finished run's (DOR-3703, MUST-F). With none, beats, stamps and
   * live runs still answer.
   */
  taskStore?: () => Pick<TaskStore, 'resolveTaskOrigins'> | undefined;
  /** The runtime a new chat starts on (tests replace it). */
  defaultRuntime?: () => string;
  /** Set a chat's title through its runtime (tests replace it). */
  rename?: (runtimeType: string, sessionId: string, title: string, cwd: string) => Promise<void>;
  /** The turn port's space face, read at call time; the server's own by default. */
  port?: () => SpaceTurnPort | undefined;
}

/** A claimed start slot: the row is written and counts until cancelled. */
export interface StartReservation {
  /** The chat's turn ended: it no longer counts as launching. */
  settle(): void;
  /** The launch never happened: forget the row entirely. */
  cancel(): void;
  /** The runtime settled on another id for the chat. */
  rekey(toId: string): void;
}

/** The chats this process launched whose first turn has not settled, by origin extension. */
type Launching = Map<string, string>;

/** The start-work seam. See the module documentation. */
export class StartWorkService {
  private readonly launching: Launching = new Map();
  /** The turn port this seam reads its starts from, once it has heard of one. */
  private attachedTo: SpaceTurnPort | undefined;
  /** Live runs whose launch warning is on the history already; let go at the run's end. */
  private readonly warned = new Set<string>();
  /** Runs whose title is being set right now, with whether it took. */
  private readonly titling = new Map<string, Promise<boolean>>();
  private readonly now: () => number;
  private readonly eligibility: StartWorkEligibility;
  private readonly runningSessionIds: () => string[];
  private readonly defaultRuntime: () => string;
  private readonly rename: NonNullable<StartWorkDeps['rename']>;

  /**
   * Build the seam.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: StartWorkDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.eligibility = deps.eligibility ?? checkStartWorkEligibility;
    this.runningSessionIds =
      deps.runningSessionIds ??
      (() =>
        listProjectorStatuses()
          .filter((entry) => RUNNING_LIFECYCLES.has(entry.status.lifecycle))
          .map((entry) => entry.sessionId));
    this.defaultRuntime = deps.defaultRuntime ?? (() => runtimeRegistry.getDefaultType());
    this.rename =
      deps.rename ??
      (async (runtimeType, sessionId, title, cwd) => {
        const runtime = runtimeRegistry.get(runtimeType);
        await runtime.renameSession(
          runtime.getInternalSessionId(sessionId) ?? sessionId,
          title,
          cwd
        );
      });
    this.attach();
  }

  /**
   * The turn port, with this seam reading its starts' words for it and
   * letting them go once their turn has them. Attached once, the first time
   * there is a port; a restart attaches again at boot, before the outbox runs,
   * so a start saved before it is handed over again.
   */
  private attach(): SpaceTurnPort | undefined {
    const port = (this.deps.port ?? turnPort)();
    if (!port || port === this.attachedTo) return port;
    this.attachedTo = port;
    // A start's row, by the chat its run is kept under now, else by the id it
    // was saved under (a rebind moves the row with the chat).
    const rowOf = (id: string, run: { sessionId: string }) =>
      this.deps.store.get(run.sessionId) ?? this.deps.store.get(id);
    port.registerSource(START_SOURCE, {
      read: (id, run) => rowOf(id, run)?.prompt ?? undefined,
      app: (id, run) => {
        const extensionId = rowOf(id, run)?.originExtensionId;
        return extensionId
          ? { extensionId, name: this.deps.extensionName(extensionId) }
          : undefined;
      },
      // A restart ended its turn before the agent read the prompt (spec
      // `turns-survive-restarts` §7.3): the prompt and title go, never replayed.
      forget: (id, run) => {
        const row = rowOf(id, run);
        if (row) this.deps.store.clearPrompt(row.sessionId);
      },
    });
    port.watch((run) => this.onStartRun(port, run));
    this.sweepWords(port);
    return port;
  }

  /**
   * At boot, let go of the words and title of every start no run still
   * needs them for: one killed before its run was saved, or after its run
   * ended but before its words were cleared. A run that has not ended keeps
   * them, since the next process hands it over again.
   */
  private sweepWords(port: SpaceTurnPort): void {
    for (const id of this.deps.store.withPrompt()) {
      const open = port
        .list(id)
        .some((run) => run.sourceRef?.startsWith(`${START_SOURCE}:`) && !RUN_ENDS.has(run.status));
      if (!open) this.deps.store.clearPrompt(id);
    }
  }

  /**
   * What a start's run changing means for the start, registered once and
   * keyed by the run's source, so a restart in between loses none of it: who
   * started the chat follows the chat to the id the runtime settled on; the
   * chat is titled once its turn has begun, on the runtime it runs on (a start
   * that waits or never runs leaves no titled empty chat); a launch warning
   * rides the start's history until every device shows the run's own (T3);
   * and at the run's end its words go, and a start that never ran is
   * forgotten, so it counts against no limit.
   *
   * @param port - The space face.
   * @param run - The run, as it reads now (any status, the first call included).
   */
  private onStartRun(port: SpaceTurnPort, run: TurnRun): void {
    const prefix = `${START_SOURCE}:`;
    if (!run.sourceRef?.startsWith(prefix) || run.status === 'queued') return;
    if (run.status === 'starting') return;
    const sourceId = run.sourceRef.slice(prefix.length);
    const row = this.deps.store.get(run.sessionId) ?? this.deps.store.get(sourceId);
    if (!row) return;
    if (row.sessionId !== run.sessionId) {
      this.deps.store.move(row.sessionId, run.sessionId);
      const origin = this.launching.get(row.sessionId);
      this.launching.delete(row.sessionId);
      if (origin !== undefined) this.launching.set(run.sessionId, origin);
    }
    const extensionId = row.originExtensionId ?? row.extensionId;
    const name = extensionId ? this.deps.extensionName(extensionId) : 'An app';
    if (run.status === 'started' || run.status === 'running') {
      if (run.warnings.length > 0 && !this.warned.has(run.id)) {
        this.warned.add(run.id);
        void this.deps.activity
          ?.emit({
            actorType: 'system',
            actorLabel: name,
            actorId: extensionId ?? 'unknown',
            category: 'agent',
            eventType: 'extension.session_warning',
            resourceType: 'session',
            resourceId: run.sessionId,
            ...(row.title ? { resourceLabel: row.title } : {}),
            summary: `${name}'s chat${row.title ? ` ${row.title}` : ''}: ${run.warnings.map((w) => w.message).join(' ')}`,
            linkPath: sessionPath({ session: run.sessionId }),
            metadata: { extensionId, warnings: run.warnings.map((w) => w.code) },
          })
          .catch((err: unknown) =>
            logger.warn('[start-work] could not record a start’s warning', logError(err))
          );
      }
      void this.tryTitle(port, run, row.title);
      return;
    }
    this.launching.delete(run.sessionId);
    this.warned.delete(run.id);
    if (run.startedAt === null) {
      // Never ran: forgotten, so it neither shows nor counts.
      this.deps.store.remove(run.sessionId);
      return;
    }
    // The words go now; the title once the last try at it is done: a try
    // still under way is waited for, and one that failed (its first try may
    // have found no transcript yet) is made again.
    this.deps.store.clearPrompt(run.sessionId, { keepTitle: true });
    const title = row.title;
    if (title === null) return;
    void (this.titling.get(run.id) ?? Promise.resolve(false))
      .then((took) => took || this.tryTitle(port, run, title))
      .finally(() => this.deps.store.clearTitle(run.sessionId));
  }

  /**
   * Set a start's chat title, on the runtime the run runs on. One try at a
   * time per run: a second ask while one is under way gets the same answer.
   *
   * @returns Whether the title took.
   */
  private tryTitle(port: SpaceTurnPort, run: TurnRun, title: string | null): Promise<boolean> {
    const inFlight = this.titling.get(run.id);
    if (inFlight) return inFlight;
    const cwd = port.cwdOf(run.id);
    if (title === null || cwd === undefined) return Promise.resolve(false);
    const trying = this.rename(run.runtime ?? this.defaultRuntime(), run.sessionId, title, cwd)
      .then(
        () => {
          this.deps.store.clearTitle(run.sessionId);
          return true;
        },
        (err: unknown) => {
          logger.info('[start-work] title not set yet; trying again when the turn ends', {
            sessionId: run.sessionId,
            ...logError(err),
          });
          return false;
        }
      )
      .finally(() => this.titling.delete(run.id));
    this.titling.set(run.id, trying);
    return trying;
  }

  /**
   * Start work in a new chat for an extension.
   *
   * @param extensionId - The extension starting it.
   * @param input - The project, prompt, title and reason.
   * @param via - Where the call came from; see {@link StartWorkVia}.
   * @param opts.permissionCeiling - The loosest level the chat's first turn may
   *   run at: the runtime's default when a person asked over Wi-Fi (DOR-3037).
   * @returns The new chat's id.
   * @throws StartWorkError when a rule refuses it, a paused agent included
   *   (nothing was started).
   * @throws StartWorkInputError when the input breaks a length rule.
   */
  async start(
    extensionId: string,
    input: unknown,
    via: StartWorkVia,
    opts: { permissionCeiling?: TurnPermissionCeiling } = {}
  ): Promise<StartWorkResponse> {
    const parsed = StartWorkRequestSchema.safeParse(input);
    if (!parsed.success) throw new StartWorkInputError(describeInputProblem(input));
    const request: StartWorkRequest = parsed.data;
    const name = this.deps.extensionName(extensionId);

    const project = await this.projectFor(extensionId, request.project, via);
    if (!project) {
      throw new StartWorkError(
        'not_a_project',
        `That folder isn't in a project ${name} can start work in. Choose a folder inside one of your projects.`
      );
    }

    const runtimeType = this.defaultRuntime();
    const eligible = this.eligibility({ project, runtime: runtimeType });
    if (!eligible.ok) throw new StartWorkError('account_not_allowed_here', eligible.message);

    // Attached before the start is saved: the boot sweep must not see it first.
    const door = this.attach();
    if (!door) throw new Error('DorkOS is still starting. Try again in a moment.');
    const sessionId = crypto.randomUUID();
    const claimed = this.reserve({
      sessionId,
      kind: 'extension',
      extensionId,
      startedBySessionId: null,
      originExtensionId: extensionId,
      reason: request.reason,
      // Saved with the start, so a restart before its turn hands it over
      // again and still titles its chat.
      prompt: request.prompt,
      title: request.title,
    });
    if (!claimed.ok) throw claimed.error;
    const reservation = claimed.reservation;
    let runId: string;
    try {
      ({ runId } = door.start({
        sessionId,
        cwd: project.root,
        content: request.prompt,
        origin: { kind: 'extension-start' },
        tier: 'owner',
        // The runtime the account rule above was checked for, by name.
        runtime: runtimeType,
        sourceRef: `${START_SOURCE}:${sessionId}`,
        // One honest line for the model, so it does not take the prompt for
        // the person's own words. It rides the context bag and is never drawn.
        seedContext: `This chat was started by the ${name} extension: ${request.reason}`,
        // A Wi-Fi sign-in's bound (DOR-3037), when a person asked from there.
        ...(opts.permissionCeiling !== undefined
          ? { permissionCeiling: opts.permissionCeiling }
          : {}),
      }));
    } catch (err) {
      reservation.cancel();
      // The door refuses a paused agent's start at once and keeps nothing; its
      // sentence names the agent ("Ana is paused.").
      if (err instanceof TurnStartRefusedError && err.reason === 'agent_paused') {
        throw new StartWorkError('agent_paused', `${err.message} Resume it, then try again.`);
      }
      throw err;
    }
    void this.deps.activity
      ?.emit({
        actorType: 'system',
        actorLabel: name,
        actorId: extensionId,
        category: 'agent',
        eventType: 'extension.session_started',
        resourceType: 'session',
        resourceId: sessionId,
        resourceLabel: request.title,
        summary: `${name} asked to start a chat in ${project.name}: ${request.title}`,
        linkPath: sessionPath({ session: sessionId }),
        metadata: { extensionId, project: project.root, via, reason: request.reason, runId },
      })
      .catch((err: unknown) =>
        logger.warn('[start-work] could not record a started chat', logError(err))
      );

    return { sessionId };
  }

  /**
   * Claim a start slot and write the start, or refuse it. Synchronous from the
   * count to the insert, so two starts racing for the last slot cannot both
   * get it. A start whose chain reaches no extension counts against nothing.
   *
   * @param start - The start, without its time.
   */
  reserve(
    start: Omit<StartedByInsert, 'createdAt'>
  ): { ok: true; reservation: StartReservation } | { ok: false; error: StartWorkError } {
    const origin = start.originExtensionId;
    // A move replaces one chat with one successor and adds no work, so it is
    // never refused; it still registers as launching below, so it counts as
    // running while its turn is live.
    if (origin !== null && !start.carried) {
      const refusal = this.limitRefusal(origin);
      if (refusal) return { ok: false, error: refusal };
    }
    this.deps.store.insert({ ...start, createdAt: new Date(this.now()).toISOString() });
    let id = start.sessionId;
    if (origin !== null) this.launching.set(id, origin);
    const reservation: StartReservation = {
      settle: () => {
        this.launching.delete(id);
      },
      cancel: () => {
        this.launching.delete(id);
        this.deps.store.remove(id);
      },
      rekey: (toId) => {
        this.deps.store.move(id, toId);
        const held = this.launching.get(id);
        this.launching.delete(id);
        id = toId;
        if (held !== undefined) this.launching.set(toId, held);
      },
    };
    return { ok: true, reservation };
  }

  /**
   * Whether an extension may start one more chat right now, as the refusal it
   * would get, or null.
   *
   * @param extensionId - The extension at the root of the chain.
   */
  limitRefusal(extensionId: string): StartWorkError | null {
    const name = this.deps.extensionName(extensionId);
    const since = new Date(this.now() - HOUR_MS).toISOString();
    if (this.deps.store.countSince(extensionId, since) >= START_WORK_LIMITS.perHour) {
      return new StartWorkError(
        'start_limit',
        `${name} has started a lot of chats in the last hour. Try again later.`
      );
    }
    if (this.runningCount(extensionId) >= START_WORK_LIMITS.running) {
      return new StartWorkError(
        'start_limit',
        `${name} already has ${START_WORK_LIMITS.running} chats working or waiting. Try again when one finishes.`
      );
    }
    return null;
  }

  /**
   * Whether a chat was started by this extension, or from one of its chats: a
   * `watch` on the inbox may point only at such a chat (§7.3).
   *
   * @param extensionId - The extension.
   * @param sessionId - The chat.
   */
  startedBy(extensionId: string, sessionId: string): boolean {
    return this.deps.store.get(sessionId)?.originExtensionId === extensionId;
  }

  /**
   * How many of an extension's chats are working or waiting to: the starts
   * this process is launching, the chats whose turn is running, and, from
   * saved rows, its chats of the last day with a run that has not ended (so a
   * restart does not reset the count).
   */
  private runningCount(extensionId: string): number {
    const running = new Set<string>();
    for (const [id, origin] of this.launching) if (origin === extensionId) running.add(id);
    const port = this.attach();
    if (port) {
      const since = new Date(this.now() - DAY_MS).toISOString();
      for (const id of this.deps.store.listSince(extensionId, since)) {
        if (port.list(id).some((run) => !RUN_ENDS.has(run.status))) running.add(id);
      }
    }
    const live = this.runningSessionIds().filter((id) => !running.has(id));
    for (const [id, record] of this.deps.store.getMany(live)) {
      if (record.originExtensionId === extensionId) running.add(id);
    }
    return running.size;
  }

  /**
   * The project a start names, when this extension may start work there. Only
   * projects core already knows can qualify, so the folder is resolved without
   * recording anything: a refused start leaves no `reported` row and spends
   * none of the extension's report slots.
   */
  private async projectFor(
    extensionId: string,
    folder: string,
    via: StartWorkVia
  ): Promise<ProjectRef | null> {
    const root = await this.deps.projects.rootWithin(folder).catch(() => null);
    if (!root || root === 'outside') return null;
    const toRef = (p: ProjectInfo): ProjectRef => ({ root: p.root, name: p.name });
    const scoped = await this.deps.projects.listForExtension(extensionId);
    const mine = scoped.find((p) => p.root === root);
    if (mine) return toRef(mine);
    if (via === 'api') {
      const theirs = (await this.deps.projects.list()).find((p) => p.root === root);
      if (theirs) return toRef(theirs);
    }
    return null;
  }

  /**
   * Claim a start slot for a chat started from another chat, recording who
   * started it. The new chat inherits the parent's origin extension, so it
   * counts against that extension's limits and is refused past them.
   *
   * - `session_start` passes its own `reason`, and records the parent whether
   *   or not an extension is at the root of its chain.
   *   It also records the level the new chat was granted and the calling
   *   chat's live level at that moment (spec `inherited-start-permission`).
   * - A carry-over to another account (`carry: true`) records only when the
   *   parent was itself started (the chat keeps its first line, its fold and
   *   its chain), and keeps the parent's reason and recorded levels. It is
   *   never refused by the limits and never counted in the hour; it counts as
   *   running, and its own `session_start` calls stay limited.
   *
   * @param opts - The new chat, its parent, how it was started, and at what level.
   */
  reserveFromChat(opts: {
    sessionId: string;
    parentSessionId: string;
    reason?: string | null;
    carry?: boolean;
    /** The mode the new chat was granted. */
    permissionMode?: string | null;
    /** The calling chat's live mode when it started the new one. */
    starterPermissionMode?: string | null;
    /** Whether the grant was the calling chat's level exactly, by declared level. */
    permissionSameAsStarter?: boolean | null;
    /** Whether the new chat reports back to its parent (default true). */
    reportBack?: boolean;
    /** The scheduled thing behind the calling chat, stamped on the new one (DOR-3703, ME). */
    scheduledOrigin?: 'run' | 'heartbeat' | null;
  }): { ok: true; reservation: StartReservation | null } | { ok: false; error: StartWorkError } {
    const parent = this.deps.store.get(opts.parentSessionId);
    // A run's or a beat's own chat has no row of its own, so a carry-over asks what
    // it was: the new chat is the same work, and counts as it did (DOR-3703, MUST-F).
    const carriedOrigin = opts.carry
      ? (parent?.scheduledOrigin ??
        scheduledOriginStamp(opts.parentSessionId, this.deps.taskStore?.()))
      : null;
    // A person's own chat stays as it was: a row would give it a starter it never had.
    if (opts.carry && !parent && carriedOrigin === null) return { ok: true, reservation: null };
    return this.reserve({
      sessionId: opts.sessionId,
      kind: 'chat',
      extensionId: null,
      startedBySessionId: opts.parentSessionId,
      originExtensionId: parent?.originExtensionId ?? null,
      reason: opts.carry ? (parent?.reason ?? null) : (opts.reason ?? null),
      carried: opts.carry === true,
      permissionMode: opts.carry ? (parent?.permissionMode ?? null) : (opts.permissionMode ?? null),
      starterPermissionMode: opts.carry
        ? (parent?.starterPermissionMode ?? null)
        : (opts.starterPermissionMode ?? null),
      permissionSameAsStarter: opts.carry
        ? (parent?.permissionSameAsStarter ?? null)
        : (opts.permissionSameAsStarter ?? null),
      // A carry-over keeps whatever the chat it replaces was told.
      // A run's or a beat's chat takes no chat messages, so nothing reports to it.
      reportBack: opts.carry ? (parent?.reportBack ?? false) : (opts.reportBack ?? true),
      scheduledOrigin: opts.carry ? carriedOrigin : (opts.scheduledOrigin ?? null),
    });
  }

  /**
   * Write a chat DorkOS starts with nobody there and no chat behind it (the work
   * queue) as scheduled, whoever queued it (DOR-3703, MUST-G). It counts against
   * no extension's limits, and it has no starter to report to or show.
   *
   * @param sessionId - The new chat.
   */
  reserveUnattended(sessionId: string): StartReservation {
    const claimed = this.reserve({
      sessionId,
      kind: 'chat',
      extensionId: null,
      startedBySessionId: null,
      originExtensionId: null,
      reason: null,
      reportBack: false,
      scheduledOrigin: 'run',
    });
    // No origin extension, so `reserve` has no limit to refuse by.
    if (!claimed.ok) throw claimed.error;
    return claimed.reservation;
  }
}

/**
 * A start whose input broke a length rule. Its own class so the route answers
 * 400 for exactly this and nothing else: any other error is the server's.
 */
export class StartWorkInputError extends Error {
  /**
   * Refuse the input.
   *
   * @param message - What was wrong, in plain words.
   */
  constructor(message: string) {
    super(message);
    this.name = 'StartWorkInputError';
  }
}

/** The plain sentence for input that broke a rule. */
function describeInputProblem(input: unknown): string {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (!text(i.project)) return 'Say which project to start work in.';
  if (!text(i.prompt)) return 'Say what the new chat should do.';
  if (text(i.prompt).length > START_WORK_LIMITS.prompt)
    return `Keep what the chat is asked under ${START_WORK_LIMITS.prompt.toLocaleString('en-US')} characters.`;
  if (!text(i.title) || text(i.title).length > START_WORK_LIMITS.title)
    return `Give the chat a title of 1 to ${START_WORK_LIMITS.title} characters.`;
  if (!text(i.reason) || text(i.reason).length > START_WORK_LIMITS.reason)
    return `Say why in 1 to ${START_WORK_LIMITS.reason} characters.`;
  return 'Send a project, a prompt, a title and a reason.';
}

let current: StartWorkService | undefined;

/**
 * Wire the seam at boot (or clear it in a test).
 *
 * @param service - The seam, or undefined.
 */
export function setStartWorkService(service: StartWorkService | undefined): void {
  current = service;
}

/** The wired seam, or undefined before boot. */
export function getStartWorkService(): StartWorkService | undefined {
  return current;
}
