/**
 * The drive loop: trigger a turn and collect it off the durable stream.
 *
 * One turn is: `POST /api/sessions/:id/messages { content, cwd }` (trigger-only,
 * 202, ADR-0264) → collect `GET /api/sessions/:id/events` until the turn's
 * terminal frame or a timeout/budget guard trips. On the durable per-session
 * stream the runtime's terminal `done` (the `runtimeConformance` guarantee) is
 * projected as a `turn_end` SessionEvent — that is the frame the loop stops on.
 *
 * Ordering is subscribe-FIRST: the stream is opened and its cold `snapshot`
 * awaited BEFORE the trigger POST, so a fast turn cannot complete in the gap and
 * leave the collector waiting for a `turn_end` that already fired (the same
 * ordering the real client uses). The connection reuses the shared `parseFrames`
 * from `@dorkos/test-utils`, so it parses frames identically to the collectors.
 *
 * A `409 SESSION_LOCKED`, a non-202 trigger, a per-turn timeout, and a `/events`
 * connection error are RUNNER errors (a {@link DriveError} / `timeout` outcome),
 * reported distinctly from an eval's oracle failure so an infra flake is never
 * read as a product regression. Every exit path — success, timeout, abort,
 * connection error, and a rejected trigger — destroys the durable GET so the
 * `/events` connection is never left open.
 *
 * @module evals/runner/drive
 */
import http from 'node:http';
import { parseFrames, type SseFrame } from '@dorkos/test-utils/sse-test-helpers';

/** Default per-turn collection timeout (ms): how long a turn may run before it resolves `timeout`. */
const DEFAULT_TURN_TIMEOUT_MS = 90_000;

/**
 * Default subscribe-gate timeout (ms): how long to wait for the cold `/events`
 * snapshot before `ready` rejects. Guards against a stream that accepts the GET
 * but never delivers a snapshot — without it, `await stream.ready` would hang.
 */
const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** How a single driven turn ended. */
export type TurnOutcome = 'done' | 'timeout' | 'aborted';

/** A runner error triggering the turn (distinct from an eval/oracle failure). */
export class DriveError extends Error {
  /**
   * Construct a drive error carrying a stable machine code.
   *
   * @param message - Human-readable cause.
   * @param code - Stable machine code (`SESSION_LOCKED`, `TRIGGER_REJECTED`, `STREAM_ERROR`).
   * @param status - The HTTP status the trigger returned, when relevant.
   * @param options - Standard error options (e.g. `cause` for a wrapped socket error).
   */
  constructor(
    message: string,
    readonly code: 'SESSION_LOCKED' | 'TRIGGER_REJECTED' | 'STREAM_ERROR',
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'DriveError';
  }
}

/** Options for {@link driveTurn}. */
export interface DriveTurnOptions {
  /** Base URL of the running harness server. */
  baseUrl: string;
  /** Session id to trigger and subscribe under. */
  sessionId: string;
  /** The user message content. */
  content: string;
  /** Project cwd the turn runs in (the sandbox project dir). */
  cwd: string;
  /** Per-turn timeout guard in ms; a turn that never ends resolves `timeout`. Default 90000. */
  timeoutMs?: number;
  /**
   * Subscribe-gate timeout in ms; if the cold `/events` snapshot never arrives
   * within it, `ready` rejects (a `STREAM_ERROR` {@link DriveError}) instead of
   * hanging. Default 15000.
   */
  readyTimeoutMs?: number;
  /**
   * Live abort guard, evaluated on every collected frame (e.g. a budget ceiling
   * check over `session_status` cost). Returning true stops collection with the
   * `aborted` outcome.
   */
  abortWhen?: (frames: SseFrame[]) => boolean;
}

/** The result of one driven turn. */
export interface DriveTurnResult {
  /** The canonical session id the 202 returned (subsequent turns use it). */
  canonicalId: string;
  /** Every frame collected off `/events`, including the leading `snapshot`. */
  frames: SseFrame[];
  /** How the turn ended. */
  outcome: TurnOutcome;
}

