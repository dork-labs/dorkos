/**
 * `ctx.inbox`: an extension asks a person something in the Activity inbox,
 * and core carries the question from there (spec `flow-multiproject` §7).
 *
 * ## What core owns, and what the extension owns
 *
 * The extension decides WHEN to ask (its own conditions and time limits, N7)
 * and what an answer means. Core owns everything in between: the one open row
 * per `(extension, key)` (the `extension_decisions` partial unique index),
 * the `extension.decision` notification kind with its escalation clock, a
 * question's deadline, who ended up deciding, and the one history row.
 *
 * ## The invariants this file keeps
 *
 * - **Namespaced by core** (invariant 4). Every call is scoped to the calling
 *   extension's id; one extension cannot read, resolve or answer another's.
 * - **One live row per key** (invariant 2). Raising an open key updates it in
 *   place and never re-arms its escalation.
 * - **Every ask says why** (invariant 12). `raise` and `record` refuse a
 *   missing or long `why` (see `extension-inbox-validate.ts`).
 * - **A person is never the bottleneck on a question with a deadline**
 *   (invariant 13). At `decideBy` core calls the handler with the agent's
 *   pick; `keepOpen` is honoured, a failure retries twice (1 and 5 minutes
 *   later) and then the row stays with the person and says so.
 * - **Nothing is asked of anybody who cannot answer.** While an extension is
 *   not running, or a decision's project folder is missing, the decision is
 *   hidden and its escalation and deadline are stopped; both come back when
 *   the extension runs (and registers `onAction`) or the folder returns.
 *
 * ## Two answer paths, two attributions (§7.3)
 *
 * {@link ExtensionInboxService.answer} with `via: person` is what the bell and
 * the inbox call (`POST /api/extension-decisions/:id/action`): attributed to
 * the person, and it may carry a one-time offer. With `via: extension` it is
 * the extension's own page (`api.answerDecision`): attributed to the
 * extension ("answered in Flow"), never offered anything.
 *
 * @module services/extensions/extension-inbox
 */
import fs from 'fs';
import { monotonicFactory } from 'ulidx';
import { and, eq, isNull, isNotNull, lt, extensionDecisions, type Db } from '@dorkos/db';
import type { ExtensionDecisionRow } from '@dorkos/db';
import {
  InboxLimitError,
  type DecisionActionEvent,
  type DecisionActionResult,
  type DecisionActor,
  type DecisionInput,
  type DecisionOutcome,
  type DecisionWatch,
  type ProjectRef,
  type RaisedDecision,
  type RecordedDecisionInput,
} from '@dorkos/extension-api/server';
import {
  DECISION_ALREADY_RESOLVED_CODE,
  DECISION_EXTENSION_TIMEOUT_CODE,
  DECISION_LIMITS,
  DECISION_NOT_RUNNING_CODE,
  DECISION_OFFER_GONE_CODE,
  DECISION_OFFER_TTL_MS,
  DECISION_STALE_CODE,
  type DecisionActionRequest,
  type DecisionActionResponse,
  type ExtensionDecisionDTO,
  type PendingDecisionOffer,
} from '@dorkos/shared/extension-decision-schemas';
import { logger } from '../../../lib/logger.js';
import {
  cancelEscalationByKey,
  getEscalationService,
} from '../../notifications/escalation-service.js';
import {
  notificationEntry,
  setOpenProjectCounter,
} from '../../notifications/notification-registry.js';
import {
  pruneExtensionHistory,
  resolveStanding,
} from '../../notifications/notification-service.js';
import { broadcastStandingResolved, raiseStanding } from '../../notifications/standing-events.js';
import type { ProjectRegistry } from '../../projects/project-registry.js';
import {
  checkActionResult,
  checkActor,
  checkDecisionInput,
  checkOffer,
  checkRecordInput,
  checkWatch,
  HandlerAnswerError,
  shapeAnswer,
  type CheckedActionResult,
} from './extension-inbox-validate.js';
import {
  actionsOf,
  choiceWords,
  parseJson,
  payloadOf,
  projectOf,
  toDecisionDTO,
  toRaisedDecision,
  type PendingAction,
  type StoredOffer,
} from './extension-inbox-rows.js';
import { projectSettingsStore } from './extension-project-settings.js';

const nextId = monotonicFactory();

/** How long an action handler has to answer. */
const HANDLER_TIMEOUT_MS = 5_000;

/** When a failed deadline call is tried again: one minute, then five. */
const DEADLINE_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

/** Most new decisions (raised or recorded) one extension may add in an hour. */
const NEW_DECISIONS_PER_HOUR = 60;

/** The hour {@link NEW_DECISIONS_PER_HOUR} counts over. */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Most `extension.decision` history rows kept per extension. Activity keeps
 * one bounded history for every kind, so without this one busy extension
 * could push everything else out of it.
 */
const HISTORY_ROWS_PER_EXTENSION = 100;

/** How late a deadline's timer may be before the sweep fires it instead. */
const LATE_TIMER_GRACE_MS = 1_000;

/** How often hidden-by-folder decisions and overdue deadlines are looked at again. */
const FOLDER_SWEEP_MS = 60_000;

/** How long resolved rows are kept. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The row the extension's `actions_json` holds for a history-only record. */
const RECORDED_ACTIONS = 'null';

/** One extension's action handler. */
export type DecisionHandler = (
  event: DecisionActionEvent
) => DecisionActionResult | Promise<DecisionActionResult>;

/** What the inbox needs wired. */
export interface ExtensionInboxDeps {
  /** The database holding `extension_decisions`. */
  db: Db;
  /** The project registry, for `project` and the heading's name. */
  projects: Pick<ProjectRegistry, 'report' | 'get' | 'resolveWithin' | 'listForExtension'>;
  /** The DorkOS data directory, for per-project settings. */
  dorkHome: string;
  /** Clock. */
  now?: () => number;
  /** How long a handler has. Tests shorten it. */
  handlerTimeoutMs?: number;
  /** Whether a folder exists. */
  folderExists?: (root: string) => boolean;
  /**
   * Whether `sessionId` names a chat this extension started (or a chat started
   * from one), so a `watch` may point at it (§7.3). Filled by the start-work
   * seam (DOR-2524); until then no chat qualifies and every `watch` is dropped.
   */
  watchAllowed?: (extensionId: string, sessionId: string) => boolean;
}

