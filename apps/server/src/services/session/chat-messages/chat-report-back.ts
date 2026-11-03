/**
 * Spin-off chats report back on their own (spec `spin-off-chats` §5, ADR
 * 261009-171114): built into the server, not left to the agent's memory.
 *
 * ## When a report goes
 *
 * A chat another chat started (`session_started_by.kind = 'chat'`, with
 * `report_back` on) sends its parent a `report` chat message:
 *
 * - when one of its turns ENDS finished, failed, stopped, or paused at an
 *   account limit (`turn_end` on its projector, whatever started the turn: the
 *   parent's message, a person typing in the spin-off, or a turn the agent
 *   started on its own when a helper finished);
 * - when it starts WAITING ON THE PERSON (an approval, a question), once per
 *   ask, because that turn does not end until somebody answers.
 *
 * ## When nothing goes
 *
 * A stop the parent itself made is not reported back to it. A turn that said
 * nothing and finished (a summary the agent asked for) sends nothing.
 *
 * ## A turn that ended holding work
 *
 * A turn that finishes while the agent still holds background work (a helper, a
 * CI watch, a timer, a delivery the process still owes;
 * `AgentRuntime.holdsBackgroundWork`) may have ended only to wait, so its report
 * waits too. It is not given up on: "holding" does not promise a later turn. A
 * delivery owed can expire with nothing following it, and a process can be
 * reclaimed with its shell inside it (DOR-3720: every such report was lost, and
 * nobody heard). So the report is checked on every {@link DEFER_RECHECK_MS}:
 *
 * - a later turn ends first: that turn reports, and this one is dropped, falling
 *   back to its words only if the later turn said nothing;
 * - the work is released with no turn open: this one goes;
 * - {@link DEFER_MAX_MS} passes and the work runs on: it goes saying so, and the
 *   turn that finishes the work reports as usual.
 *
 * The report and a later turn's cannot both go for one ending: the wait lives in
 * one entry per chat, a turn's end takes it, and the send re-reads it after the
 * settle. A failed or stopped turn, or one at a limit, reports at once, because
 * the parent needs to hear that whatever the agent still holds.
 *
 * ## What it says
 *
 * One plain status line and the spin-off's last message in that turn, trimmed
 * to {@link REPORT_TEXT_MAX}; the parent reads the rest with `chat_read`. It
 * rides `chat_send`'s own rules (queue by default, the person first, batching,
 * the spin-off's level as the ceiling), so a parent busy with its person hears
 * the report when that turn ends, and an idle parent wakes.
 *
 * ## Into a room's seat
 *
 * A parent that is an agent's seat in a room (the session the room keeps for
 * it) takes no chat messages, so a report there goes through the room instead
 * (`toRoomSeat`, `rooms/handoff/seat-report.ts`, DOR-3488): it wakes the seat
 * with a private turn that carries the report, once the seat is free. Nothing
 * is posted into the room unless the seat's turn decides the room needs it.
 *
 * ## A report that cannot be delivered
 *
 * It is logged and tried again on {@link DELIVERY_RETRY_MS}, with the parent read
 * afresh each time. A report that never
 * lands ends in one error line naming the chat and its parent. Reports wait in
 * this process: a restart loses one still waiting, though a chat that was holding
 * work is woken at the next boot (`wake-cut-short-work.ts`) and reports then.
 *
 * @module services/session/chat-messages/chat-report-back
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { logError, logger } from '../../../lib/logger.js';
import { mergeMarks, NO_MARKS, type TurnMarks } from '../../core/turn-power/turn-marks.js';
import type { ChatCaller, ChatMessageService } from './chat-message-service.js';
import type { ChatMessageStore } from './chat-message-store.js';

/** The longest last message a report carries; the parent reads more with `chat_read`. */
export const REPORT_TEXT_MAX = 6_000;

/** How long after a turn ends the report reads the chat's words, so the runtime has written them. */
export const REPORT_SETTLE_MS = 750;

