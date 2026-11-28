/**
 * The buffer a turn window's messages wait in until its consumer reads them,
 * and the tripwire that says when a runtime window's buffer has grown past
 * anything a brief wait could explain (spec `warm-process-lifecycle` D6).
 *
 * Split out of `../session-turn-windows.ts`, which is the only user and is
 * over the file-size limit.
 *
 * @module services/runtimes/claude-code/sessions/frames/window-channel
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * How many buffered bytes a RUNTIME window may hold before it says so, once
 * (spec `warm-process-lifecycle` D6).
 *
 * A runtime window's channel is deliberately **not capped**: the turn it
 * carries is the agent's own words, and the window exists precisely because
 * nothing else is going to project them. Dropping the oldest — what the
 * unattributed hold does — would lose exactly what this turn was opened to
 * keep. So the buffer grows, and this is a tripwire rather than a limit.
 *
 * A healthy run never reaches it. The buffer only holds frames between the
 * window opening and its consumer acquiring the session lock, which is
 * milliseconds after the previous holder's `turn_end`. Eight mebibytes of
 * unread model output in that gap means the consumer never arrived, and that is
 * worth an `error` line naming the session rather than silent memory growth.
 *
 * Measured from each frame's serialized length as it is pushed, and reported
 * once per window: a tripwire that re-fires on every frame past it is a log
 * flood, which is the same as no signal at all.
 */
export const RUNTIME_WINDOW_BUFFER_WARN_BYTES = 8 * 1024 * 1024;

/**
 * Roughly how many bytes a frame occupies while it waits to be read.
 *
 * An estimate on purpose — the serialized length, which is what a frame costs
 * to hold and what the tripwire is stated in. A frame that cannot be
 * serialized (a cycle the SDK should never produce) counts as zero rather than
 * throwing: this runs inside the pump's read loop, where a throw is read as the
 * process dying, and under-counting a tripwire costs a log line.
 *
 * @param message - The frame being buffered
 */
function estimateFrameBytes(message: SDKMessage): number {
  try {
    return JSON.stringify(message)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** A buffered stream of SDK messages with an explicit end. */
export class WindowChannel {
  private readonly pending: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  /** Serialized size of the frames pushed but not yet consumed. */
  private pendingBytes = 0;
  /** True once {@link onBuffering} has fired, so it fires exactly once. */
  private reported = false;

  /**
   * Build a channel, optionally watched for unread growth.
   *
   * @param onBuffering - Told once when the unread frames pass
   *   {@link RUNTIME_WINDOW_BUFFER_WARN_BYTES}. Omitted for a dispatched
   *   window, whose consumer is the generator that asked for it and is
   *   therefore already reading — measuring every frame there would cost a
   *   `JSON.stringify` per frame on the hot path for a tripwire that cannot
   *   fire.
   */
  constructor(private readonly onBuffering?: (frames: number, bytes: number) => void) {}

  /** Hand a message to the consumer, or hold it until one arrives. */
  push(message: SDKMessage): void {
    if (this.ended) return;
    this.pending.push(message);
    if (this.onBuffering !== undefined) {
      this.pendingBytes += estimateFrameBytes(message);
      if (!this.reported && this.pendingBytes > RUNTIME_WINDOW_BUFFER_WARN_BYTES) {
        this.reported = true;
        this.onBuffering(this.pending.length, this.pendingBytes);
      }
    }
    this.wake?.();
    this.wake = undefined;
  }

  /**
   * Take back everything pushed but not yet consumed, emptying the channel.
   *
   * For a window that is being abandoned before anyone observed it: its
   * messages belong to no window now, so they go back on hold for the next one
   * rather than dying in a stream nothing will ever read.
   */
  takePending(): SDKMessage[] {
    this.pendingBytes = 0;
    return this.pending.splice(0, this.pending.length);
  }

  /** No more messages will come. Idempotent. */
  end(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** Every message pushed, in order, until {@link end}. */
  async *drain(): AsyncGenerator<SDKMessage> {
    for (;;) {
      while (this.pending.length > 0) {
        const message = this.pending.shift()!;
        if (this.onBuffering !== undefined) {
          this.pendingBytes = Math.max(0, this.pendingBytes - estimateFrameBytes(message));
        }
        yield message;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
