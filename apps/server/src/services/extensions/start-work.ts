/**
 * Starting work in a new chat (spec `flow-multiproject` §7.7; V7, N12, D13):
 * the one door behind `api.startWork` (`POST /api/extensions/:id/start-work`),
 * `ctx.sessions.start`, and the limits a `session_start` inside a started chat
 * counts against.
 *
 * An extension's button names an outcome ("Sort them"). One click starts the
 * work in a NEW chat in the project's root: the prompt is sent at once as the
 * chat's first message, the chat gets the extension's title, and who started
 * it and why is kept in `session_started_by`, which the chat draws as its first
 * line. The current chat is never touched and nothing navigates.
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
import crypto from 'node:crypto';
import { StartWorkError } from '@dorkos/extension-api/server';
import type { ProjectInfo, ProjectRef } from '@dorkos/extension-api/server';
import {
  START_WORK_LIMITS,
  StartWorkRequestSchema,
  type StartWorkRequest,
} from '@dorkos/shared/extension-decision-schemas';
import { sessionPath } from '@dorkos/shared/session-link';
import { logError, logger } from '../../lib/logger.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { ProjectRegistry } from '../projects/project-registry.js';
import {
  AGENT_LAUNCH_CAP_MESSAGE,
  dispatchSessionMessage,
  isSessionLaunchRefusal,
} from '../session/launch/launch-session.js';
import { listProjectorStatuses } from '../session/session-state-projector.js';
import type {
  SessionStartedByStore,
  StartedByRecord,
} from '../session/origin/session-started-by-store.js';
import { checkStartWorkEligibility, type StartWorkEligibility } from './start-work-eligibility.js';

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
  /** The runtime a new chat starts on (tests replace it). */
  defaultRuntime?: () => string;
  /** Set a chat's title through its runtime (tests replace it). */
  rename?: (runtimeType: string, sessionId: string, title: string, cwd: string) => Promise<void>;
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

/**
 * Run `rename`, and when it fails (a runtime whose transcript does not exist
 * until the turn writes it), once more when the first turn settles.
 */
async function renameNowOrLater(
  rename: () => Promise<void>,
  later: (retry: () => void) => void,
  sessionId: string
): Promise<void> {
  try {
    await rename();
  } catch (first) {
    logger.info('[start-work] title not set yet; retrying after the first turn', {
      sessionId,
      ...logError(first),
    });
    later(() => {
      rename().catch((err: unknown) =>
        logger.warn('[start-work] could not set the title of a started chat', {
          sessionId,
          ...logError(err),
        })
      );
    });
  }
}

/** The start-work seam. See the module documentation. */
export class StartWorkService {
  private readonly launching: Launching = new Map();
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
  }

  /**
   * Start work in a new chat for an extension.
   *
   * @param extensionId - The extension starting it.
   * @param input - The project, prompt, title and reason.
   * @param via - Where the call came from; see {@link StartWorkVia}.
   * @returns The new chat's id.
   * @throws StartWorkError when a rule refuses it (nothing was started).
   * @throws StartWorkInputError when the input breaks a length rule.
   */
  async start(
    extensionId: string,
    input: unknown,
    via: StartWorkVia
  ): Promise<{ sessionId: string }> {
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
    });
    if (!claimed.ok) throw claimed.error;
    const reservation = claimed.reservation;

    let retryRename: (() => void) | null = null;
    let settled = false;
    let result: Awaited<ReturnType<typeof dispatchSessionMessage>>;
    try {
      result = await dispatchSessionMessage({
        origin: { kind: 'extension-start' },
        sessionId,
        request: {
          content: request.prompt,
          cwd: project.root,
          runtime: runtimeType,
          // One honest line for the model, so it does not take the prompt for
          // the person's own words. It rides the context bag and is never drawn.
          seedContext: `This chat was started by the ${name} extension: ${request.reason}`,
        },
        clientId: `extension:${extensionId}`,
        // No agent is named: the chat runs in the project's root on the default
        // runtime, like a new chat a person opens there.
        meshCore: undefined,
        // A chat minted here is in no room.
        roomSessionPlace: undefined,
        countsTowardLaunchCap: true,
        onSettled: () => {
          settled = true;
          reservation.settle();
          retryRename?.();
        },
      });
    } catch (err) {
      reservation.cancel();
      throw err;
    }
    if (isSessionLaunchRefusal(result)) {
      reservation.cancel();
      if (result.refused === 'LAUNCH_CAP_FULL') {
        throw new StartWorkError('start_limit', AGENT_LAUNCH_CAP_MESSAGE);
      }
      // The launch asked the account rule again; one that changed since the
      // check above is refused the same way.
      if (result.refused === 'ACCOUNT_NOT_ALLOWED') {
        throw new StartWorkError('account_not_allowed_here', result.message);
      }
      throw new Error(result.message);
    }
    if (!result.accepted) {
      reservation.cancel();
      throw new Error('The chat could not be started. Try again.');
    }

    const canonicalId = result.canonicalId ?? sessionId;
    if (canonicalId !== sessionId) reservation.rekey(canonicalId);

    await renameNowOrLater(
      () => this.rename(runtimeType, canonicalId, request.title, project.root),
      (retry) => {
        if (settled) retry();
        else retryRename = retry;
      },
      canonicalId
    );

    void this.deps.activity
      ?.emit({
        actorType: 'system',
        actorLabel: name,
        actorId: extensionId,
        category: 'agent',
        eventType: 'extension.session_started',
        resourceType: 'session',
        resourceId: canonicalId,
        resourceLabel: request.title,
        summary: `${name} started a chat in ${project.name}: ${request.title}`,
        linkPath: sessionPath({ session: canonicalId }),
        metadata: { extensionId, project: project.root, via, reason: request.reason },
      })
      .catch((err: unknown) =>
        logger.warn('[start-work] could not record a started chat', logError(err))
      );

    return { sessionId: canonicalId };
  }

  /**
   * Claim a start slot and write the start, or refuse it. Synchronous from the
   * count to the insert, so two starts racing for the last slot cannot both
   * get it. A start whose chain reaches no extension counts against nothing.
   *
   * @param start - The start, without its time.
   */
  reserve(
    start: Omit<StartedByRecord, 'createdAt' | 'carried'> & { carried?: boolean }
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
   * - A carry-over to another account (`carry: true`) records only when the
   *   parent was itself started (the chat keeps its first line, its fold and
   *   its chain), and keeps the parent's reason. It is never refused by the
   *   limits and never counted in the hour; it counts as running, and its own
   *   `session_start` calls stay limited.
   *
   * @param opts - The new chat, its parent, and how it was started.
   */
  reserveFromChat(opts: {
    sessionId: string;
    parentSessionId: string;
    reason?: string | null;
    carry?: boolean;
  }): { ok: true; reservation: StartReservation | null } | { ok: false; error: StartWorkError } {
    const parent = this.deps.store.get(opts.parentSessionId);
    if (opts.carry && !parent) return { ok: true, reservation: null };
    return this.reserve({
      sessionId: opts.sessionId,
      kind: 'chat',
      extensionId: null,
      startedBySessionId: opts.parentSessionId,
      originExtensionId: parent?.originExtensionId ?? null,
      reason: opts.carry ? (parent?.reason ?? null) : (opts.reason ?? null),
      carried: opts.carry === true,
    });
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