/** A stop the parent made within this long of a turn ending is the parent's own, not news. */
const OWN_STOP_WINDOW_MS = 60_000;

/** How often a report waiting on background work looks again. */
export const DEFER_RECHECK_MS = 5_000;

/** The longest a report waits on background work before it goes anyway. */
export const DEFER_MAX_MS = 15 * 60_000;

/** The waits before each new try at a report that could not be delivered. */
export const DELIVERY_RETRY_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/** Why a report went. */
export type ReportReason = 'finished' | 'failed' | 'stopped' | 'limit' | 'needs-you' | 'holding';

/** The status line each reason opens a report with. */
const STATUS_LINE: Record<ReportReason, string> = {
  finished: 'Finished this turn.',
  failed: 'This turn failed.',
  stopped: 'This turn was stopped.',
  limit: 'Paused: the account this chat runs on hit its usage limit.',
  'needs-you': 'Waiting on the person to answer before it can go on.',
  holding: 'Ended this turn with background work still running. More may come.',
};

/** The Sent-card label each reason gets. */
const SUMMARY: Record<ReportReason, string> = {
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  limit: 'Paused at a usage limit',
  'needs-you': 'Needs the person',
  holding: 'Still working',
};

/** The parent a chat reports to, when it reports. */
export interface ReportTarget {
  /** The parent chat. */
  parentSessionId: string;
}

/** A report on its way to a room seat. */
export interface RoomSeatReport {
  /** The spin-off. */
  fromSessionId: string;
  /** Its agent home. */
  fromAgentPath: string;
  /** The report. */
  text: string;
  /** The marks of the turn it speaks for, read when that turn ended. */
  marks?: TurnMarks;
}

/** What report-back needs. */
export interface ChatReportBackDeps {
  /** The sender. */
  service: Pick<ChatMessageService, 'send'>;
  /** The chat-message store (stops and interrupts). */
  store: Pick<ChatMessageStore, 'listStopsOf' | 'latestInterruptFrom'>;
  /** The parent a chat reports to, or null when it does not report. */
  reportTargetOf: (sessionId: string) => ReportTarget | null;
  /** The chat's agent home, or null. */
  agentPathOf: (sessionId: string) => Promise<string | null>;
  /** The marks the chat's latest turn carries. Read as a turn ends, before anything can change it. */
  marksOfTurn?: (sessionId: string) => TurnMarks;
  /** Whether the chat's agent still holds background work. */
  holdsBackgroundWork: (sessionId: string) => Promise<boolean>;
  /** The chat's live status, or null. */
  statusOf: (sessionId: string) => SessionStatus | null;
  /** The chat's history. */
  history: (sessionId: string) => Promise<HistoryMessage[]>;
  /**
   * Deliver a report to a parent that is a room's seat, as a turn there (DOR-3488). False when
   * the parent is no room's seat, and the report goes as a chat message instead. Throws when it
   * is a seat and the report did not reach it.
   */
  toRoomSeat?: (parentSessionId: string, report: RoomSeatReport) => Promise<boolean>;
  /** Wait (tests make it immediate). */
  delay?: (ms: number) => Promise<void>;
  /** Run something later, without holding the process open (tests run it by hand). */
  later?: (ms: number, run: () => void) => void;
  /** The clock (tests pin it). */
  now?: () => number;
}

/** How far either side of a turn a message may be stamped and still belong to it. */
const TURN_GRACE_MS = 1_000;

/** When a turn ran (epoch ms); either end may be unknown. */
export interface TurnWindow {
  /** When it started. */
  from?: number;
  /** When it ended. */
  to?: number;
}

/** A report waiting on background work: one per chat, taken by whatever ends the wait. */
interface DeferredReport {
  /** The turn the report is for. */
  window: TurnWindow;
  /** When the wait began. */
  since: number;
  /** When the oldest turn still unreported started, if an earlier one waited too. */
  earliestFrom?: number;
  /** The marks of every turn it may speak for, read as each ended. */
  marks: TurnMarks;
}

