/**
 * The status reads a Never ask run may call (DOR-3971): a short, named list, each with its reason.
 *
 * Under `dontAsk` Claude Code refuses every tool its allow rules don't name before DorkOS is asked,
 * so an unattended watchdog could not see which chats run or how its runs went. In Ask first and
 * Accept edits these reads still ask, as before; this list is read only at Never ask, where nobody
 * can be asked.
 *
 * **Named, never derived from the tier** (Security, Nov 8). Some `observe` tools return other
 * people's words: transcripts, the audit log, connector reads, room history and chat reads. A run
 * that reads those and then writes a summary somewhere is a quiet leak path, so they are not here
 * and stay opt-in per task. (Room reads and `chat_read` already run on an agent's identity at
 * Never ask, DOR-3042; this list adds nothing to them.) A tool joins only with a one-line reason
 * Security has read, and the reason says plainly what comes back.
 * `never-ask-status-reads.test.ts` pins each entry to a real `observe` tool.
 *
 * Three of them answer narrower at Never ask, told so per call by the in-session server
 * (`neverAsks`, Security on DOR-3971): `running_chats` leaves every title out, since a stranger can
 * name a bridged group, and `tasks_get_run_history` and `heartbeat_status` leave out each run's and
 * each beat's summary, which is an agent's own words about what it read.
 *
 * What these return is the owner's working data, so the Never ask hook (`never-ask-hook.ts`) runs
 * them only for the server DorkOS registered, and never in a turn that carries an outsider's
 * words: a stranger's own, one our agents passed on, one marked by a line it read, or one the
 * DOR-4029 test (`chatReadOutsideWords`) says read outside words, as memory and `chat_send` read
 * it. A teammate's turn still runs them, as it runs the agent's own connection reads.
 *
 * @module services/runtimes/claude-code/tool-gate/never-ask-status-reads
 */
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';

/** Each status read, by bare tool name, and why a Never ask run may call it. */
export const NEVER_ASK_STATUS_READS: Readonly<Record<string, string>> = {
  running_chats:
    'Which chats run right now, per agent: links and states, with every title left out at Never ask; a person’s own chat is only counted.',
  tasks_get_run_history:
    'Any schedule’s run records, by id: when each ran, how it ended and what it was refused, with each run’s summary left out at Never ask.',
  agents_recent_activity: 'When each agent last worked: one timestamp per agent.',
  heartbeat_status:
    'How an agent wakes and how its beats went: its schedule, outcomes and counts, with each beat’s summary left out at Never ask.',
};

/** The same reads by their in-session names, which the Never ask hook sees. */
export const NEVER_ASK_STATUS_READS_QUALIFIED: ReadonlySet<string> = new Set(
  Object.keys(NEVER_ASK_STATUS_READS).map(inSessionToolName)
);
