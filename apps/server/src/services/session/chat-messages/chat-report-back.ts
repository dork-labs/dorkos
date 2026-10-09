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
 * A turn that ends while the agent still holds background work (a helper, a
 * CI watch, a timer) ended only to wait: more is coming, so nothing is sent,
 * and the report follows the later turn that ends holding nothing
 * (`AgentRuntime.holdsBackgroundWork`). A stop the parent itself made is not
 * reported back to it. A turn that said nothing and finished (a summary the
 * agent asked for) sends nothing.
 *
 * ## What it says
 *
 * One plain status line and the spin-off's last message in that turn, trimmed
 * to {@link REPORT_TEXT_MAX}; the parent reads the rest with `chat_read`. It
 * rides `chat_send`'s own rules (queue by default, the person first, batching,
 * the spin-off's level as the ceiling), so a parent busy with its person hears
 * the report when that turn ends, and an idle parent wakes.
 *
 * @module services/session/chat-messages/chat-report-back
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { logError, logger } from '../../../lib/logger.js';
import type { ChatCaller, ChatMessageService } from './chat-message-service.js';
import type { ChatMessageStore } from './chat-message-store.js';

/** The longest last message a report carries; the parent reads more with `chat_read`. */
export const REPORT_TEXT_MAX = 6_000;

/** How long after a turn ends the report reads the chat's words, so the runtime has written them. */
export const REPORT_SETTLE_MS = 750;

/** A stop the parent made within this long of a turn ending is the parent's own, not news. */
const OWN_STOP_WINDOW_MS = 60_000;

/** Why a report went. */
export type ReportReason = 'finished' | 'failed' | 'stopped' | 'limit' | 'needs-you';

/** The status line each reason opens a report with. */
const STATUS_LINE: Record<ReportReason, string> = {
  finished: 'Finished this turn.',
  failed: 'This turn failed.',
  stopped: 'This turn was stopped.',
  limit: 'Paused: the account this chat runs on hit its usage limit.',
  'needs-you': 'Waiting on the person to answer before it can go on.',
};

/** The Sent-card label each reason gets. */
const SUMMARY: Record<ReportReason, string> = {
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  limit: 'Paused at a usage limit',
  'needs-you': 'Needs the person',
};

/** The parent a chat reports to, when it reports. */
export interface ReportTarget {
  /** The parent chat. */
  parentSessionId: string;
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
  /** Whether the chat's agent still holds background work. */
  holdsBackgroundWork: (sessionId: string) => Promise<boolean>;
  /** The chat's live status, or null. */
  statusOf: (sessionId: string) => SessionStatus | null;
  /** The chat's history. */
  history: (sessionId: string) => Promise<HistoryMessage[]>;
  /** Wait (tests make it immediate). */
  delay?: (ms: number) => Promise<void>;
  /** The clock (tests pin it). */
  now?: () => number;
}

/** How far past a turn's end a message may be stamped and still belong to it. */
const TURN_END_GRACE_MS = 1_000;

/**
 * The words of the chat's latest turn: the assistant messages after the last
 * message somebody sent it, joined. Empty when the turn said nothing.
 *
 * With `endedAt`, messages stamped after the turn ended are left out first, so
 * a message that started the NEXT turn (queued behind this one) cannot hide
 * this turn's words or lend it the next turn's.
 *
 * @param history - The chat's history, in order.
 * @param endedAt - When the turn ended (epoch ms), when known.
 */