/** Wait, without holding the process open for it. */
function unrefTimer(ms: number, run: () => void): void {
  setTimeout(run, ms).unref?.();
}

/**
 * The words of the chat's latest turn, joined; empty when the turn said
 * nothing.
 *
 * With a window, the words are the agent's messages stamped inside it, so a
 * message that started the NEXT turn (queued behind this one) cannot hide this
 * turn's words or lend it the next turn's, and a turn that said nothing never
 * borrows an earlier turn's. Messages somebody sent carry no time in every
 * runtime's history (Claude Code's do not), so only the agent's own messages
 * are read by time; a history with no times at all falls back to "the agent's
 * messages after the last one it was sent".
 *
 * @param history - The chat's history, in order.
 * @param window - When the turn ran, when known.
 */
export function lastTurnText(history: readonly HistoryMessage[], window?: TurnWindow): string {
  const timed = history.some((m) => m.role === 'assistant' && m.timestamp);
  if (window && timed) {
    const from = window.from !== undefined ? window.from - TURN_GRACE_MS : -Infinity;
    const to = window.to !== undefined ? window.to + TURN_GRACE_MS : Infinity;
    return history
      .filter((m) => {
        if (m.role !== 'assistant' || !m.timestamp) return false;
        const at = Date.parse(m.timestamp);
        return at >= from && at <= to;
      })
      .map((m) => m.content.trim())
      .filter((t) => t !== '')
      .join('\n\n');
  }
  let start = history.length;
  while (start > 0 && history[start - 1]!.role === 'assistant') start -= 1;
  return history
    .slice(start)
    .map((m) => m.content.trim())
    .filter((t) => t !== '')
    .join('\n\n');
}

/**
 * The report a spin-off sends its parent.
 *
 * @param reason - Why it goes.
 * @param text - The spin-off's last words.
 * @param detail - A further line, when there is one (the question it waits on).
 */
export function composeReport(reason: ReportReason, text: string, detail?: string): string {
  const parts = [STATUS_LINE[reason]];
  if (detail) parts.push(detail);
  if (text) {
    const cut = text.length > REPORT_TEXT_MAX;
    parts.push(cut ? `${text.slice(0, REPORT_TEXT_MAX)}…` : text);
    if (cut) parts.push('(Cut short. Read the rest with chat_read.)');
  }
  return parts.join('\n\n');
}

/**
 * The note a spin-off reads at its start (spec `spin-off-chats` §5): who
 * started it, and how it reports. Every word is DorkOS's own except the
 * parent's title and agent name, which DorkOS also holds.
 *
 * A parent that cannot take chat messages (a room's seat, a bridged chat, a
 * scheduled run) is never named as a `chat_send` target: every such send is
 * refused, and the spin-off would conclude the parent is unreachable. A room's
 * seat still takes reports, as turns of its own (DOR-3488).
 *
 * @param opts - The parent, whether reports go back on their own, whether the
 *   parent takes chat messages at all, and whether it is a room's seat.
 */
