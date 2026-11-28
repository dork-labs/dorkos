/**
 * The gap between a segment opening and its first word (DOR-5490).
 *
 * When a background helper finishes, the CLI opens a new segment to hand its
 * report over: a `system/init` after a `result`, then a request to the model,
 * then the model's first frame. A timer the agent set and a person's later
 * turns open a segment the same way; the hold covers every one, which is why
 * its reason is `segment-starting` rather than `delivery-owed`. `TurnLiveness` clears the owed delivery at that
 * init, and the windower opens no window until the first model frame, so for
 * the whole time to first token (seconds on a big context, longer through API
 * retries) the process read as quiet: no turn, no runtime turn, nothing owed.
 * In that gap a person's message launched into the segment, and a reap, a slot
 * reclaim or a relaunch for new settings could end the process mid-request,
 * leaving a transcript that stops at the CLI's queue entries.
 *
 * This holds from that init until the segment's first main-thread model frame
 * (the frame the windower opens a runtime window at, after which the open
 * runtime turn holds the process) or its `result` (a segment with nothing in
 * it). Every init captured so far is followed by a `result` in the same
 * segment, so the hold ends on its own; the clock is the bound for a segment
 * that never says anything, the same two minutes a dispatched turn gets for its
 * first event ({@link SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS}). A frame of the
 * agent's own (an `api_retry`, a status line) restarts it, as proof the segment
 * is still on its way. A helper's frame does not: a helper talking says nothing
 * about the agent's segment, and counting it let a chatty helper hold the
 * queue for as long as it went on.
 *
 * A process that dies in the gap drops the hold at once
 * ({@link SegmentStartHold.dispose}, from the pump's crash path): a dead
 * process cannot speak, so waiting on it buys nothing.
 *
 * @module services/runtimes/claude-code/messaging/segment-start-hold
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { SESSIONS } from '../../../../config/constants.js';
import { beginsATurn, isHelperFrame } from '../sessions/frames/frame-kinds.js';
import type { LivenessChange } from './turn-liveness.js';

/** Holds a process busy from a segment's `system/init` to its first word. */
export class SegmentStartHold {
  /** The armed clock, or undefined while no segment is starting. */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Build the hold for one process.
   *
   * @param onExpire - The segment said nothing for the whole wait. Called once,
   *   after the hold has dropped, so the caller can release what waited on it.
   */
  constructor(private readonly onExpire: () => void) {}

  /** True while a segment has opened and said nothing yet. */
  get holding(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Fold one frame in.
   *
   * @param message - The frame the process just produced
   * @param change - What the liveness tracker made of it
   */
  observe(message: SDKMessage, change: LivenessChange): void {
    if (message.type === 'result' || beginsATurn(message)) {
      this.dispose();
      return;
    }
    // A post-`result` init is the only init `TurnLiveness` reports as a
    // segment running; the one a process opens with is not.
    const opens = change.segmentRunning && message.type === 'system' && isInit(message);
    if (opens || (this.holding && !isHelperFrame(message))) this.arm();
  }

  /** Drop the hold without calling back: the process it belonged to is gone or going. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Start, or restart, the wait for the segment's first word. */
  private arm(): void {
    this.dispose();
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpire();
    }, SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS);
    timer.unref?.();
    this.timer = timer;
  }
}

/** Whether a `system` frame is a `system/init`. */
function isInit(message: SDKMessage): boolean {
  return 'subtype' in message && message.subtype === 'init';
}
