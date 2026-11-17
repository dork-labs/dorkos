/**
 * The status reads a run with nobody there may call (DOR-3971, DOR-4601): a short, named list,
 * each with its reason.
 *
 * Under `dontAsk` Claude Code refuses every tool its allow rules don't name before DorkOS is asked,
 * and at Ask first and Accept edits these reads raised a card a scheduled run has nobody to answer.
 * Either way an unattended watchdog could not see which chats run or how its runs went. So they run
 * unasked at the three levels in {@link STATUS_READ_MODES} (PM ruling A on DOR-4601), and ask at
 * Plan and Auto as before. Full runs everything anyway.
 *
 * **Named, never derived from the tier** (Security, Nov 8). Some `observe` tools return other
 * people's words: transcripts, the audit log, connector reads, room history and chat reads. A run
 * that reads those and then writes a summary somewhere is a quiet leak path, so they are not here
 * and stay opt-in per task. (Room reads and `chat_read` already run on an agent's identity at
 * Never ask, DOR-3042; this list adds nothing to them.) A tool joins only with a one-line reason
 * Security has read, and the reason says plainly what comes back.
 * `never-ask-status-reads.test.ts` pins each entry to a real `observe` tool.
 *
 * Three of them answer narrower at those levels, told so per call by the in-session server
 * (`narrowedReads`, Security on DOR-3971): `running_chats` leaves every title out, since a stranger
 * can name a bridged group, and `tasks_get_run_history` and `heartbeat_status` leave out each run's
 * and each beat's summary, which is an agent's own words about what it read.
 *
 * What these return is the owner's working data, so the hook (`never-ask-hook.ts`) runs them only
 * for the server DorkOS registered, and never in a turn that carries an outsider's words: a
 * stranger's own, one our agents passed on, one marked by a line it read, or one the DOR-4029 test
 * (`chatReadOutsideWords`) says read outside words, as memory and `chat_send` read it. Such a turn
 * gets its level's own answer instead: a card, or a refusal where nobody can answer. A teammate's
 * turn still runs them, as it runs the agent's own connection reads.
 *
 * @module services/runtimes/claude-code/tool-gate/never-ask-status-reads
 */
import { NEVER_ASK_MODE_ID } from '../runtime-constants.js';
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';

/** Each status read, by bare tool name, and why a run with nobody there may call it. */
export const NEVER_ASK_STATUS_READS: Readonly<Record<string, string>> = {
  running_chats:
    'Which chats run right now, per agent: links and states, with every title left out; a person’s own chat is only counted.',
  tasks_get_run_history:
    'Any schedule’s run records, by id: when each ran, how it ended and what it was refused, with each run’s summary left out.',
  agents_recent_activity: 'When each agent last worked: one timestamp per agent.',
  heartbeat_status:
    'How an agent wakes and how its beats went: its schedule, outcomes and counts, with each beat’s summary left out.',
};

/** The same reads by their in-session names, which the hook sees. */
export const NEVER_ASK_STATUS_READS_QUALIFIED: ReadonlySet<string> = new Set(
  Object.keys(NEVER_ASK_STATUS_READS).map(inSessionToolName)
);

/**
 * The levels the status reads run unasked at, and answer narrowed at: Never ask (DOR-3971), Ask
 * first and Accept edits (DOR-4601). By the mode the gate answers now (`gatePermissionMode`).
 */
export const STATUS_READ_MODES: ReadonlySet<string> = new Set([
  NEVER_ASK_MODE_ID,
  'default',
  'acceptEdits',
]);