export function spinOffBriefing(opts: {
  parentChatId: string;
  parentTitle: string | null;
  parentAgentName: string;
  reportBack: boolean;
  parentTakesMessages: boolean;
  parentIsRoomSeat?: boolean;
}): string {
  const parent = `${opts.parentTitle ? `"${opts.parentTitle}" ` : ''}(chat ${opts.parentChatId}, ${opts.parentAgentName})`;
  const lines = [`This is a spin-off chat. The chat ${parent} started it.`];
  if (opts.reportBack) {
    lines.push(
      'When you end a turn finished, failed, waiting on the person, or paused at a usage ' +
        'limit, your last message goes back to that chat on its own. So end each turn with a ' +
        'short report: what you did and what is left.',
      opts.parentIsRoomSeat
        ? 'That chat is its agent’s seat in a room, so it takes no chat_send: your report wakes ' +
            'it with a turn of its own, and nobody else in the room sees it. Put milestones in ' +
            'your turn-end reports.'
        : `Send milestones before then with chat_send to ${opts.parentChatId}; nobody has to ` +
            'ask. Do not send your final result that way too: it already goes back on its own.',
      'If you are waiting on CI, a timer or a helper, keep your turn alive (for example ' +
        '`gh pr checks --watch` or a short sleep loop). A turn that ends only to wait may report ' +
        'before the work is done.'
    );
  } else if (opts.parentTakesMessages) {
    lines.push(
      `It does not hear from you on its own. Send what matters with chat_send to ${opts.parentChatId}.`
    );
  } else {
    lines.push(
      'It does not hear from you on its own, and it cannot take chat messages. If it works in ' +
        'a room you are in, report there with post_to_room; otherwise say it in your own last ' +
        'message.'
    );
  }
  return lines.join(' ');
}

/** Spin-off chats reporting back. See the module documentation. */
export class ChatReportBack {
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly later: (ms: number, run: () => void) => void;
  /** Waits already reported, so one wait sends one report. */
  private readonly reportedAsks = new Set<string>();
  /** Reports waiting on background work, by chat. */
  private readonly deferred = new Map<string, DeferredReport>();

  /**
   * Build it.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: ChatReportBackDeps) {
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => unrefTimer(ms, resolve)));
    this.now = deps.now ?? Date.now;
    this.later = deps.later ?? unrefTimer;
  }

  /**
   * A turn ended on a chat. Reports when the chat is a spin-off that reports
   * and there is something to say; a finished turn still holding work waits
   * (see the module documentation).
   *
   * Called synchronously from the turn boundary: `ended` is the chat's status
   * at that instant, before a queued message can start the next turn and
   * change it, and `endedAt` is when, so the words read later are the ones
   * that turn said and not the next one's.
   *
   * @param sessionId - The chat.
   * @param ended - The chat's status as the turn ended, or null.
   * @param window - When the turn started and ended (epoch ms).
   * @returns The reason a report went, or null when none did (yet).
   */
  async onTurnEnd(
    sessionId: string,
    ended: SessionStatus | null,
    window: TurnWindow = { to: this.now() }
  ): Promise<ReportReason | null> {
    const target = this.deps.reportTargetOf(sessionId);
    if (!target) return null;
    const reason = reasonOf(ended);
    if (reason === null) return null;
    // This turn's ending takes any earlier wait, in this tick: the earlier report
    // can no longer go on its own. Its marks stay with the report, and this turn's are
    // read now, because the chat's next turn replaces them and a report can outlive it.
    const earlier = this.deferred.get(sessionId);
    this.deferred.delete(sessionId);
    const earliestFrom = earlier?.earliestFrom ?? earlier?.window.from;
    const marks = mergeMarks(this.marksOfTurn(sessionId), earlier?.marks ?? NO_MARKS);
    if (reason === 'finished' && (await this.isHolding(sessionId, ended))) {
      this.defer(sessionId, {
        window,
        marks,
        since: this.now(),
        ...(earliestFrom !== undefined ? { earliestFrom } : {}),
      });
      return null;
    }
    if (reason === 'stopped' && this.stoppedByParent(sessionId, target.parentSessionId)) {
      return null;
    }
    await this.delay(REPORT_SETTLE_MS);
    const history = await this.deps.history(sessionId).catch(() => []);
    // A later turn that said nothing (a delivery with no words) must not swallow
    // the words of the turn that waited for it.
    const text =
      lastTurnText(history, window) ||
      (earlier ? lastTurnText(history, { from: earliestFrom, to: window.from }) : '');
    if (reason === 'finished' && text === '') return null;
    // A refused turn says nothing, so its words alone would report only "failed"
    // (DOR-3167). The runtime's reason goes with it.
    const why = reason === 'failed' ? ended?.lastError?.message : undefined;
    await this.report(sessionId, target, reason, marks, text, why);
    return reason;
  }

