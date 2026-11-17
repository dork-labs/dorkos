/**
 * The status reads a Never ask run may call (DOR-3971): a short, named list, each with its reason.
 *
 * Under `dontAsk` Claude Code refuses every tool its allow rules don't name before DorkOS is asked,
 * so an unattended watchdog could not see which chats run or how its runs went. In Ask first and
 * Accept edits these reads still ask, as before; this list is read only at Never ask, where nobody
 * can be asked.
 *
 * **Named, never derived from the tier** (Security, Nov 8). Some `observe` tools return other
 * people's words: transcripts, the audit log, connector reads. A run that reads those and then
 * writes a summary somewhere is a quiet leak path, so they are not here and stay opt-in per task.
 * A tool joins only with a one-line reason Security has read, and the reason says plainly what
 * comes back. `never-ask-status-reads.test.ts` pins each entry to a real `observe` tool.
 *
 * What these return is the owner's working data, so the Never ask hook (`never-ask-hook.ts`) runs
 * them only for the server DorkOS registered, and never in a turn that carries an outsider's
 * words: a stranger's own, one our agents passed on, or one marked by a line it read. That is the
 * bound `own-connection-reads.ts` has. A teammate's turn still runs them.
 *
 * @module services/runtimes/claude-code/tool-gate/never-ask-status-reads
 */
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';

/** Each status read, by bare tool name, and why a Never ask run may call it. */
export const NEVER_ASK_STATUS_READS: Readonly<Record<string, string>> = {
  running_chats:
    'Which chats run right now, per agent: titles (often a chat’s opening words), links and states; a person’s own chat is only counted.',
  tasks_get_run_history:
    'Any schedule’s run records, by id: when each ran, how it ended, and the first 500 characters of what that run wrote, which can quote what it read.',
  agents_recent_activity: 'When each agent last worked: one timestamp per agent.',
  heartbeat_status:
    'How an agent wakes and how its beats went: its schedule, counts and record lines, readable by everyone in the space.',
};

/** The same reads by their in-session names, which the Never ask hook sees. */
export const NEVER_ASK_STATUS_READS_QUALIFIED: ReadonlySet<string> = new Set(
  Object.keys(NEVER_ASK_STATUS_READS).map(inSessionToolName)
);