/** Who is answering through {@link ExtensionInboxService.answer}. */
export type AnswerVia = { kind: 'person' } | { kind: 'extension'; extensionId: string };

/** What an answer came to: a response, or a refusal with its status. */
export type AnswerOutcome =
  | { ok: true; response: DecisionActionResponse }
  | { ok: false; status: number; code: string; message: string };

/** What a follow-up offer's answer came to. */
export type OfferOutcome =
  | {
      ok: true;
      message: string | null;
      /** Set when core applied the offer's settings patch, for the Activity entry. */
      settingsChanged: { extensionId: string; extensionName: string; projectName: string } | null;
    }
  | { ok: false; status: number; code: string; message: string };

/** A handler call's result. */
type HandlerCall =
  { ok: true; result: CheckedActionResult } | { ok: false; reason: 'timeout' | 'error' };

/** The extension's inbox, core's side. */
export class ExtensionInboxService {
  private readonly running = new Map<string, string>();
  private readonly handlers = new Map<string, DecisionHandler>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hiddenByFolder = new Set<string>();
  /** Decisions whose person's answer is with the extension right now: no deadline may fire. */
  private readonly answering = new Set<string>();
  /** When each armed deadline timer is due, to tell a late timer from one on time. */
  private readonly deadlineDue = new Map<string, number>();
  /** Decisions whose deadline call is with the extension right now: no answer may start. */
  private readonly firing = new Set<string>();
  /** When each extension added its recent decisions, for the hourly budget. */
  private readonly added = new Map<string, number[]>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly handlerTimeoutMs: number;
  private readonly folderExists: (root: string) => boolean;
  private readonly watchAllowed: (extensionId: string, sessionId: string) => boolean;

  /**
   * Build the inbox.
   *
   * @param deps - What the inbox needs.
   */
  constructor(private readonly deps: ExtensionInboxDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.handlerTimeoutMs = deps.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
    this.folderExists = deps.folderExists ?? ((root) => fs.existsSync(root));
    this.watchAllowed = deps.watchAllowed ?? (() => false);
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * An extension's server half is running: its decisions reappear, their
   * escalation re-arms, and (once it has a handler) passed deadlines fire.
   *
   * @param extensionId - The extension.
   * @param extensionName - Its manifest name.
   */
  markRunning(extensionId: string, extensionName: string): void {
    this.running.set(extensionId, extensionName);
    this.startSweep();
    const rows = this.openRows(extensionId);
    const since = (row: ExtensionDecisionRow) => Date.parse(row.raisedAt);
    for (const row of rows) {
      if (!this.folderOk(row)) this.hiddenByFolder.add(row.id);
    }
    const standing = rows
      .filter((row) => this.folderOk(row))
      .map((row) => ({
        kind: 'extension.decision' as const,
        payload: payloadOf(row, this.openProjects(extensionId)),
        since: since(row),
      }));
    for (const condition of standing) {
      raiseStanding('extension.decision', condition.payload, { arm: false });
    }
    getEscalationService()?.rearmFromStandingState(standing);
    for (const row of rows) this.scheduleDeadline(row);
  }

  /**
   * An extension's server half stopped (disabled, revoked, failed, reloading):
   * its decisions are hidden and kept, their escalation cancelled and their
   * deadlines paused, so nobody is woken for something nobody can answer.
   *
   * @param extensionId - The extension.
   */
  markStopped(extensionId: string): void {
    if (!this.running.delete(extensionId)) return;
    for (const row of this.openRows(extensionId)) this.stand(row, false);
  }

  /**
   * Boot: an extension that is no longer discovered at all has nobody left to
   * explain its open decisions, so they resolve `cancelled`, with no history row.
   *
   * @param discovered - Every extension id discovery found.
   */
  cancelUndiscovered(discovered: ReadonlySet<string>): void {
    const open = this.deps.db
      .select()
      .from(extensionDecisions)
      .where(isNull(extensionDecisions.resolvedAt))
      .all();
    const at = new Date(this.now()).toISOString();
    for (const row of open) {
      if (discovered.has(row.extensionId)) continue;
      this.deps.db
        .update(extensionDecisions)
        .set({ resolvedAt: at, outcome: 'cancelled', resolvedBy: 'extension' })
        .where(and(eq(extensionDecisions.id, row.id), isNull(extensionDecisions.resolvedAt)))
        .run();
      this.stand(row, false);
      this.hiddenByFolder.delete(row.id);
    }
  }

  /**
   * Register the one handler for an extension's answers. A second replaces the
   * first. Deadlines waiting for a handler fire once it is here.
   *
   * @param extensionId - The extension.
   * @param handler - Its handler.
   * @returns Unregister (a no-op once another handler replaced it).
   */
  setHandler(extensionId: string, handler: DecisionHandler): () => void {
    this.handlers.set(extensionId, handler);
    for (const row of this.openRows(extensionId)) this.scheduleDeadline(row);
    return () => {
      if (this.handlers.get(extensionId) !== handler) return;
      this.handlers.delete(extensionId);
      for (const row of this.openRows(extensionId)) this.clearDeadline(row.id);
    };
  }

  /** Stop every timer. */
  stop(): void {
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  // --- The extension's side (`ctx.inbox`) ------------------------------------

  /**
   * Raise, or update in place, the one open decision for a key.
   *
   * @param extensionId - The raising extension.
   * @param extensionName - Its manifest name.
   * @param input - The decision.
   */
  async raise(
    extensionId: string,
    extensionName: string,
    input: DecisionInput
  ): Promise<RaisedDecision> {
    const at = this.now();
    const checked = checkDecisionInput(input, extensionId, at);
    const project = await this.reportProject(checked.project, extensionId);
    const stamp = new Date(at).toISOString();
    const fields = {
      extensionName,
      projectRoot: project?.root ?? null,
      projectLabel: checked.projectLabel,
      title: checked.title,
      why: checked.why,
      detail: checked.detail,
      actionsJson: JSON.stringify(checked.actions),
      link: checked.link,
      since: checked.since,
      updatedAt: stamp,
    };
    // Only a new question sets these: a re-raise of the same one never moves
    // its deadline, re-arms it, or forgets what a person already answered.
    const question = {
      decideBy: checked.decideBy,
      defaultChoice: checked.defaultChoice,
      deadlineState: null,
      deadlineAttempts: 0,
      pendingActionJson: null,
      watchJson: null,
    };

    const { row, created, changedQuestion } = this.deps.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(extensionDecisions)
        .where(
          and(
            eq(extensionDecisions.extensionId, extensionId),
            eq(extensionDecisions.key, checked.key),
            isNull(extensionDecisions.resolvedAt)
          )
        )
        .get();
      if (existing) {
        // A new question (different actions, or a different deadline asked
        // for) starts over; new words for the same question change nothing
        // about its deadline or what a person already said.
        // A deadline asked as "an hour from now" moves on every re-raise; the
        // question is the same, so it keeps the deadline first asked for.
        const sameQuestion =
          withoutDeadline(existing.actionsJson) === withoutDeadline(fields.actionsJson);
        const sameWords =
          existing.title === fields.title &&
          existing.why === fields.why &&
          existing.detail === fields.detail &&
          existing.link === fields.link;
        tx.update(extensionDecisions)
          .set({
            ...fields,
            ...(sameQuestion ? { actionsJson: existing.actionsJson } : question),
            ...(sameQuestion && sameWords ? {} : { revision: existing.revision + 1 }),
          })
          .where(eq(extensionDecisions.id, existing.id))
          .run();
        const updated = tx
          .select()
          .from(extensionDecisions)
          .where(eq(extensionDecisions.id, existing.id))
          .get();
        return { row: updated!, created: false, changedQuestion: !sameQuestion };
      }
      const open = tx
        .select({ id: extensionDecisions.id })
        .from(extensionDecisions)
        .where(
          and(
            eq(extensionDecisions.extensionId, extensionId),
            isNull(extensionDecisions.resolvedAt)
          )
        )
        .all().length;
      this.spendBudget(extensionId, extensionName);
      if (open >= DECISION_LIMITS.open) {
        throw new InboxLimitError(
          'open',
          `${extensionName} already has ${DECISION_LIMITS.open} open decisions; resolve one first.`
        );
      }
      const inserted = {
        id: nextId(),
        extensionId,
        key: checked.key,
        raisedAt: stamp,
        ...fields,
        ...question,
      };
      tx.insert(extensionDecisions).values(inserted).run();
      const stored = tx
        .select()
        .from(extensionDecisions)
        .where(eq(extensionDecisions.id, inserted.id))
        .get();
      return { row: stored!, created: true, changedQuestion: true };
    });

    if (created) {
      this.noteAdded(extensionId);
      this.prune();
    }
    // Raised into a folder that is missing right now (an unplugged drive):
    // hidden, and the sweep shows it once the folder is back.
    if (this.running.has(extensionId) && !this.folderOk(row)) this.hiddenByFolder.add(row.id);
    if (this.visible(row)) {
      raiseStanding('extension.decision', payloadOf(row, this.openProjects(extensionId)), {
        arm: created,
      });
    }
    if (changedQuestion) {
      this.clearDeadline(row.id);
      this.scheduleDeadline(row);
    }
    return toRaisedDecision(row, this.projectRef(row.projectRoot));
  }