  /** The marks the chat's latest turn carries. */
  private marksOfTurn(sessionId: string): TurnMarks {
    return this.deps.marksOfTurn?.(sessionId) ?? NO_MARKS;
  }

  /** Whether the chat still holds a helper or background work. */
  private async isHolding(sessionId: string, status: SessionStatus | null): Promise<boolean> {
    if ((status?.runningSubagentCount ?? 0) > 0) return true;
    return this.deps.holdsBackgroundWork(sessionId).catch(() => false);
  }

  /** Whether more may still come on this chat: a turn open, or work held. */
  private async isBusy(sessionId: string): Promise<boolean> {
    const status = this.deps.statusOf(sessionId);
    if (status?.lifecycle === 'streaming' || status?.lifecycle === 'blocked') return true;
    return this.isHolding(sessionId, status);
  }

  /** Make a report wait, and start looking again. */
  private defer(sessionId: string, entry: DeferredReport): void {
    this.deferred.set(sessionId, entry);
    this.recheckLater(sessionId, entry);
  }

  /** Look at a waiting report again after {@link DEFER_RECHECK_MS}. */
  private recheckLater(sessionId: string, entry: DeferredReport): void {
    this.later(DEFER_RECHECK_MS, () => {
      void this.recheck(sessionId, entry).catch((err: unknown) =>
        logger.warn('[chat report-back] a waiting report could not be checked', {
          sessionId,
          ...logError(err),
        })
      );
    });
  }

  /**
   * Look at a waiting report. It goes once nothing more may come, or once it
   * has waited {@link DEFER_MAX_MS}; otherwise it waits on. A turn's end that
   * took the entry meanwhile has the word, here and after the settle, which is
   * what keeps one ending from reporting twice.
   */
  private async recheck(sessionId: string, entry: DeferredReport): Promise<void> {
    if (this.deferred.get(sessionId) !== entry) return;
    const overdue = this.now() - entry.since >= DEFER_MAX_MS;
    let busy = await this.isBusy(sessionId);
    if (busy && !overdue) return this.recheckLater(sessionId, entry);
    // A delivery segment clears the debt a moment before its turn shows as open,
    // so "released" is only believed once it has stayed true through the settle.
    await this.delay(REPORT_SETTLE_MS);
    if (this.deferred.get(sessionId) !== entry) return;
    busy = await this.isBusy(sessionId);
    // A turn can end during that await too.
    if (this.deferred.get(sessionId) !== entry) return;
    if (busy && !overdue) return this.recheckLater(sessionId, entry);
    this.deferred.delete(sessionId);
    const target = this.deps.reportTargetOf(sessionId);
    if (!target) return;
    const history = await this.deps.history(sessionId).catch(() => []);
    const text =
      lastTurnText(history, entry.window) ||
      (entry.earliestFrom !== undefined
        ? lastTurnText(history, { from: entry.earliestFrom, to: entry.window.from })
        : '');
    const reason: ReportReason = busy ? 'holding' : 'finished';
    if (reason === 'finished' && text === '') return;
    await this.report(sessionId, target, reason, entry.marks, text);
  }

  /**
   * A chat started waiting on the person (an approval, a question, a DorkOS
   * capability hold). Reports once per wait, after a short settle and only if
   * it is still waiting, so an ask answered at once wakes nobody.
   *
   * @param sessionId - The chat.
   * @param wait - A key for this wait, and what it asks in plain words.
   * @returns Whether a report went.
   */
  async onWaiting(sessionId: string, wait: { key: string; what: string }): Promise<boolean> {
    const target = this.deps.reportTargetOf(sessionId);
    if (!target) return false;
    const marks = this.marksOfTurn(sessionId);
    if (this.reportedAsks.has(wait.key)) return false;
    this.reportedAsks.add(wait.key);
    if (this.reportedAsks.size > 5_000) {
      const oldest = this.reportedAsks.values().next().value;
      if (oldest !== undefined) this.reportedAsks.delete(oldest);
    }
    await this.delay(REPORT_SETTLE_MS);
    if (this.deps.statusOf(sessionId)?.lifecycle !== 'blocked') return false;
    const text = lastTurnText(await this.deps.history(sessionId).catch(() => []));
    await this.report(sessionId, target, 'needs-you', marks, text, wait.what);
    return true;
  }