/** A live `/events` connection with a ready signal, completion promise, and teardown. */
interface LiveStream {
  /**
   * Resolves once the cold `snapshot` frame has arrived (safe to POST). Rejects
   * on a `/events` connection error, or if the snapshot never arrives within the
   * subscribe-gate timeout — so the caller never blocks forever awaiting it.
   */
  ready: Promise<void>;
  /**
   * Resolves with the collected frames + outcome when the turn terminates
   * (`done` / `timeout` / `aborted`). Rejects on a `/events` connection error.
   */
  done: Promise<{ frames: SseFrame[]; outcome: TurnOutcome }>;
  /**
   * Destroy the `/events` connection and settle the stream. Idempotent — the
   * driver calls it on every early-exit path (a rejected trigger, a thrown
   * error) so the durable GET is never left open.
   */
  close: () => void;
}

/** True when a frame is the turn's terminal `turn_end` boundary. */
function isTurnEnd(frame: SseFrame): boolean {
  return frame.event === 'turn_end';
}

/**
 * Open `GET /:id/events`, signal `ready` on the cold snapshot, and collect until
 * a `turn_end` frame, a timeout, or the abort guard — destroying the connection
 * on EVERY exit (success, timeout, abort, connection error, external `close()`).
 *
 * WHY A SECOND SSE PATH (not `collectDurableEventsAt`): the drive loop needs
 * three things the single-promise `collectDurableEventsAt` collector cannot
 * express without either reintroducing a race or leaking the connection —
 *   1. a subscribe-FIRST `ready` signal — the caller must POST the trigger only
 *      AFTER the snapshot proves the subscription is live, yet keep collecting
 *      across the POST; `collectDurableEventsAt` opens→collects→resolves as one
 *      shot with no "am I subscribed yet?" hook to gate the POST on;
 *   2. a per-turn timeout that OWNS the connection — racing an external timer
 *      against `collectDurableEventsAt` cannot destroy its internally-owned
 *      request, which is exactly the leak this loop must avoid;
 *   3. a distinct {@link TurnOutcome} (`done` | `timeout` | `aborted`) — its
 *      `until` predicate returns only a boolean and cannot report WHICH
 *      condition stopped it.
 * Both paths already share the one thing that must not diverge: the SSE frame
 * parser (`parseFrames` from `@dorkos/test-utils`).
 *
 * @param opts - The drive options (baseUrl, sessionId, timeouts, abort guard).
 * @returns A {@link LiveStream} with `ready`, `done`, and `close`.
 */
function openStream(opts: DriveTurnOptions): LiveStream {
  const url = new URL(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  let signalReady!: () => void;
  let failReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    signalReady = resolve;
    failReady = reject;
  });

  let resolveDone!: (result: { frames: SseFrame[]; outcome: TurnOutcome }) => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<{ frames: SseFrame[]; outcome: TurnOutcome }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // The caller bails at `await ready` on a subscribe-gate failure and never
  // awaits `done`; a benign handler keeps that rejection from surfacing as an
  // unhandledRejection. The real awaiter on the happy path still receives it.
  done.catch(() => {});

  let raw = '';
  let settled = false;
  let readySettled = false;
  // A const holder so the timer ids can be referenced by the settle helpers
  // (defined below) yet assigned after `req` — `clearTimeout(undefined)` no-ops.
  const timers: { turn?: ReturnType<typeof setTimeout>; ready?: ReturnType<typeof setTimeout> } =
    {};

  /** Resolve the subscribe gate once (harmless if already settled). */
  const markReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(timers.ready);
    signalReady();
  };

  /** Settle `done` with an outcome and tear the connection down. Idempotent. */
  const finish = (outcome: TurnOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timers.turn);
    clearTimeout(timers.ready);
    req.destroy();
    // A fast turn may terminate before the snapshot line was observed; unblock
    // any pending `await ready` so the driver never hangs on a completed turn.
    markReady();
    resolveDone({ frames: parseFrames(raw), outcome });
  };

  /** Reject both gates on a connection error / subscribe-gate timeout and tear down. */
  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timers.turn);
    clearTimeout(timers.ready);
    req.destroy();
    if (!readySettled) {
      readySettled = true;
      failReady(err);
    }
    rejectDone(err);
  };

  const req = http.request(
    {
      host: url.hostname,
      port: Number(url.port),
      path: `/api/sessions/${opts.sessionId}/events`,
      method: 'GET',
    },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        if (raw.includes('event: snapshot')) markReady();
        const frames = parseFrames(raw);
        if (opts.abortWhen?.(frames)) return finish('aborted');
        if (frames.some(isTurnEnd)) finish('done');
      });
      res.on('end', () => finish('done'));
    }
  );

  req.on('error', (err: unknown) => {
    fail(
      new DriveError(
        `/events stream error: ${err instanceof Error ? err.message : String(err)}`,
        'STREAM_ERROR',
        undefined,
        { cause: err }
      )
    );
  });

  timers.turn = setTimeout(() => finish('timeout'), timeoutMs);
  timers.ready = setTimeout(
    () =>
      fail(
        new DriveError(
          `Timed out after ${readyTimeoutMs}ms waiting for the /events snapshot`,
          'STREAM_ERROR'
        )
      ),
    readyTimeoutMs
  );

  req.end();

  return { ready, done, close: () => finish('aborted') };
}

