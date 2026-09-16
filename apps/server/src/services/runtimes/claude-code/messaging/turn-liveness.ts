/**
 * Whether a turn is still alive — the one question that decides when the CLI's
 * stdin may be closed (DOR-1238, superseding DOR-1149's premise).
 *
 * **The property: the CLI's stdin is never EOF'd while the turn is still
 * alive.** Closing the held prompt calls the SDK's `endInput()`, which sends the
 * CLI's stdin an EOF. The CLI does not stop there — it finishes its in-flight
 * subagents and delivers their `<task-notification>` segments — but its SDK
 * control stream is gone, and from that moment two things break at once. Every
 * tool matched by DorkOS's SDK-side PreToolUse hook is cancelled at entry with
 * the interrupt sentinel (`PreToolUse SDK callback hook cancelled (control
 * stream closed)`, verbatim from the CLI debug log), and every corrective push
 * is silently dropped (`Dropping write to ended stdin stream`). Nine phantom
 * cancellations in one production turn, every one `steered:false`.
 *
 * So DOR-1149's header was wrong where it said closing early "costs only the
 * steering opportunity, never worse": the early close is what CAUSES the
 * cancellations it was trying to steer around. That is why this module now
 * tracks two things rather than one.
 *
 * **Live background AGENTS**, from `background_tasks_changed`. DOR-1149
 * rejected counting running tasks because a task that starts and never reports
 * would pin the stream open for ever. The SDK's level signal answers that: it
 * carries the FULL set of live tasks after every membership change, so a killed
 * or crashed task leaves the set by itself and nothing has to pair edges. Each
 * entry carries its own `task_type`, and only `local_agent` holds the stream —
 * a `local_bash` shell is killed by the CLI shortly after stdin ends, which is
 * long-standing behaviour and out of scope here. (`sdk.d.ts` describes the
 * payload as carrying "ids only"; the captured wire shape carries more. See
 * `__tests__/fixtures/background-tasks-sdk-0.3.224.jsonl`.) The level is
 * per-PROCESS and nothing is emitted at startup, so one tracker belongs to one
 * process: a fresh turn, or a pump relaunch, starts from the empty set.
 *
 * **Notifications owed a delivery**, from `system/task_notification`. A settle
 * says a delivery is now owed. This is needed alongside the level signal
 * because the settle arrives AFTER the level frame that drops the task
 * (observed in every capture), so a turn keyed on live agents alone would have
 * nothing outstanding at the very `result` that precedes the delivery segment.
 *
 * **How a delivery actually shows up on the stream.** Not as a user message.
 * The `<task-notification>` user message DOR-1149 keyed on exists only in the
 * JSONL transcript — it is never yielded on the SDK stream, which was proved
 * live against CLI 2.1.224 (`deliveriesOnStream=0` over a full
 * launch-settle-deliver turn, and again in
 * `__tests__/fixtures/delivery-segment-sdk-0.3.224.jsonl`, which contains every
 * `type:'user'` frame the delivery segment produced and not one notification
 * among them). What the stream shows instead is a **second `system/init`**: the
 * CLI opens a NEW query segment and drains its queued notifications into it
 * ("folded into the live turn or drained into a fresh one" —
 * `phantom-cancellation.ts`). So an init that arrives after a `result` both
 * releases the deadline and clears `owed`.
 *
 * A hold for a live agent takes NO deadline — the level signal is
 * self-correcting. A hold for an owed delivery alone takes one, because nothing
 * else bounds a notification that settles and is never delivered. What
 * {@link TurnLiveness.observe} reports back is whether a SEGMENT IS RUNNING, so
 * the caller can drop that deadline before it fires inside one: a post-`result`
 * `system/init` (a new segment has opened) or an `assistant`/`stream_event`
 * frame (the model is mid-segment). Both GUARANTEE a later `result` at which
 * the close is re-decided, which is why `task_progress`, `task_updated` and
 * `background_tasks_changed` deliberately do NOT release it — they promise no
 * `result`, so releasing on them could leave a turn held open with no deadline
 * and nothing coming.
 *
 * @module services/runtimes/claude-code/messaging/turn-liveness
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** What a `result` may do with the input stream. */
export interface CloseDecision {
  /** Keep the CLI's stdin open: this `result` ends a segment, not the turn. */
  hold: boolean;
  /**
   * Arm the wall-clock deadline on this hold. True only for an owed delivery
   * with no live agent — a hold that waits on the level signal must never be
   * cut short by a clock.
   */
  armDeadline: boolean;
}

