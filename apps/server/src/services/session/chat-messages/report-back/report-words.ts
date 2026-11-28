/**
 * What a spin-off's report says: why it went, its status line, its Sent-card
 * label, and the composed message. Split out of `chat-report-back.ts`, which
 * is at the line ceiling, when the late-start correction arrived (DOR-4985).
 *
 * @module services/session/chat-messages/report-back/report-words
 */

/**
 * The longest last message a report carries; the parent reads more with `chat_read`. A cut
 * that lands inside a code block closes it, which can add a few characters past this; the
 * whole report stays far under the send limit.
 */
export const REPORT_TEXT_MAX = 6_000;

/**
 * The longest error, startup reason or question a report carries, its "…"
 * included. A runtime's error can be any length, and a report past the send
 * limit is refused whole, so the parent would hear nothing (DOR-3535).
 */
export const REPORT_DETAIL_MAX = 1_000;

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

/** What a report says of a message a restart lost before the chat read it (spec `turns-survive-restarts` §7.3). */
export const LOST_MESSAGE =
  'DorkOS restarted before this chat read your message, so it was not answered. ' +
  'Send it again if it still matters.';

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

/** What a cut detail ends with, inside {@link REPORT_DETAIL_MAX}. */
const DETAIL_CUT = '… (Details cut short.)';

/** Splits text into the characters a person sees, however many code points each one is. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * At most `max` code units of `s`, never splitting a character a person sees
 * as one: an emoji made of two code units, emoji joined into one, or a letter
 * and its accent. Reads only as far as the cut. One character longer than
 * all of `max` (a letter under thousands of marks) is cut by code point
 * instead, so the cut keeps something.
 */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = 0;
  for (const { index, segment } of GRAPHEMES.segment(s)) {
    if (index + segment.length <= max) {
      end = index + segment.length;
      continue;
    }
    if (segment.length > max) {
      for (const point of segment) {
        if (end + point.length > max) break;
        end += point.length;
      }
    }
    break;
  }
  return s.slice(0, end);
}

/** A code block's opening or closing line: up to three spaces, then three or more ` or ~. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * `s` with the code block it leaves open closed, so the words after a cut are
 * not read as code. A block closes on a line of only its own marker, at least
 * as long; anything else inside it is code. A ``` line with another backtick
 * after the marker is inline code and opens nothing.
 */
function closeOpenBlock(s: string): string {
  let open: string | null = null;
  for (const line of s.split('\n')) {
    const match = FENCE_LINE.exec(line);
    if (match === null) continue;
    const run = match[1]!;
    if (open === null) {
      if (run[0] !== '`' || !line.slice(match[0].length).includes('`')) open = run;
    } else if (run[0] === open[0] && run.length >= open.length && line.trim() === run) open = null;
  }
  return open === null ? s : `${s}${s.endsWith('\n') ? '' : '\n'}${open}\n`;
}

/**
 * A detail cut to {@link REPORT_DETAIL_MAX}, saying so; one that fits comes
 * back as it is. Cutting twice changes nothing, so a detail the outbox saved
 * already cut reads the same when its report is sent after a restart.
 *
 * @param detail - The error, startup reason or question a report carries.
 */
export function cutReportDetail(detail: string): string {
  if (detail.length <= REPORT_DETAIL_MAX) return detail;
  // Closing a code block costs a few characters; cut further until the whole fits.
  for (let room = REPORT_DETAIL_MAX - DETAIL_CUT.length; ;) {
    const cut = `${closeOpenBlock(cutAt(detail, room))}${DETAIL_CUT}`;
    if (cut.length <= REPORT_DETAIL_MAX) return cut;
    room -= cut.length - REPORT_DETAIL_MAX;
  }
}

/**
 * The report a spin-off sends its parent.
 *
 * @param reason - Why it goes.
 * @param text - The spin-off's last words.
 * @param detail - A further line, when there is one (the error, startup reason or question).
 */
export function composeReport(reason: ReportNotice, text: string, detail?: string): string {
  const parts = [STATUS_LINE[reason]];
  if (detail) parts.push(cutReportDetail(detail));
  if (text) {
    const cut = text.length > REPORT_TEXT_MAX;
    parts.push(cut ? `${closeOpenBlock(cutAt(text, REPORT_TEXT_MAX))}…` : text);
    if (cut) parts.push('(Cut short. Read the rest with chat_read.)');
  }
  return parts.join('\n\n');
}