/**
 * Trigger a turn and collect it to completion. Subscribe-first: opens the
 * stream, waits for the snapshot, POSTs the trigger (expecting 202), then
 * collects to `turn_end` / timeout / abort.
 *
 * The `/events` stream is torn down on EVERY exit — a clean turn, a rejected
 * trigger (`DriveError`), or a connection error — so a locked/rejected trigger
 * can never leave the durable GET open.
 *
 * @param opts - See {@link DriveTurnOptions}.
 * @returns The canonical id, collected frames, and the turn outcome.
 * @throws {DriveError} On a `409 SESSION_LOCKED`, any non-202 trigger, or a `/events` stream error.
 */
export async function driveTurn(opts: DriveTurnOptions): Promise<DriveTurnResult> {
  const stream = openStream(opts);
  try {
    await stream.ready;

    const res = await fetch(`${opts.baseUrl}/api/sessions/${opts.sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: opts.content, cwd: opts.cwd }),
    });

    if (res.status === 409) {
      throw new DriveError('Session is locked by another client', 'SESSION_LOCKED', 409);
    }
    if (res.status !== 202) {
      throw new DriveError(
        `Trigger POST returned ${res.status}, expected 202`,
        'TRIGGER_REJECTED',
        res.status
      );
    }
    const body = (await res.json()) as { sessionId?: string };
    const canonicalId = body.sessionId ?? opts.sessionId;

    const { frames, outcome } = await stream.done;
    return { canonicalId, frames, outcome };
  } catch (err) {
    // Guarantee the durable GET is destroyed on any early exit (a rejected
    // trigger, a stream error). `close()` is idempotent — a no-op if the stream
    // already tore itself down.
    stream.close();
    throw err;
  }
}

/** Options for {@link driveConversation}. */
export interface DriveConversationOptions extends Omit<DriveTurnOptions, 'content'> {
  /** One or more prompts; each is a turn, run in order with the canonical id threaded forward. */
  prompts: string[];
}

/** All frames + outcome for a multi-turn drive, plus the final canonical id. */
export interface DriveConversationResult {
  /** The canonical id after the last turn. */
  canonicalId: string;
  /** Every frame collected across all turns, in order. */
  frames: SseFrame[];
  /** The last turn's outcome (`done` unless a turn timed out / aborted). */
  outcome: TurnOutcome;
}

/**
 * Drive a multi-turn conversation: each prompt is one {@link driveTurn}, with
 * the canonical id threaded forward. Stops early if a turn does not end `done`
 * (a `timeout` / `aborted` outcome surfaces up as the result's outcome).
 *
 * @param opts - See {@link DriveConversationOptions}.
 * @returns The final canonical id, all frames, and the last outcome.
 */
export async function driveConversation(
  opts: DriveConversationOptions
): Promise<DriveConversationResult> {
  let sessionId = opts.sessionId;
  const allFrames: SseFrame[] = [];
  let outcome: TurnOutcome = 'done';

  for (const prompt of opts.prompts) {
    const turn = await driveTurn({
      baseUrl: opts.baseUrl,
      sessionId,
      content: prompt,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      readyTimeoutMs: opts.readyTimeoutMs,
      abortWhen: opts.abortWhen,
    });
    sessionId = turn.canonicalId;
    allFrames.push(...turn.frames);
    outcome = turn.outcome;
    if (outcome !== 'done') break;
  }

  return { canonicalId: sessionId, frames: allFrames, outcome };
}