/** What observing one SDK message changed. */
export interface LivenessChange {
  /**
   * This message proves a segment is running, and therefore that a `result`
   * will follow. Any armed deadline has to go now: the close it guards would
   * land inside that segment and cancel its tool calls.
   */
  segmentRunning: boolean;
}

/**
 * How many live background tasks of each kind the level frame currently names.
 *
 * Split three ways rather than two because the quiet predicate treats them
 * differently (spec `warm-process-lifecycle` D1): agents and anything unknown
 * hold the process, shells never do. An unrecognised `task_type` counts as
 * `other` on purpose — a Monitor, or whatever the CLI ships next, is work
 * somebody would be upset to lose, and guessing "harmless" about a type nobody
 * has watched is the guess that throws work away.
 */
export interface LiveTaskCounts {
  /** `local_agent` — a background subagent. Holds the process. */
  agents: number;
  /** `local_bash` — a background shell. Never holds the process. */
  shells: number;
  /** Every other `task_type`, known or not. Holds the process. */
  other: number;
}

/** Tracks whether a turn's stream is still alive, and why. */
export interface TurnLiveness {
  /**
   * Feed every SDK message as it streams. Ignores everything that is neither a
   * background-task membership change, a task settling, nor evidence that a
   * segment is running. Never throws on a malformed frame — a message observer
   * that throws would be read as the process dying.
   */
  observe: (message: SDKMessage) => LivenessChange;
  /**
   * What to do with the input stream at the `result` just observed. Pure — call
   * it as often as you like.
   */
  holdOpenAtResult: () => CloseDecision;
  /** How many background subagents are live per the latest level frame. */
  liveAgentCount: () => number;
  /**
   * Every live background task per the latest level frame, split by whether it
   * holds the process. The quiet predicate's input (spec
   * `warm-process-lifecycle` D1); {@link liveAgentCount} stays for the resume
   * path's stdin hold, which asks only about subagents.
   */
  liveTaskCounts: () => LiveTaskCounts;
  /** How many settled notifications have not yet been delivered. */
  owedCount: () => number;
  /**
   * Give up on every owed delivery and report which ones were abandoned.
   *
   * The warm path's escape hatch (spec `warm-process-lifecycle` D1). On the
   * resume path an owed notification is bounded by the deferred stdin close in
   * `stdin-hold.ts`; a warm process never runs that close, so without this a
   * settle whose delivery segment never arrives would hold the queue for the
   * life of the process. The pump's owed-delivery clock is the only caller, and
   * it logs the ids this returns.
   *
   * @returns The task ids whose deliveries were given up on, oldest first
   */
  expireOwed: () => string[];
}

/** Lifecycle subtype announcing that a background task has settled. */
const TASK_NOTIFICATION = 'task_notification';

/** Lifecycle subtype carrying the full set of live background tasks. */
const BACKGROUND_TASKS_CHANGED = 'background_tasks_changed';

/** The subtype that opens a query segment. The SECOND one is a delivery segment. */
const INIT = 'init';

/** The `task_type` the CLI stamps on a background SUBAGENT, as opposed to a shell. */
const AGENT_TASK_TYPE = 'local_agent';

/** The `task_type` the CLI stamps on a background SHELL, which holds nothing. */
const SHELL_TASK_TYPE = 'local_bash';

/** Nothing about the turn's liveness changed. */
const UNCHANGED: LivenessChange = { segmentRunning: false };

/** A segment is running, so a `result` is coming. */
const SEGMENT_RUNNING: LivenessChange = { segmentRunning: true };

/**
 * Message types that prove the model is mid-segment. Both are answered by a
 * `result`, which is the whole requirement for releasing a deadline.
 */
const MODEL_ACTIVITY: ReadonlySet<string> = new Set(['assistant', 'stream_event']);

/**
 * Create a liveness tracker for ONE CLI process — one `executeSdkQuery` frame,
 * or one pump launch. The level signal is per-process and is not replayed at
 * startup, so a tracker must never outlive the process it was fed by.
 */
