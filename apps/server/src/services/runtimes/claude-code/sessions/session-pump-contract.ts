/**
 * The pump's vocabulary: the states one session's process moves through, the
 * transitions between them, the seams it is driven through, and the two errors
 * it raises (spec `persistent-session-runtime` §4.2, task 3.2).
 *
 * Split out of `session-pump.ts` so the machine's shape can be read — and
 * imported by the tasks that build on it — without reading its implementation.
 * Consumers may import either module: `session-pump.ts` re-exports all of this.
 *
 * @module services/runtimes/claude-code/sessions/session-pump-contract
 */
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionWarmth } from '@dorkos/shared/agent-runtime';
import type { HeldUserPrompt } from '../sdk/sdk-utils.js';

/**
 * How long a launch may sit without a `system/init` before it is called dead.
 *
 * Nothing else bounds this window. The stall watchdog arms on a turn window
 * (task 3.7) and the idle timer bounds a WARM session (task 3.4); a process
 * that boots and never initializes is neither, so without this a dispatch would
 * await an init that never comes for as long as the server runs. Generous
 * enough that a cold CLI on a slow disk, loading plugins and MCP servers, still
 * makes it.
 */
export const INIT_TIMEOUT_MS = 60_000;

/**
 * How long the polite close is given before the process is closed out from
 * under it. Matches the OpenCode sidecar's shutdown grace: long enough for a
 * drain that is actually working, short enough that shutdown stays snappy.
 */
export const DRAIN_GRACE_MS = 5_000;

/**
 * Where one session's process is in its life. The five reported by
 * {@link SessionWarmth} plus the two that are internal to the machine:
 * `reaped` (the process is gone and this pump object is spent — the registry
 * drops it, and the next dispatch builds a fresh one) and `resuming` (a
 * relaunch after a crash is in flight).
 */
export type PumpState = 'cold' | 'warming' | 'warm' | 'running' | 'reaped' | 'crashed' | 'resuming';

/**
 * The only transitions the machine allows, keyed by the state being left (spec
 * §4.2).
 *
 * Every state may go to `cold`, which is the eviction and teardown edge ("any →
 * COLD: reap first, then drop the session record"). `resuming → crashed` is not
 * in the spec's table and is the honest reading of its `RESUMING → WARMING` row:
 * a relaunch whose `query()` throws has crashed again rather than warmed.
 */
export const LEGAL_TRANSITIONS: Record<PumpState, readonly PumpState[]> = {
  cold: ['warming'],
  warming: ['warm', 'crashed', 'cold'],
  warm: ['running', 'reaped', 'crashed', 'cold'],
  running: ['warm', 'crashed', 'cold'],
  reaped: ['cold'],
  crashed: ['resuming', 'cold'],
  resuming: ['warming', 'crashed', 'cold'],
};

/** How each internal state answers the runtime-facing `getSessionWarmth`. */
export const WARMTH_OF: Record<PumpState, SessionWarmth> = {
  cold: 'cold',
  // A reaped process is gone; the person's session is untouched and the next
  // message resumes it. `cold` is exactly what that is.
  reaped: 'cold',
  warming: 'warming',
  // A relaunch in flight is a process booting, which is what `warming` means.
  resuming: 'warming',
  warm: 'warm',
  running: 'running',
  crashed: 'crashed',
};

/** States in which a subprocess exists (or is being booted) for this session. */
export const HOLDS_PROCESS: readonly PumpState[] = ['warming', 'warm', 'running', 'resuming'];

/** Why the pump refused something a caller was entitled to ask for. */
export type PumpRefusalReason =
  /** A dispatch carried no messages: there is no turn to open. */
  | 'empty-dispatch'
  /** The warm ceiling is full and no slot could be reclaimed. */
  | 'warm-ceiling'
  /** The session is parked on a person; firing into an open ask is the failure this prevents. */
  | 'pending-interaction'
  /** The process is gone (torn down, or the input stream ended under us). */
  | 'process-gone';

/**
 * A legal request the pump declined, with the reason a caller can branch on.
 *
 * Distinct from {@link IllegalPumpTransitionError}, which means the caller asked
 * for something the machine has no edge for — a bug, not a condition.
 */
export class PumpRefusedError extends Error {
  /**
   * Build a refusal.
   *
   * @param reason - Which condition refused the request
   * @param message - What the caller was trying to do, in plain words
   */
  constructor(
    readonly reason: PumpRefusalReason,
    message: string
  ) {
    super(message);
    this.name = 'PumpRefusedError';
  }
}

/** A transition the state machine has no edge for — always a caller bug. */
export class IllegalPumpTransitionError extends Error {
  /**
   * Build the report of an edge the machine does not have.
   *
   * @param from - The state the pump is actually in
   * @param to - The state the caller's request would have moved it to
   */
  constructor(
    readonly from: PumpState,
    readonly to: PumpState
  ) {
    super(`SessionPump cannot go from ${from} to ${to}`);
    this.name = 'IllegalPumpTransitionError';
  }
}

