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
 * refused; its run waits for room (§3.5). The prompt is held in this process
 * until the turn starts, so a restart in between cancels the run, and the
 * chat stays empty, rather than run it twice.
 *
 * ## The limits
 *
 * Per extension, counted across `api` and `ctx` together, and across every chat
 * whose chain of starters leads back to it (a chat's `session_start` inherits
 * its origin extension): at most {@link START_WORK_LIMITS.perHour} starts in a
 * rolling hour, and at most {@link START_WORK_LIMITS.running} of its chats
 * running a turn at once. The hourly count is read from the table, so a
 * restart does not reset it. "Running" is the live projector's lifecycle, plus
 * the starts this process has launched whose first turn has not settled yet:
 * a turn that has been triggered but not yet reported `streaming` is running
 * too, or a burst of clicks would all pass.
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
import { turnPort, type SpaceTurnPort } from '../runs/index.js';
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
    port.registerSource(START_SOURCE, {
      read: (id) => this.deps.store.get(id)?.prompt ?? undefined,
      app: (id) => {
        const extensionId = this.deps.store.get(id)?.originExtensionId;
        return extensionId
          ? { extensionId, name: this.deps.extensionName(extensionId) }
          : undefined;
      },
    });
    port.watch((run) => {
      const prefix = `${START_SOURCE}:`;
      if (!run.sourceRef?.startsWith(prefix)) return;
      // Kept until the runtime has the words, or the start will never run.
      if (run.status === 'queued' || run.status === 'starting' || run.status === 'started') return;
      this.deps.store.clearPrompt(run.sourceRef.slice(prefix.length));
      this.deps.store.clearPrompt(run.sessionId);
    });
    return port;
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
   * @throws StartWorkError when a rule refuses it (nothing was started).
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

    const sessionId = crypto.randomUUID();
    const claimed = this.reserve({
      sessionId,
      kind: 'extension',
      extensionId,
      startedBySessionId: null,
      originExtensionId: extensionId,
      reason: request.reason,
      // Saved with the start, so a restart before its turn hands it over again.
      prompt: request.prompt,
    });
    if (!claimed.ok) throw claimed.error;
    const reservation = claimed.reservation;

    const door = this.attach();
    if (!door) {
      reservation.cancel();
      throw new Error('DorkOS is still starting. Try again in a moment.');
    }
    let runId: string;
    try {
      ({ runId } = door.start({
        sessionId,
        cwd: project.root,
        content: request.prompt,
        origin: { kind: 'extension-start' },
        tier: 'owner',
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
      throw err;
    }
    // The title goes on now when the chat can take it, else once its first
    // turn ends (a runtime whose transcript does not exist until then).
    let titled = false;
    let warned = false;
    let chatId: string = sessionId;
    const emit = (eventType: string, note?: string) =>
      void this.deps.activity
        ?.emit({
          actorType: 'system',
          actorLabel: name,
          actorId: extensionId,
          category: 'agent',
          eventType,
          resourceType: 'session',
          resourceId: chatId,
          resourceLabel: request.title,
          summary: note
            ? `${name}'s chat ${request.title}: ${note}`
            : `${name} started a chat in ${project.name}: ${request.title}`,
          linkPath: sessionPath({ session: chatId }),
          metadata: { extensionId, project: project.root, via, reason: request.reason },
        })
        .catch((err: unknown) =>
          logger.warn('[start-work] could not record a started chat', logError(err))
        );
    const title = (id: string, runtime: string) =>
      this.rename(runtime, id, request.title, project.root).then(() => {
        titled = true;
      });
    const stop = door.watch(
      (run) => {
        if (run.status === 'starting' || run.status === 'queued') return;
        // The runtime may have settled on another id for the new chat.
        if (run.sessionId !== chatId) {
          reservation.rekey(run.sessionId);
          chatId = run.sessionId;
        }
        if (run.status === 'started' || run.status === 'running') {
          // A warning the launch owes the person rides the start's history
          // until every device shows the run's own (T3).
          if (!warned && run.warnings.length > 0) {
            warned = true;
            emit('extension.session_warning', run.warnings.map((w) => w.message).join(' '));
          }
          return;
        }
        stop();
        // A start that never reached its turn counts against no limit.
        if (run.startedAt === null) {
          reservation.cancel();
          return;
        }
        reservation.settle();
        if (titled) return;
        title(run.sessionId, run.runtime ?? runtimeType).catch((err: unknown) =>
          logger.warn('[start-work] could not set the title of a started chat', {
            sessionId: run.sessionId,
            ...logError(err),
          })
        );
      },
      { runId }
    );
    await title(sessionId, runtimeType).catch((err: unknown) =>
      logger.info('[start-work] title not set yet; retrying after the first turn', {
        sessionId,
        ...logError(err),
      })
    );
    emit('extension.session_started');

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
        `${name} already has ${START_WORK_LIMITS.running} chats working. Try again when one finishes.`
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

  /** How many of an extension's chats are running a turn now. */
  private runningCount(extensionId: string): number {
    const running = new Set<string>();
    for (const [id, origin] of this.launching) if (origin === extensionId) running.add(id);
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