export function lastTurnText(history: readonly HistoryMessage[], endedAt?: number): string {
  const upTo =
    endedAt === undefined
      ? history
      : history.filter(
          (m) => !m.timestamp || Date.parse(m.timestamp) <= endedAt + TURN_END_GRACE_MS
        );
  let start = upTo.length;
  while (start > 0 && upTo[start - 1]!.role === 'assistant') start -= 1;
  return upTo
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
 * @param opts - The parent and whether reports go back on their own.
 */
export function spinOffBriefing(opts: {
  parentChatId: string;
  parentTitle: string | null;
  parentAgentName: string;
  reportBack: boolean;
}): string {
  const parent = `${opts.parentTitle ? `"${opts.parentTitle}" ` : ''}(chat ${opts.parentChatId}, ${opts.parentAgentName})`;
  const lines = [`This is a spin-off chat. The chat ${parent} started it.`];
  if (opts.reportBack) {
    lines.push(
      'When you end a turn finished, failed, waiting on the person, or paused at a usage ' +
        'limit, your last message goes back to that chat on its own. So end each turn with a ' +
        'short report: what you did and what is left.',
      `Send milestones before then with chat_send to ${opts.parentChatId}; nobody has to ask.`,
      'If you are waiting on CI, a timer or a helper, keep your turn alive (for example ' +
        '`gh pr checks --watch` or a short sleep loop). A turn that ends only to wait sends nothing.'
    );
  } else {
    lines.push(
      `It does not hear from you on its own. Send what matters with chat_send to ${opts.parentChatId}.`
    );
  }
  return lines.join(' ');
}

/** Spin-off chats reporting back. See the module documentation. */
export class ChatReportBack {
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Waits already reported, so one wait sends one report. */
  private readonly reportedAsks = new Set<string>();

  /**
   * Build it.
   *
   * @param deps - What it needs.
   */
  constructor(private readonly deps: ChatReportBackDeps) {
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  /**
   * A turn ended on a chat. Reports when the chat is a spin-off that reports,
   * the turn did not end only to wait, and there is something to say.
   *
   * Called synchronously from the turn boundary: `ended` is the chat's status
   * at that instant, before a queued message can start the next turn and
   * change it, and `endedAt` is when, so the words read later are the ones
   * that turn said and not the next one's.
   *
   * @param sessionId - The chat.
   * @param ended - The chat's status as the turn ended, or null.
   * @param endedAt - When the turn ended (epoch ms).
   * @returns The reason a report went, or null when none did.
   */
  async onTurnEnd(
    sessionId: string,
    ended: SessionStatus | null,
    endedAt: number = this.now()
  ): Promise<ReportReason | null> {
    const target = this.deps.reportTargetOf(sessionId);
    if (!target) return null;
    // Ended only to wait: a helper still running, or background work the
    // runtime holds. More is coming; the turn that ends holding nothing reports.
    if ((ended?.runningSubagentCount ?? 0) > 0) return null;
    if (await this.deps.holdsBackgroundWork(sessionId).catch(() => false)) return null;
    const reason = reasonOf(ended);
    if (reason === null) return null;
    if (reason === 'stopped' && this.stoppedByParent(sessionId, target.parentSessionId)) {
      return null;
    }
    await this.delay(REPORT_SETTLE_MS);
    const text = lastTurnText(await this.deps.history(sessionId).catch(() => []), endedAt);
    if (reason === 'finished' && text === '') return null;
    await this.report(sessionId, target, reason, text);
    return reason;
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
    if (this.reportedAsks.has(wait.key)) return false;
    this.reportedAsks.add(wait.key);
    if (this.reportedAsks.size > 5_000) {
      const oldest = this.reportedAsks.values().next().value;
      if (oldest !== undefined) this.reportedAsks.delete(oldest);
    }
    await this.delay(REPORT_SETTLE_MS);
    if (this.deps.statusOf(sessionId)?.lifecycle !== 'blocked') return false;
    const text = lastTurnText(await this.deps.history(sessionId).catch(() => []));
    await this.report(sessionId, target, 'needs-you', text, wait.what);
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

  /** Send one report, from the spin-off to its parent. */
  private async report(
    sessionId: string,
    target: ReportTarget,
    reason: ReportReason,
    text: string,
    detail?: string
  ): Promise<void> {
    const agentPath = await this.deps.agentPathOf(sessionId).catch(() => null);
    if (!agentPath) return;
    const caller: ChatCaller = { sessionId, agentPath };
    try {
      await this.deps.service.send(
        caller,
        {
          to: target.parentSessionId,
          message: composeReport(reason, text, detail),
          summary: SUMMARY[reason],
        },
        'report'
      );
    } catch (err) {
      logger.warn('[chat report-back] a spin-off could not report to the chat that started it', {
        sessionId,
        parent: target.parentSessionId,
        reason,
        ...logError(err),
      });
    }
  }
}

/**
 * Why a turn that just ended is worth a report, read off the chat's status:
 * null when it is still waiting on the person (that wait reports on its own),
 * and `finished` when no live status says otherwise.
 *
 * @param status - The chat's live status, or null.
 */
export function reasonOf(status: SessionStatus | null): ReportReason | null {
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