  /**
   * Settle an open decision. False when nothing was open for the key.
   *
   * @param extensionId - The calling extension.
   * @param key - The decision's key.
   * @param opts - How it ended, who decided, and what to credit.
   */
  async resolve(
    extensionId: string,
    key: string,
    opts: {
      outcome: DecisionOutcome;
      by?: DecisionActor;
      answering?: string;
      offer?: unknown;
      watch?: DecisionWatch;
    }
  ): Promise<boolean> {
    const outcomes: readonly DecisionOutcome[] = [
      'approved',
      'rejected',
      'answered',
      'cleared',
      'cancelled',
    ];
    if (!opts || !outcomes.includes(opts.outcome)) {
      throw new TypeError(`resolve() needs an outcome: ${outcomes.join(', ')}.`);
    }
    const by = checkActor(opts.by);
    const row = this.openRow(extensionId, key);
    if (!row) return false;

    const stored = parseJson<PendingAction>(row.pendingActionJson);
    // A stale or foreign `answering` is ignored: the resolve still happens,
    // attributed to the extension.
    const pending =
      typeof opts.answering === 'string' && stored !== null && stored.id === opts.answering
        ? stored
        : null;
    const credited = pending !== null;
    if (pending && !agrees(pending.action, opts.outcome)) {
      throw new TypeError(
        `resolve() with answering: ${opts.outcome} contradicts what the person chose (${pending.action}).`
      );
    }
    const actions = actionsOf(row);
    let resolvedBy: ExtensionDecisionRow['resolvedBy'] = 'extension';
    let resolvedByLabel: string | null = null;
    let choiceLabel: string | null = choiceWords(actions, opts.outcome, null);
    if (pending) {
      resolvedBy = 'person';
      choiceLabel = pending.choiceLabel ?? choiceLabel;
    } else if (by?.kind === 'deadline') {
      resolvedBy = 'deadline';
      choiceLabel = choiceWords(actions, opts.outcome, row.defaultChoice) ?? choiceLabel;
    } else if (by) {
      resolvedBy = by.kind;
      resolvedByLabel = by.label;
    }
    const offer = credited ? checkOffer(opts.offer) : null;

    return this.resolveRow(row, {
      outcome: opts.outcome,
      resolvedBy,
      resolvedByLabel,
      choiceId: pending?.choiceId ?? null,
      choiceLabel,
      note: pending?.note ?? null,
      offer: offer
        ? { ...offer, createdAt: new Date(this.now()).toISOString(), via: 'answering' }
        : null,
      watch: this.allowedWatch(extensionId, opts.watch),
      unread: resolvedBy === 'deadline' || resolvedBy === 'agent' || resolvedBy === 'rule',
    });
  }

