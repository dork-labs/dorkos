/**
 * What a spin-off's report says: why it went, its status line, its Sent-card
 * label, and the composed message. Split out of `chat-report-back.ts`, which
 * is at the line ceiling, when the late-start correction arrived (DOR-4985).
 *
 * @module services/session/chat-messages/report-back/report-words
 */

/** The longest last message a report carries; the parent reads more with `chat_read`. */
export const REPORT_TEXT_MAX = 6_000;

/** Why a report went. */
export type ReportReason =
  'finished' | 'failed' | 'stopped' | 'limit' | 'needs-you' | 'holding' | 'never-started';

/**
 * What a report can say: any {@link ReportReason}, plus the one-time
 * correction a late first turn sends (DOR-4985). The correction is delivered
 * live only, so it is never saved to, or replayed from, the report outbox.
 */
export type ReportNotice = ReportReason | 'started-late';

/** The status line each reason opens a report with. */
const STATUS_LINE: Record<ReportNotice, string> = {
  finished: 'Finished this turn.',
  failed: 'This turn failed.',
  'never-started': 'Failed: never started.',
  'started-late':
    'Started after all. The "never started" report was wrong. If you started another copy, stop it with chat_stop.',
  stopped: 'This turn was stopped.',
  limit: 'Paused: the account this chat runs on hit its usage limit.',
  'needs-you': 'Waiting on the person to answer before it can go on.',
  holding: 'Ended this turn with background work still running. More may come.',
};

/** The Sent-card label each reason gets. */
export const SUMMARY: Record<ReportNotice, string> = {
  finished: 'Finished',
  failed: 'Failed',
  'never-started': 'Failed: never started',
  'started-late': 'Started after all',
  stopped: 'Stopped',
  limit: 'Paused at a usage limit',
  'needs-you': 'Needs the person',
  holding: 'Still working',
};

/**
 * The report a spin-off sends its parent.
 *
 * @param reason - Why it goes.
 * @param text - The spin-off's last words.
 * @param detail - A further line, when there is one (the question it waits on).
 */
export function composeReport(reason: ReportNotice, text: string, detail?: string): string {
  const parts = [STATUS_LINE[reason]];
  if (detail) parts.push(detail);
  if (text) {
    const cut = text.length > REPORT_TEXT_MAX;
    parts.push(cut ? `${text.slice(0, REPORT_TEXT_MAX)}…` : text);
    if (cut) parts.push('(Cut short. Read the rest with chat_read.)');
  }
  return parts.join('\n\n');
}