/**
 * The control-plane slice of the SDK's `Query`: the methods a warm process can
 * still answer between turns.
 *
 * Split out from {@link PumpQuery} because it is what {@link SessionPump}
 * hands OUT (`controlQuery`), and what the turn windower calls at every window
 * close to fetch that window's context and subscription accounting while the
 * process is still alive.
 *
 * The four setters are the settable-live half of the relaunch pin list (task
 * 3.5): the launch parameters a warm process can be moved onto instead of being
 * replaced. They are applied by `launch-live-settings.ts`, which is also the
 * only module that should call them — a setter fired from anywhere else moves
 * the process out from under its own launch fingerprint.
 */
export type PumpControlQuery = Pick<
  Query,
  | 'getContextUsage'
  | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
  | 'setModel'
  | 'setPermissionMode'
  | 'setMcpServers'
  | 'reloadPlugins'
>;

/**
 * The slice of the SDK's `Query` the pump depends on: its message stream, the
 * forceful close that actually terminates the CLI child, and the control
 * methods of {@link PumpControlQuery}. Deliberately the minimum, so a test
 * double stays short.
 */
export type PumpQuery = AsyncIterable<SDKMessage> & Pick<Query, 'close'> & PumpControlQuery;

/** What a launcher is handed to boot one process. */
export interface PumpLaunchInput {
  sessionId: string;
  /** The held input stream to pass as `query({ prompt })`. The pump owns its lifetime. */
  prompt: HeldUserPrompt['prompt'];
  /**
   * True when this launch is recovering from a crash, so the launcher knows to
   * take the resume path (task 3.6's failover). A first launch says `false` and
   * the launcher decides for itself whether the conversation has started.
   */
  resuming: boolean;
}

/**
 * Boots one SDK subprocess around the held prompt and returns its live query.
 *
 * Everything the launch is PINNED to — cwd, the Claude account root, resolved
 * credentials, the system-prompt append — is resolved here, which is why task
 * 3.5's relaunch fingerprint lives on this side of the seam rather than in the
 * pump.
 */
export type PumpLauncher = (input: PumpLaunchInput) => PumpQuery | Promise<PumpQuery>;

/** A process that ended when nobody asked it to. */
export interface PumpCrash {
  sessionId: string;
  /** What the pump was doing when the process died. `running` means a turn was open. */
  stateAtCrash: PumpState;
  /** What the stream threw, when it threw rather than simply ending. */
  error?: unknown;
}

/** One message being dispatched into the pump. */
export interface PumpDispatch {
  /** The person's words, exactly as they will reach the model. */
  content: string;
  /**
   * The server-minted correlation id, stamped as this message's SDK `uuid`.
   *
   * Required, not optional, and for the same reason the capability flags are
   * (spec §2.2): a dispatch nobody can correlate is the exact shape of the bug
   * this exists to prevent — a turn window that never closes. The SDK echoes
   * the id back on the `result` it answers with (`user_message_uuid`), and the
   * turn windower (`session-turn-windows.ts`) matches on it and NEVER on
   * position, because a dequeued batch coalesces into one turn.
   */
  messageId: string;
}

/** Everything a pump needs to own one session's process. */
export interface SessionPumpOptions {
  sessionId: string;
  /** Boots the process. See {@link PumpLauncher}. */
  launch: PumpLauncher;
  /**
   * Every SDK message the process emits, in order — the demux seam task 3.3
   * cuts turn windows out of. A throw from here is logged and swallowed: a
   * consumer bug must not take the process down with it.
   */
  onMessage?: (message: SDKMessage) => void;
  /**
   * The process ended when nobody asked it to — task 3.6's failover seam. It is
   * that task, not this one, that closes an open turn with
   * `turn_end{terminalReason:'error'}` and preserves the queue.
   */
  onCrash?: (crash: PumpCrash) => void;
  /**
   * Every state change, after the fact — task 3.4's timer seam (arm the idle
   * timer on the way into `warm`, disarm it on the way into `running`).
   */
  onStateChange?: (change: { from: PumpState; to: PumpState }) => void;
  /**
   * True while the session is parked on a person (an approval, a question, an
   * elicitation). Gates BOTH dispatch and reap: firing a queued prompt into an
   * open ask is answered by nobody, and a reaped process cannot answer the
   * approval the person comes back to. Task 3.4 wires the projector's existing
   * `hasPendingInteractions` probe here rather than inventing a third one.
   */
  hasPendingInteraction?: () => boolean;
  /**
   * Claims a slot under the warm ceiling before a process is booted; throws
   * {@link PumpRefusedError} with `warm-ceiling` when there is none. The
   * registry supplies it, and task 3.4 makes it reclaim the least recently used
   * warm pump instead of refusing.
   */
  reserveSlot?: () => Promise<void>;
  /** Override the grace window between the polite close and the forceful one. */
  drainGraceMs?: number;
  /** Override how long a launch may wait for `system/init`. */
  initTimeoutMs?: number;
}
