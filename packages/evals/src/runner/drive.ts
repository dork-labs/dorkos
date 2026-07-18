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
 * A `409 SESSION_LOCKED`, a non-202 trigger, and a per-turn timeout are RUNNER
 * errors (a {@link DriveError} / `timeout` outcome), reported distinctly from an
 * eval's oracle failure so an infra flake is never read as a product regression.
 *
 * @module evals/runner/drive
 */
import http from 'node:http';
import { parseFrames, type SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { Oracle } from '../types.js';

/** How a single driven turn ended. */
export type TurnOutcome = 'done' | 'timeout' | 'aborted';

/** A runner error triggering the turn (distinct from an eval/oracle failure). */
export class DriveError extends Error {
  /**
   * Construct a drive error carrying a stable machine code.
   *
   * @param message - Human-readable cause.
   * @param code - Stable machine code (`SESSION_LOCKED`, `TRIGGER_REJECTED`).
   * @param status - The HTTP status the trigger returned, when relevant.
   */
  constructor(
    message: string,
    readonly code: 'SESSION_LOCKED' | 'TRIGGER_REJECTED',
    readonly status?: number
  ) {
    super(message);
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

/** A live `/events` connection with a ready signal and a completion promise. */
interface LiveStream {
  /** Resolves once the cold `snapshot` frame has arrived (safe to POST). */
  ready: Promise<void>;
  /** Resolves with the collected frames + outcome when the turn terminates. */
  done: Promise<{ frames: SseFrame[]; outcome: TurnOutcome }>;
}

/** True when a frame is the turn's terminal `turn_end` boundary. */
function isTurnEnd(frame: SseFrame): boolean {
  return frame.event === 'turn_end';
}

/**
 * Open `GET /:id/events`, signal `ready` on the cold snapshot, and collect until
 * a `turn_end` frame, a timeout, or the abort guard. Reuses `parseFrames`.
 *
 * @param opts - The drive options (baseUrl, sessionId, timeout, abort guard).
 * @returns A {@link LiveStream} with `ready` and `done`.
 */
function openStream(opts: DriveTurnOptions): LiveStream {
  const url = new URL(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });

  const done = new Promise<{ frames: SseFrame[]; outcome: TurnOutcome }>((resolve, reject) => {
    let raw = '';
    let settled = false;
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `/api/sessions/${opts.sessionId}/events`,
        method: 'GET',
      },
      (res) => {
        res.setEncoding('utf8');
        const finish = (outcome: TurnOutcome): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          signalReady();
          resolve({ frames: parseFrames(raw), outcome });
        };
        res.on('data', (chunk: string) => {
          raw += chunk;
          if (raw.includes('event: snapshot')) signalReady();
          const frames = parseFrames(raw);
          if (opts.abortWhen?.(frames)) return finish('aborted');
          if (frames.some(isTurnEnd)) finish('done');
        });
        res.on('end', () => finish('done'));
      }
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      signalReady();
      resolve({ frames: parseFrames(raw), outcome: 'timeout' });
    }, timeoutMs);
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });

  return { ready, done };
}

/**
 * Trigger a turn and collect it to completion. Subscribe-first: opens the
 * stream, waits for the snapshot, POSTs the trigger (expecting 202), then
 * collects to `turn_end` / timeout / abort.
 *
 * @param opts - See {@link DriveTurnOptions}.
 * @returns The canonical id, collected frames, and the turn outcome.
 * @throws {DriveError} On a `409 SESSION_LOCKED` or any non-202 trigger.
 */
export async function driveTurn(opts: DriveTurnOptions): Promise<DriveTurnResult> {
  const stream = openStream(opts);
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
}

/** Options for {@link driveConversation}. */
export interface DriveConversationOptions extends Omit<DriveTurnOptions, 'content'> {
  /** One or more prompts; each is a turn, run in order. */
  prompts: string[];
  /**
   * Optional oracle run BETWEEN turns (after each turn except the last), so a
   * multi-turn eval can assert intermediate state. A failing intermediate oracle
   * does NOT stop the conversation — it is recorded and surfaced by the caller.
   */
  betweenTurns?: Oracle;
  /** Context an intermediate oracle needs (sandbox); supplied by the runner. */
  betweenTurnsContext?: { sandbox: { projectCwd: string; dorkHome: string } };
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
 * the canonical id threaded forward and an optional intermediate oracle between
 * turns. Stops early if a turn does not end `done` (timeout/abort surfaces up).
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

  for (let i = 0; i < opts.prompts.length; i++) {
    const turn = await driveTurn({
      baseUrl: opts.baseUrl,
      sessionId,
      content: opts.prompts[i],
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      abortWhen: opts.abortWhen,
    });
    sessionId = turn.canonicalId;
    allFrames.push(...turn.frames);
    outcome = turn.outcome;
    if (outcome !== 'done') break;

    if (opts.betweenTurns && opts.betweenTurnsContext && i < opts.prompts.length - 1) {
      await opts.betweenTurns({
        sandbox: opts.betweenTurnsContext.sandbox,
        baseUrl: opts.baseUrl,
        sessionId,
        frames: allFrames,
      });
    }
  }

  return { canonicalId: sessionId, frames: allFrames, outcome };
}
