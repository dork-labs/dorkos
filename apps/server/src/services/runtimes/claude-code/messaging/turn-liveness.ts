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
  /** How many settled notifications have not yet been delivered. */
  owedCount: () => number;
}

/** Lifecycle subtype announcing that a background task has settled. */
const TASK_NOTIFICATION = 'task_notification';

/** Lifecycle subtype carrying the full set of live background tasks. */
const BACKGROUND_TASKS_CHANGED = 'background_tasks_changed';

/** The subtype that opens a query segment. The SECOND one is a delivery segment. */
const INIT = 'init';

/** The `task_type` the CLI stamps on a background SUBAGENT, as opposed to a shell. */
const AGENT_TASK_TYPE = 'local_agent';

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
  const liveAgents = new Set<string>();
  const owed = new Set<string>();
  let resultsSeen = 0;

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
          liveAgents.clear();
          for (const task of message.tasks) {
            if (typeof task?.task_id !== 'string') continue;
            if (task.task_type === AGENT_TASK_TYPE) liveAgents.add(task.task_id);
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
            liveAgents.delete(taskId);
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
    holdOpenAtResult: () => ({
      hold: liveAgents.size > 0 || owed.size > 0,
      armDeadline: liveAgents.size === 0 && owed.size > 0,
    }),
    liveAgentCount: () => liveAgents.size,
    owedCount: () => owed.size,
  };
}
