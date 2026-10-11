/**
 * What an agent's next report carries (spec `heartbeats` §9.3): its queued
 * lines for the reader, and the record lines of its beat turns since its last
 * report. The report beat and the Heartbeat page read the same answer, so the
 * page's count is what the report will say.
 *
 * - **A window, even for the first report.** Beat turns count from the later
 *   of the last report and one report period ago (a day, or a week for
 *   `weekly`), so a first report never sums up months.
 * - **A cap.** At most {@link REPORT_TURNS_MAX} beat lines, the latest, with a
 *   line saying how many earlier ones were left out.
 *
 * @module services/heartbeats/raises/report-material
 */
import type { HeartbeatReport } from '@dorkos/shared/heartbeat-schemas';
import type { HeartbeatReportItemRow } from '@dorkos/db';
import type { RaiseStore } from './raise-store.js';

/** The most beat lines one report carries. */
export const REPORT_TURNS_MAX = 30;

/** One day, in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** What one report will carry. */
export interface ReportMaterialRows {
  /** The queued lines for this reader. */
  mine: HeartbeatReportItemRow[];
  /** Every queued line, others' included. */
  all: HeartbeatReportItemRow[];
  /** The beat lines, capped, with an "and N earlier" line when cut. */
  turns: string[];
  /** How many lines the report carries: what the page counts. */
  count: number;
}

/**
 * What an agent's next report to a reader carries.
 *
 * @param raises - The report queue.
 * @param input - The agent, its reader, its last report, its cadence and the moment.
 * @param input.agentId - The agent.
 * @param input.reader - Who the report goes to.
 * @param input.lastReportAt - When its last report went out, or null.
 * @param input.cadence - `report:` from `HEARTBEAT.md`.
 * @param input.now - Epoch ms.
 */
export function reportMaterial(
  raises: Pick<RaiseStore, 'queuedItems' | 'turnSummariesSince'>,
  input: {
    agentId: string;
    reader: string;
    lastReportAt: string | null;
    cadence: HeartbeatReport;
    now: number;
  }
): ReportMaterialRows {
  const all = raises.queuedItems(input.agentId);
  const mine = all.filter((item) => item.toAccount === null || item.toAccount === input.reader);
  const period = input.cadence === 'weekly' ? 7 * DAY_MS : DAY_MS;
  const floor = new Date(input.now - period).toISOString();
  const since = input.lastReportAt && input.lastReportAt > floor ? input.lastReportAt : floor;
  const lines = raises
    .turnSummariesSince(input.agentId, since)
    .map((turn) => turn.summary)
    .filter((line) => line.length > 0);
  const cut = lines.length - REPORT_TURNS_MAX;
  const turns = cut > 0 ? [...lines.slice(cut), `And ${cut} earlier beats.`] : lines;
  return { mine, all, turns, count: mine.length + Math.min(lines.length, REPORT_TURNS_MAX) };
}