export function createTurnLiveness(): TurnLiveness {
  /** Live task id to the `task_type` the level frame stamped on it. */
  const liveTasks = new Map<string, string>();
  const owed = new Set<string>();
  let resultsSeen = 0;

  /** How many live tasks are background SUBAGENTS — the resume path's question. */
  const agentCount = (): number => {
    let agents = 0;
    for (const type of liveTasks.values()) if (type === AGENT_TASK_TYPE) agents += 1;
    return agents;
  };

  return {
    observe: (message) => {
      if (message.type === 'system' && 'subtype' in message) {
        if (message.subtype === BACKGROUND_TASKS_CHANGED) {
          // REPLACE semantics, per `sdk.d.ts`: the payload IS the membership,
          // which is what makes a missed bookend unable to wedge this open.
          // Defensive because this runs inside the pump's message loop too,
          // where a throw would be read as the process dying: a frame without a
          // usable `tasks` array leaves the set ALONE rather than clearing it,
          // since a malformed frame is not evidence that the agents stopped —
          // and dropping a hold is the failure this module exists to prevent.
          if (!Array.isArray(message.tasks)) return UNCHANGED;
          liveTasks.clear();
          for (const task of message.tasks) {
            if (typeof task?.task_id !== 'string') continue;
            // A task whose type the frame does not state is kept as an empty
            // string, which classifies as `other` and therefore HOLDS the
            // process. Dropping it instead would make an unlabelled task
            // invisible to the quiet predicate, and throwing away work is the
            // failure this module exists to prevent.
            const taskType = typeof task.task_type === 'string' ? task.task_type : '';
            liveTasks.set(task.task_id, taskType);
          }
          return UNCHANGED;
        }
        if (message.subtype === TASK_NOTIFICATION) {
          const taskId = (message as { task_id?: unknown }).task_id;
          // An unidentifiable settle cannot be matched to its delivery, so
          // counting it would only risk holding to the deadline for nothing.
          if (typeof taskId === 'string') {
            owed.add(taskId);
            // Belt and braces: the level frame that drops a settled task
            // precedes this in every capture, but a task that has reported is
            // definitionally no longer running.
            liveTasks.delete(taskId);
          }
          return UNCHANGED;
        }
        if (message.subtype !== INIT) return UNCHANGED;
        // An init BEFORE this turn has closed a segment is the turn's own: it
        // opens nothing new. One after a `result` is the CLI opening a delivery
        // segment and draining its queued notifications into it, so what was
        // owed has now been handed over (see the module doc).
        //
        // Keyed on "after a result" rather than on counting inits, so it does
        // not depend on the stream always opening with one. If an init were
        // ever missed, the worst case is the old behaviour: `owed` is not
        // cleared and the 30s deadline ends the hold — never an EOF under a
        // live agent, which the level signal holds independently.
        if (resultsSeen === 0) return UNCHANGED;
        owed.clear();
        return SEGMENT_RUNNING;
      }
      // A `result` closes a segment; what to do about that is the caller's
      // decision (`stdin-hold.ts`), and all this needs is to remember that a
      // segment has now ended.
      if (message.type === 'result') {
        resultsSeen++;
        return UNCHANGED;
      }
      return MODEL_ACTIVITY.has(message.type) ? SEGMENT_RUNNING : UNCHANGED;
    },
    // Unchanged on purpose: this is the RESUME path's stdin decision, where
    // only a subagent has ever held the stream open. The warm path's wider
    // question — which the quiet predicate asks — is `liveTaskCounts`.
    holdOpenAtResult: () => ({
      hold: agentCount() > 0 || owed.size > 0,
      armDeadline: agentCount() === 0 && owed.size > 0,
    }),
    liveAgentCount: agentCount,
    liveTaskCounts: () => {
      const counts: LiveTaskCounts = { agents: 0, shells: 0, other: 0 };
      for (const type of liveTasks.values()) {
        if (type === AGENT_TASK_TYPE) counts.agents += 1;
        else if (type === SHELL_TASK_TYPE) counts.shells += 1;
        else counts.other += 1;
      }
      return counts;
    },
    owedCount: () => owed.size,
    expireOwed: () => {
      const abandoned = [...owed];
      owed.clear();
      return abandoned;
    },
  };
}