  /**
   * Write a history-only row for something decided without asking.
   *
   * @param extensionId - The recording extension.
   * @param extensionName - Its manifest name.
   * @param input - What was decided, why, and who decided.
   */
  async record(
    extensionId: string,
    extensionName: string,
    input: RecordedDecisionInput
  ): Promise<void> {
    const checked = checkRecordInput(input, extensionId);
    const outcomes = ['approved', 'rejected', 'answered'] as const;
    if (!outcomes.includes(input.outcome as (typeof outcomes)[number])) {
      throw new TypeError(`record() needs an outcome: ${outcomes.join(', ')}.`);
    }
    const by = checkActor(input.by);
    if (!by) throw new InboxLimitError('title', 'record() needs `by`: who decided.');
    this.spendBudget(extensionId, extensionName);
    const project = await this.reportProject(checked.project, extensionId);
    const stamp = new Date(this.now()).toISOString();
    const row = {
      id: nextId(),
      extensionId,
      extensionName,
      key: checked.key,
      projectRoot: project?.root ?? null,
      projectLabel: checked.projectLabel,
      title: checked.title,
      why: checked.why,
      detail: checked.detail,
      actionsJson: RECORDED_ACTIONS,
      link: checked.link,
      raisedAt: stamp,
      updatedAt: stamp,
      resolvedAt: stamp,
      outcome: input.outcome,
      choiceLabel: checked.choiceLabel,
      resolvedBy: by.kind,
      resolvedByLabel: by.kind === 'deadline' ? null : by.label,
      recorded: 1,
    };
    this.deps.db.insert(extensionDecisions).values(row).run();
    this.noteAdded(extensionId);
    this.prune();
    const stored = this.deps.db
      .select()
      .from(extensionDecisions)
      .where(eq(extensionDecisions.id, row.id))
      .get()!;
    await resolveStanding('extension.decision', payloadOf(stored, 0), {
      outcome: input.outcome,
      unread: input.tell === true,
    });
    pruneExtensionHistory(extensionId, HISTORY_ROWS_PER_EXTENSION, this.offeredIds(extensionId));
  }

  /**
   * One extension's open decisions, whether or not they are showing.
   *
   * @param extensionId - The extension.
   */
  list(extensionId: string): RaisedDecision[] {
    return this.openRows(extensionId).map((row) =>
      toRaisedDecision(row, this.projectRef(row.projectRoot))
    );
  }

  // --- Core's side: the inbox and the extension's page -------------------------