  /**
   * Whether the parent itself stopped this chat just now: with `chat_stop`,
   * or by sending it a message with `delivery: 'interrupt'`.
   */
  private stoppedByParent(sessionId: string, parentSessionId: string): boolean {
    const recent = (iso: string) => this.now() - Date.parse(iso) < OWN_STOP_WINDOW_MS;
    const stop = this.deps.store.listStopsOf(sessionId).at(-1);
    if (stop && stop.fromSessionId === parentSessionId && recent(stop.createdAt)) return true;
    const interrupt = this.deps.store.latestInterruptFrom(parentSessionId, sessionId);
    return interrupt !== undefined && recent(interrupt.createdAt);
  }

  /**
   * Send one report, from the spin-off to its parent, trying again when it
   * cannot be delivered. Never throws. Every try carries the marks read when the
   * turn ended: the chat's next turn may have none, and these words are still marked.
   */
  private async report(
    sessionId: string,
    target: ReportTarget,
    reason: ReportReason,
    marks: TurnMarks,
    text: string,
    detail?: string
  ): Promise<void> {
    const message = composeReport(reason, text, detail);
    for (let attempt = 0; ; attempt += 1) {
      // Read afresh: a parent carried to another account while this waited gets it there.
      const parent = (this.deps.reportTargetOf(sessionId) ?? target).parentSessionId;
      try {
        await this.deliver(sessionId, parent, reason, marks, message);
        return;
      } catch (err) {
        const wait = DELIVERY_RETRY_MS[attempt];
        const fields = { sessionId, parent, reason, attempt: attempt + 1, ...logError(err) };
        if (wait === undefined) {
          logger.error('[chat report-back] gave up on a report; its parent never got it', fields);
          return;
        }
        logger.warn('[chat report-back] a spin-off could not report to the chat that started it', {
          ...fields,
          retryInMs: wait,
        });
        await this.delay(wait);
      }
    }
  }

  /** One try at a report. Throws when it did not land. */
  private async deliver(
    sessionId: string,
    parent: string,
    reason: ReportReason,
    marks: TurnMarks,
    message: string
  ): Promise<void> {
    const agentPath = await this.deps.agentPathOf(sessionId).catch(() => null);
    if (!agentPath) throw new Error('The chat has no agent home to report as.');
    // A room's seat takes no chat messages: the report wakes the seat with a turn of its own.
    const toSeat = this.deps.toRoomSeat;
    if (
      toSeat &&
      (await toSeat(parent, {
        fromSessionId: sessionId,
        fromAgentPath: agentPath,
        text: message,
        marks,
      }))
    ) {
      return;
    }
    const caller: ChatCaller = { sessionId, agentPath, marksAtTurnEnd: marks };
    await this.deps.service.send(
      caller,
      { to: parent, message, summary: SUMMARY[reason] },
      'report'
    );
  }
}

/**
 * Why a turn that just ended is worth a report, read off the chat's status:
 * null when it is still waiting on the person (that wait reports on its own),
 * and `finished` when no live status says otherwise.
 *
 * @param status - The chat's live status, or null.
 */
export function reasonOf(status: SessionStatus | null): Exclude<ReportReason, 'holding'> | null {
  if (!status) return 'finished';
  if (status.limit) return 'limit';
  switch (status.lifecycle) {
    case 'error':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    case 'blocked':
      return null;
    default:
      return 'finished';
  }
}
