/**
 * The status reads a Never ask run may call (DOR-3971): a short, named list, each with its reason.
 *
 * Under `dontAsk` Claude Code refuses every tool its allow rules don't name before DorkOS is asked,
 * so an unattended watchdog could not see which chats run or how its own runs went. Those reads
 * were refused at Never ask, and only there: no other mode needs this list.
 *
 * **Named, never derived from the tier** (Security, Nov 8). Some `observe` tools return other
 * people's words: room history, chat reads, transcripts, the audit log, connector reads. A run that
 * reads those and then writes a summary somewhere is a quiet leak path, so they are not here and
 * stay opt-in per task. A tool joins only with a one-line reason Security has read.
 * `never-ask-status-reads.test.ts` pins each entry to a real `observe` tool.
 *
 * The Never ask hook (`never-ask-hook.ts`) lets these run for the server DorkOS registered, and
 * not in a stranger's turn, the same bound the always-on reads have. Everything else at Never ask
 * is decided exactly as before.
 *
 * @module services/runtimes/claude-code/tool-gate/never-ask-status-reads
 */
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';

/** Each status read, by bare tool name, and why a Never ask run may call it. */
export const NEVER_ASK_STATUS_READS: Readonly<Record<string, string>> = {
  running_chats:
    'Which chats run right now, per agent: titles, links and states, never a message; a person’s own chat is only counted.',
  tasks_get_run_history:
    'A schedule’s own run records: when each ran, how it ended, what it was refused, and the summary our own run wrote.',
  agents_recent_activity: 'When each agent last worked: one timestamp per agent.',
  heartbeat_status:
    'How an agent wakes and how its beats went: its schedule, counts and record lines, readable by everyone in the space.',
};

/** The same reads by their in-session names, which the Never ask hook sees. */
export const NEVER_ASK_STATUS_READS_QUALIFIED: ReadonlySet<string> = new Set(
  Object.keys(NEVER_ASK_STATUS_READS).map(inSessionToolName)
);