  /**
   * The open decisions a person should see: of running extensions, in
   * folders that exist, oldest first.
   *
   * @param extensionId - Only this extension's, when given.
   */
  listOpen(extensionId?: string): ExtensionDecisionDTO[] {
    const where = extensionId
      ? and(isNull(extensionDecisions.resolvedAt), eq(extensionDecisions.extensionId, extensionId))
      : isNull(extensionDecisions.resolvedAt);
    return this.deps.db
      .select()
      .from(extensionDecisions)
      .where(where)
      .all()
      .filter((row) => this.visible(row))
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))
      .map((row) => toDecisionDTO(row, this.projectRef(row.projectRoot)));
  }

  /** Follow-up offers the person who answered has not answered yet. */
  pendingOffers(): PendingDecisionOffer[] {
    const floor = this.now() - DECISION_OFFER_TTL_MS;
    return this.deps.db
      .select()
      .from(extensionDecisions)
      .where(and(isNotNull(extensionDecisions.offerJson), isNull(extensionDecisions.offerUsedAt)))
      .all()
      .flatMap((row) => {
        const offer = parseJson<StoredOffer>(row.offerJson);
        // Only a later credit is listed: an offer in reply to an answer went
        // back to the one client that answered, and shows nowhere else.
        if (!offer || row.resolvedBy !== 'person' || offer.via !== 'answering') return [];
        const made = Date.parse(offer.createdAt);
        if (Number.isNaN(made) || made < floor) return [];
        return [
          {
            decisionId: row.id,
            text: offer.text,
            expiresAt: new Date(made + DECISION_OFFER_TTL_MS).toISOString(),
          },
        ];
      });
  }

  /**
   * Answer a decision: call the extension's handler, then resolve or keep it
   * open. The row is re-checked inside a transaction after the handler, so a
   * second tab or the extension itself settling it meanwhile answers
   * `already_resolved` and records nothing.
   *
   * @param decisionId - Core's id for the row.
   * @param request - The answer.
   * @param via - A person in core's UI, or the extension's own page.
   */
  async answer(
    decisionId: string,
    request: DecisionActionRequest,
    via: AnswerVia
  ): Promise<AnswerOutcome> {
    const row = this.byId(decisionId);
    if (
      !row ||
      row.recorded === 1 ||
      (via.kind === 'extension' && row.extensionId !== via.extensionId)
    ) {
      return refuse(404, 'not_found', 'There is no such decision.');
    }
    if (row.resolvedAt) {
      return refuse(409, DECISION_ALREADY_RESOLVED_CODE, 'This was already settled.');
    }
    const name = row.extensionName;
    const handler = this.handlers.get(row.extensionId);
    if (!this.running.has(row.extensionId) || !handler) {
      return refuse(409, DECISION_NOT_RUNNING_CODE, `${name} isn't running right now.`);
    }
    if (request.revision !== undefined && request.revision !== row.revision) {
      return refuse(409, DECISION_STALE_CODE, 'This question changed. Take another look.');
    }
    const actions = actionsOf(row);
    const shaped = shapeAnswer(actions, request);
    if ('refusal' in shaped) return refuse(400, 'bad_answer', shaped.refusal);

    if (this.firing.has(row.id) || this.answering.has(row.id)) {
      return refuse(409, 'busy', `${name} is still working on this. Try again in a moment.`);
    }

    // The answer is with the extension now: the deadline waits, so the
    // agent's pick can never reach the handler beside the person's answer.
    this.clearDeadline(row.id);
    this.answering.add(row.id);
    const pendingActionId = via.kind === 'person' ? nextId() : null;
    let call: HandlerCall;
    try {
      call = await this.callHandler(row.extensionId, handler, {
        key: row.key,
        action: request.action,
        choiceId: shaped.choiceId,
        decidedBy: 'person',
        offerId: null,
        pendingActionId,
        note: shaped.note,
        text: shaped.text,
        project: this.projectRef(row.projectRoot),
      });
    } finally {
      this.answering.delete(row.id);
    }
    if (!call.ok) {
      // Nothing was decided, so the deadline stands as it was.
      const current = this.byId(row.id);
      if (current) this.scheduleDeadline(current);
      const status = call.reason === 'timeout' ? 504 : 502;
      const code = call.reason === 'timeout' ? DECISION_EXTENSION_TIMEOUT_CODE : 'extension_error';
      return refuse(status, code, `${name} couldn't take that. Try again.`);
    }
    const result = call.result;
    // The extension may have re-raised a changed question while it had the
    // answer: the answer is to the old one, so it is not applied to the new.
    if ((this.byId(row.id)?.revision ?? row.revision) !== row.revision) {
      return refuse(409, DECISION_STALE_CODE, 'This question changed. Take another look.');
    }
    // Somebody answered: whatever the extension does with it, the agent's pick
    // no longer applies to this question.
    this.deps.db
      .update(extensionDecisions)
      .set({ deadlineState: 'answered' })
      .where(
        and(
          eq(extensionDecisions.id, row.id),
          isNull(extensionDecisions.resolvedAt),
          isNotNull(extensionDecisions.decideBy),
          isNull(extensionDecisions.deadlineState)
        )
      )
      .run();
    if (result.kind === 'settled') {
      this.announceUpdate(row.id);
      return { ok: true, response: noChange(null, null, null) };
    }
    const watch = this.allowedWatch(row.extensionId, result.watch);
    if (result.kind === 'keepOpen') {
      const pending: PendingAction | null = pendingActionId
        ? {
            id: pendingActionId,
            action: request.action,
            choiceId: shaped.choiceId,
            choiceLabel: shaped.choiceLabel,
            note: shaped.note ?? shaped.text,
            at: new Date(this.now()).toISOString(),
          }
        : null;
      const changed = this.deps.db
        .update(extensionDecisions)
        .set({
          ...(pending ? { pendingActionJson: JSON.stringify(pending) } : {}),
          ...(watch ? { watchJson: JSON.stringify(watch) } : {}),
        })
        .where(and(eq(extensionDecisions.id, row.id), isNull(extensionDecisions.resolvedAt)))
        .run().changes;
      if (changed === 0 && (pending || watch)) {
        return refuse(409, DECISION_ALREADY_RESOLVED_CODE, 'This was already settled.');
      }
      this.announceUpdate(row.id);
      return { ok: true, response: noChange(result.message, result.navigate, watch) };
    }

    const offer = via.kind === 'person' ? result.offer : null;
    const resolved = await this.resolveRow(row, {
      outcome: result.outcome,
      resolvedBy: via.kind === 'person' ? 'person' : 'extension',
      resolvedByLabel: via.kind === 'person' ? null : `in ${name}`,
      choiceId: shaped.choiceId,
      choiceLabel: shaped.choiceLabel ?? choiceWords(actions, result.outcome, shaped.choiceId),
      note: shaped.note ?? shaped.text,
      offer: offer
        ? { ...offer, createdAt: new Date(this.now()).toISOString(), via: 'answer' }
        : null,
      watch,
      unread: false,
    });
    if (!resolved) return refuse(409, DECISION_ALREADY_RESOLVED_CODE, 'This was already settled.');
    return {
      ok: true,
      response: {
        resolved: true,
        message: result.message,
        navigate: result.navigate,
        offer: offer ? { text: offer.text } : null,
        watch,
      },
    };
  }

  /**
   * A person's "Yes" or quiet dismiss on a one-time follow-up offer (§7.8).
   * Either way the offer is used up. "Yes" first applies the offer's settings
   * patch (as the person), then calls the handler with `action: 'offer'`.
   *
   * @param decisionId - Core's id for the answered row.
   * @param accept - Yes, or dismiss.
   */
  async answerOffer(decisionId: string, accept: boolean): Promise<OfferOutcome> {
    const row = this.byId(decisionId);
    if (!row) return refuse(404, 'not_found', 'There is no such decision.');
    const offer = parseJson<StoredOffer>(row.offerJson);
    const gone = refuse(409, DECISION_OFFER_GONE_CODE, 'That offer is no longer open.');
    if (!offer || row.offerUsedAt || row.resolvedBy !== 'person') return gone;
    const made = Date.parse(offer.createdAt);
    if (Number.isNaN(made) || this.now() - made > DECISION_OFFER_TTL_MS) return gone;
    const handler = this.handlers.get(row.extensionId);
    if (accept && (!this.running.has(row.extensionId) || !handler)) {
      return refuse(
        409,
        DECISION_NOT_RUNNING_CODE,
        `${row.extensionName} isn't running right now.`
      );
    }
    // Claimed before anything else happens, so two posts cannot both use it.
    const claimed = this.deps.db
      .update(extensionDecisions)
      .set({ offerUsedAt: new Date(this.now()).toISOString() })
      .where(and(eq(extensionDecisions.id, row.id), isNull(extensionDecisions.offerUsedAt)))
      .run().changes;
    if (claimed === 0) return gone;
    if (!accept || !handler) return { ok: true, message: null, settingsChanged: null };

    let settingsChanged: {
      extensionId: string;
      extensionName: string;
      projectName: string;
    } | null = null;
    if (offer.settingsPatch) {
      const applied = await this.applySettingsPatch(row.extensionId, offer.settingsPatch);
      if (!applied) {
        // Nothing else happens: the offer is open again, the handler is not called.
        this.deps.db
          .update(extensionDecisions)
          .set({ offerUsedAt: null })
          .where(eq(extensionDecisions.id, row.id))
          .run();
        return refuse(422, 'offer_failed', "Couldn't change that. Try again.");
      }
      settingsChanged = {
        extensionId: row.extensionId,
        extensionName: row.extensionName,
        projectName: applied.name,
      };
    }
    const call = await this.callHandler(row.extensionId, handler, {
      key: row.key,
      action: 'offer',
      choiceId: null,
      decidedBy: 'person',
      offerId: offer.offerId,
      pendingActionId: null,
      note: null,
      text: null,
      project: this.projectRef(row.projectRoot),
    });
    const message = call.ok && call.result.kind !== 'settled' ? call.result.message : null;
    return { ok: true, message, settingsChanged };
  }

  /**
   * In how many projects an extension has open, showing decisions right now.
   *
   * @param extensionId - The extension.
   */
  openProjectCount(extensionId: string): number {
    return this.running.has(extensionId) ? this.openProjects(extensionId) : 0;
  }

  /** Decisions of one extension whose follow-up offer is still waiting: their history rows stay. */
  private offeredIds(extensionId: string): Set<string> {
    return new Set(
      this.deps.db
        .select({ id: extensionDecisions.id })
        .from(extensionDecisions)
        .where(
          and(
            eq(extensionDecisions.extensionId, extensionId),
            isNotNull(extensionDecisions.offerJson),
            isNull(extensionDecisions.offerUsedAt)
          )
        )
        .all()
        .map((row) => row.id)
    );
  }

  /** Delete resolved rows older than 30 days. @returns How many were deleted. */
  prune(): number {
    const floor = new Date(this.now() - RETENTION_MS).toISOString();
    return this.deps.db
      .delete(extensionDecisions)
      .where(
        and(isNotNull(extensionDecisions.resolvedAt), lt(extensionDecisions.resolvedAt, floor))
      )
      .run().changes;
  }

  // --- Internals ---------------------------------------------------------------

  /** Resolve a row once, then clear its timers and write its one history row. */
  private async resolveRow(
    row: ExtensionDecisionRow,
    fields: {
      outcome: DecisionOutcome;
      resolvedBy: NonNullable<ExtensionDecisionRow['resolvedBy']>;
      resolvedByLabel: string | null;
      choiceId: string | null;
      choiceLabel: string | null;
      note: string | null;
      offer: StoredOffer | null;
      watch: DecisionWatch | null;
      unread: boolean;
    }
  ): Promise<boolean> {
    const changed = this.deps.db.transaction((tx) =>
      tx
        .update(extensionDecisions)
        .set({
          resolvedAt: new Date(this.now()).toISOString(),
          outcome: fields.outcome,
          resolvedBy: fields.resolvedBy,
          resolvedByLabel: fields.resolvedByLabel,
          choiceId: fields.choiceId,
          choiceLabel: fields.choiceLabel,
          note: fields.note,
          offerJson: fields.offer ? JSON.stringify(fields.offer) : null,
          ...(fields.watch ? { watchJson: JSON.stringify(fields.watch) } : {}),
          pendingActionJson: null,
        })
        .where(and(eq(extensionDecisions.id, row.id), isNull(extensionDecisions.resolvedAt)))
        .run()
    ).changes;
    if (changed === 0) return false;
    this.clearDeadline(row.id);
    this.hiddenByFolder.delete(row.id);
    const stored = this.byId(row.id)!;
    await resolveStanding(
      'extension.decision',
      payloadOf(stored, this.openProjects(row.extensionId)),
      {
        outcome: fields.outcome,
        unread: fields.unread,
      }
    );
    pruneExtensionHistory(
      row.extensionId,
      HISTORY_ROWS_PER_EXTENSION,
      this.offeredIds(row.extensionId)
    );
    return true;
  }

  /** Call a handler, bounded, and check its answer. Never throws. */
  private async callHandler(
    extensionId: string,
    handler: DecisionHandler,
    event: DecisionActionEvent
  ): Promise<HandlerCall> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.handlerTimeoutMs);
        timer.unref?.();
      });
      const answered = await Promise.race([Promise.resolve().then(() => handler(event)), timeout]);
      if (answered === 'timeout') {
        logger.warn(
          `[ext:${extensionId}] the inbox handler took longer than ${this.handlerTimeoutMs}ms`
        );
        return { ok: false, reason: 'timeout' };
      }
      return { ok: true, result: checkActionResult(answered, extensionId) };
    } catch (err) {
      logger.warn(`[ext:${extensionId}] the inbox handler failed`, {
        error: err instanceof Error ? err.message : String(err),
        refused: err instanceof HandlerAnswerError,
      });
      return { ok: false, reason: 'error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Arm the deadline of an open question, when everything it waits on holds. */
  private scheduleDeadline(row: ExtensionDecisionRow, delayOverride?: number): void {
    if (
      row.resolvedAt ||
      !row.decideBy ||
      !row.defaultChoice ||
      row.deadlineState !== null ||
      this.deadlines.has(row.id) ||
      this.answering.has(row.id) ||
      this.firing.has(row.id) ||
      !this.running.has(row.extensionId) ||
      !this.handlers.has(row.extensionId) ||
      !this.folderOk(row)
    ) {
      return;
    }
    const due = Date.parse(row.decideBy);
    const delay = delayOverride ?? (row.deadlineAttempts > 0 ? 0 : Math.max(0, due - this.now()));
    const timer = setTimeout(() => {
      this.deadlines.delete(row.id);
      this.deadlineDue.delete(row.id);
      void this.fireDeadline(row.id);
    }, delay);
    timer.unref?.();
    this.deadlines.set(row.id, timer);
    this.deadlineDue.set(row.id, this.now() + delay);
  }

  /** Stop a row's deadline timer. */
  private clearDeadline(decisionId: string): void {
    const timer = this.deadlines.get(decisionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.deadlines.delete(decisionId);
    this.deadlineDue.delete(decisionId);
  }

  /** The deadline passed: ask the extension to apply its pick. */
  private async fireDeadline(decisionId: string): Promise<void> {
    const row = this.byId(decisionId);
    if (!row || row.resolvedAt || row.deadlineState !== null || !row.defaultChoice) return;
    const handler = this.handlers.get(row.extensionId);
    // Not a failure: it waits until the extension runs and listens again.
    if (!handler || !this.running.has(row.extensionId) || !this.folderOk(row)) return;
    if (this.answering.has(decisionId) || this.firing.has(decisionId)) return;

    this.firing.add(decisionId);
    let call: HandlerCall;
    try {
      call = await this.callHandler(row.extensionId, handler, {
        key: row.key,
        action: 'choice',
        choiceId: row.defaultChoice,
        decidedBy: 'deadline',
        offerId: null,
        pendingActionId: null,
        note: null,
        text: null,
        project: this.projectRef(row.projectRoot),
      });
    } finally {
      this.firing.delete(decisionId);
    }
    const now = this.byId(decisionId);
    if (!now || now.resolvedAt || now.deadlineState !== null) return;

    if (!call.ok) {
      const attempts = now.deadlineAttempts + 1;
      const failed = attempts > DEADLINE_RETRY_DELAYS_MS.length;
      this.deps.db
        .update(extensionDecisions)
        .set({
          deadlineAttempts: attempts,
          ...(failed ? { deadlineState: 'failed' as const } : {}),
        })
        .where(eq(extensionDecisions.id, decisionId))
        .run();
      if (failed) {
        this.announceUpdate(decisionId);
        return;
      }
      this.scheduleDeadline(this.byId(decisionId)!, DEADLINE_RETRY_DELAYS_MS[attempts - 1]);
      return;
    }
    const result = call.result;
    if (result.kind === 'keepOpen' || result.kind === 'settled') {
      this.deps.db
        .update(extensionDecisions)
        .set({ deadlineState: result.kind === 'keepOpen' ? 'kept_open' : 'settled' })
        .where(eq(extensionDecisions.id, decisionId))
        .run();
      this.announceUpdate(decisionId);
      return;
    }
    const actions = actionsOf(now);
    await this.resolveRow(now, {
      outcome: 'answered',
      resolvedBy: 'deadline',
      resolvedByLabel: null,
      choiceId: now.defaultChoice,
      choiceLabel: choiceWords(actions, 'answered', now.defaultChoice),
      note: null,
      offer: null,
      watch: this.allowedWatch(now.extensionId, result.watch),
      unread: true,
    });
  }

  /** Tell open surfaces a row changed, without touching its escalation clock. */
  private announceUpdate(decisionId: string): void {
    const row = this.byId(decisionId);
    if (!row || row.resolvedAt || !this.visible(row)) return;
    raiseStanding('extension.decision', payloadOf(row, this.openProjects(row.extensionId)), {
      arm: false,
    });
  }

  /**
   * Show or hide one open row: hidden means its escalation is cancelled, its
   * deadline paused, and open surfaces told it went away.
   */
  private stand(row: ExtensionDecisionRow, showing: boolean): void {
    const payload = payloadOf(row, this.openProjects(row.extensionId));
    if (showing) {
      raiseStanding('extension.decision', payload, { arm: false });
      getEscalationService()?.rearmFromStandingState([
        { kind: 'extension.decision', payload, since: Date.parse(row.raisedAt) },
      ]);
      this.scheduleDeadline(row);
      return;
    }
    const subjectKey = notificationEntry('extension.decision').dedupeKey(payload);
    cancelEscalationByKey(subjectKey);
    broadcastStandingResolved('extension.decision', subjectKey);
    this.clearDeadline(row.id);
  }

  /**
   * Look at open rows again: a folder that came back shows its rows, and a
   * deadline that is overdue but did not fire (a laptop asleep, a timer that
   * came late) fires now.
   */
  private sweepFolders(): void {
    for (const extensionId of this.running.keys()) {
      for (const row of this.openRows(extensionId)) {
        this.fireIfOverdue(row);
        if (!row.projectRoot) continue;
        const exists = this.folderExists(row.projectRoot);
        const wasHidden = this.hiddenByFolder.has(row.id);
        if (!exists && !wasHidden) {
          this.hiddenByFolder.add(row.id);
          this.stand(row, false);
        } else if (exists && wasHidden) {
          this.hiddenByFolder.delete(row.id);
          this.stand(row, true);
        }
      }
    }
  }

  /** Fire a deadline whose time has passed, when its timer has not. */
  private fireIfOverdue(row: ExtensionDecisionRow): void {
    if (!row.decideBy || row.deadlineState !== null || this.firing.has(row.id)) return;
    // Its own timer (the deadline, or a retry) is still on time: leave it.
    const due = this.deadlineDue.get(row.id) ?? Date.parse(row.decideBy);
    if (due + LATE_TIMER_GRACE_MS > this.now()) return;
    if (!this.handlers.has(row.extensionId) || this.answering.has(row.id)) return;
    this.clearDeadline(row.id);
    void this.fireDeadline(row.id);
  }

  /** Spend one of an extension's hourly new decisions, or throw when none are left. */
  private spendBudget(extensionId: string, extensionName: string): void {
    const floor = this.now() - RATE_WINDOW_MS;
    const recent = (this.added.get(extensionId) ?? []).filter((at) => at > floor);
    this.added.set(extensionId, recent);
    if (recent.length >= NEW_DECISIONS_PER_HOUR) {
      throw new InboxLimitError(
        'rate',
        `${extensionName} added ${NEW_DECISIONS_PER_HOUR} decisions in the last hour; wait before adding more.`
      );
    }
  }

  /** Count one new decision against an extension's hourly budget. */
  private noteAdded(extensionId: string): void {
    const recent = this.added.get(extensionId) ?? [];
    recent.push(this.now());
    this.added.set(extensionId, recent);
  }

  /** Start the folder sweep once something is running. */
  private startSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.sweepFolders(), FOLDER_SWEEP_MS);
    this.sweep.unref?.();
  }

  /** Whether a row's project folder is there (a row with no project always is). */
  private folderOk(row: ExtensionDecisionRow): boolean {
    return row.projectRoot === null || this.folderExists(row.projectRoot);
  }

  /** Whether a person should see a row now. */
  private visible(row: ExtensionDecisionRow): boolean {
    return row.recorded === 0 && this.running.has(row.extensionId) && this.folderOk(row);
  }

  /** In how many projects an extension has open, showing decisions. */
  private openProjects(extensionId: string): number {
    const roots = new Set<string>();
    for (const row of this.openRows(extensionId)) {
      if (row.projectRoot && this.folderOk(row)) roots.add(row.projectRoot);
    }
    return roots.size;
  }

  /** A `watch` the extension may point at, or null (dropped with a log line). */
  private allowedWatch(extensionId: string, watch: unknown): DecisionWatch | null {
    const checked = checkWatch(watch);
    if (!checked) return null;
    if (this.watchAllowed(extensionId, checked.sessionId)) return checked;
    logger.info(`[ext:${extensionId}] dropped a watch on a chat the extension did not start`, {
      sessionId: checked.sessionId,
    });
    return null;
  }

  /** Resolve an extension's `project` through the registry (boundary and repo checked). */
  private async reportProject(dir: string | null, extensionId: string): Promise<ProjectRef | null> {
    if (!dir) return null;
    try {
      return await this.deps.projects.report(dir, extensionId);
    } catch (err) {
      logger.warn(`[ext:${extensionId}] could not resolve a decision's project`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Apply an offer's settings patch as the person, or null when refused. */
  private async applySettingsPatch(
    extensionId: string,
    patch: NonNullable<StoredOffer['settingsPatch']>
  ): Promise<{ name: string } | null> {
    try {
      const resolved = await this.deps.projects.resolveWithin(patch.project, extensionId);
      if (!resolved || resolved === 'outside') return null;
      const allowed = await this.deps.projects.listForExtension(extensionId);
      if (!allowed.some((p) => p.root === resolved.root)) return null;
      await projectSettingsStore(this.deps.dorkHome).merge(
        extensionId,
        resolved.root,
        patch.patch,
        'person'
      );
      return { name: resolved.name };
    } catch (err) {
      logger.warn(`[ext:${extensionId}] could not apply an offer's settings`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private projectRef(root: string | null): ProjectRef | null {
    return projectOf(root, (r) => this.deps.projects.get(r));
  }

  private byId(id: string): ExtensionDecisionRow | undefined {
    return this.deps.db
      .select()
      .from(extensionDecisions)
      .where(eq(extensionDecisions.id, id))
      .get();
  }

  private openRow(extensionId: string, key: string): ExtensionDecisionRow | undefined {
    return this.deps.db
      .select()
      .from(extensionDecisions)
      .where(
        and(
          eq(extensionDecisions.extensionId, extensionId),
          eq(extensionDecisions.key, key),
          isNull(extensionDecisions.resolvedAt)
        )
      )
      .get();
  }

  private openRows(extensionId: string): ExtensionDecisionRow[] {
    return this.deps.db
      .select()
      .from(extensionDecisions)
      .where(
        and(eq(extensionDecisions.extensionId, extensionId), isNull(extensionDecisions.resolvedAt))
      )
      .all()
      .filter((row) => row.recorded === 0);
  }
}

/** A refusal with its status, code and plain message. */
function refuse(
  status: number,
  code: string,
  message: string
): { ok: false; status: number; code: string; message: string } {
  return { ok: false, status, code, message };
}

/**
 * Actions JSON with a question's `decideBy` left out, to tell a re-raise of
 * the same question (whose relative deadline moved) from a new one.
 *
 * @param actionsJson - The stored or incoming actions.
 */
function withoutDeadline(actionsJson: string): string {
  const actions = parseJson<Record<string, unknown>>(actionsJson);
  if (!actions || actions.kind !== 'choice') return actionsJson;
  const { decideBy: _moving, ...rest } = actions;
  return JSON.stringify(rest);
}

/**
 * Whether a resolution agrees with what a person chose: 👍 is `approved`, 👎
 * is `rejected`, a word or a choice is `answered`.
 *
 * @param action - What the person chose.
 * @param outcome - How the extension is settling it.
 */
function agrees(action: PendingAction['action'], outcome: DecisionOutcome): boolean {
  if (action === 'approve') return outcome === 'approved';
  if (action === 'reject') return outcome === 'rejected';
  return outcome === 'answered';
}

/** A response for an answer that did not settle the decision. */
function noChange(
  message: string | null,
  navigate: string | null,
  watch: DecisionWatch | null
): DecisionActionResponse {
  return { resolved: false, message, navigate, offer: null, watch };
}

let current: ExtensionInboxService | null = null;

/**
 * Install the live inbox. Called once by the composition root.
 *
 * @param service - The service, or null to tear it down.
 */
export function setExtensionInbox(service: ExtensionInboxService | null): void {
  current?.stop();
  current = service;
  // A push counts the projects open when it is sent, not when the first row was.
  setOpenProjectCounter(service ? (extensionId) => service.openProjectCount(extensionId) : null);
}

/** The live inbox, or null before boot wired one. */
export function getExtensionInbox(): ExtensionInboxService | null {
  return current;
}
