/**
 * The scripted stand-in for an agent process a session HOLDS between turns —
 * test-mode's half of the persistent path (DOR-1326).
 *
 * ## Why a fake pump exists at all
 *
 * The persistent path (`runtimes.claudeCode.persistentSession`, "Keep agents
 * warm between messages") had unit coverage per row, one agentic pass, and
 * nothing deterministic above the unit layer — because the only runtime a
 * browser test can drive for free declared `supportsPersistentSession: false`
 * and steered every open turn. That made the one shape the persistent path
 * keeps getting wrong unreachable in a browser: a **capable runtime paired with
 * an incapable session** (DOR-1268, DOR-1307). A composer that asks only the
 * runtime offers a cut-in that silently becomes an ordinary follow-up turn; a
 * server that asks only the runtime takes a native stage that has to boot a
 * process nobody opted into.
 *
 * This is that shape, scripted. It is **not a second pump**: nothing here
 * spawns, holds a stream, or serves a turn. It is bookkeeping — which sessions
 * opted in, which of them are holding a scripted process, how many turns that
 * process has served, and what has been staged onto it — so the answers
 * `getSessionWarmth`, `canSteerSession` and `canStageSession` give VARY per
 * session the way a real pump's do. Everything a browser then observes (the
 * hidden Steer row, the `turn_input` bubble, the fold note, the warmth) is the
 * product's own machinery reacting to those answers.
 *
 * ## It mirrors claude-code's semantics deliberately
 *
 * - The opt-in is per SESSION, not per process — `POST /api/test/persistent`
 *   names the session it is turning on. The test-mode server is shared by four
 *   concurrent Playwright projects, so a process-wide switch would reach into a
 *   neighbour's specs (the same reason `POST /api/test/step` is session-keyed
 *   while `finish-turn` is not).
 * - `willHold` answers "would this session's NEXT turn run on a held process",
 *   which is what claude-code's `canSteerSession`/`canStageSession` ask
 *   (`PersistentDispatch.shouldDispatch`). A session that opted in is steerable
 *   before its first turn; a session already holding a process stays steerable
 *   even after the opt-in is turned off, because turning it off does not take a
 *   warm process back.
 * - A reap gives the process back and the next turn starts a fresh one, which
 *   the person cannot tell apart — the invariant conformance C5 holds.
 *
 * @module services/runtimes/test-mode/held-process
 */
import type { SessionWarmth } from '@dorkos/shared/agent-runtime';

/**
 * Identity for ONE turn running on a held process.
 *
 * Opaque, and required by {@link HeldProcessRegistry.endTurn} for the reason
 * `InteractionGate.close` requires its own token: `sendMessage`'s `finally`
 * runs when the generator is DISPOSED, which on a busy session can be after the
 * next turn has already begun. Without the token that late `finally` would
 * settle the live turn's process back to `warm` while it is still running.
 */
export type HeldTurnToken = symbol;

/** One session's scripted process. */
interface HeldProcess {
  /**
   * Turns THIS process has served, counted at {@link HeldProcessRegistry.beginTurn}.
   *
   * The one fact a scenario can read to prove the process was HELD rather than
   * started fresh: it is `1` on the turn that boots it and climbs only while the
   * same process survives. A reap drops the entry, so the next turn counts `1`
   * again — which is exactly what "the reap started a fresh process" means.
   */
  turnsServed: number;
  /** Set while a turn is running on it; see {@link HeldTurnToken}. */
  turn: HeldTurnToken | undefined;
  /**
   * Words staged onto the process since its last turn, drained by the next one.
   *
   * The scripted equivalent of claude-code's native stage, which pushes into the
   * pump's held input stream so the next reply is produced with the words
   * already in the transcript. Here the next turn reads them back out, which is
   * how a browser test can prove a native stage LANDED rather than merely
   * receiving a receipt.
   */
  staged: string[];
}

/**
 * Which test-mode sessions run on a held process, and what each one is holding.
 *
 * A singleton for the same reason {@link scenarioStore} and
 * {@link interactionGate} are: the control routes reach it by session id, and
 * both TestModeRuntime instances (`test-mode` and the e2e's `test-mode-b`) must
 * agree about a session either of them may be serving.
 */
class HeldProcessRegistry {
  /** Sessions whose next turn should run on a held process. */
  private readonly optedIn = new Set<string>();

  /** Sessions holding one right now. */
  private readonly processes = new Map<string, HeldProcess>();

  /**
   * Turn the held path on or off for ONE session.
   *
   * Turning it off does NOT cool a session that is already holding a process,
   * mirroring claude-code exactly (ADR `260812-134510`: "turning it off does not
   * retroactively cool a session that is already warm"). {@link reap} is how a
   * process is given back.
   *
   * @param sessionId - The session to opt in or out.
   * @param enabled - Whether its next turn should run on a held process.
   */
  setEnabled(sessionId: string, enabled: boolean): void {
    if (enabled) this.optedIn.add(sessionId);
    else this.optedIn.delete(sessionId);
  }

  /** Whether this session has opted into the held path. */
  isEnabled(sessionId: string): boolean {
    return this.optedIn.has(sessionId);
  }

  /**
   * Whether this session's next turn would run on a held process — the question
   * `canSteerSession` and `canStageSession` answer.
   *
   * Deliberately NOT "is it warm this instant": an affordance that flickered
   * with the turn would describe the moment rather than the session, which is
   * the note claude-code's own `canSteerSession` carries.
   *
   * @param sessionId - Session to report on, including one never heard of.
   */
  willHold(sessionId: string): boolean {
    return this.optedIn.has(sessionId) || this.processes.has(sessionId);
  }

  /** Whether this session is holding a scripted process right now. */
  holds(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  /**
   * How warm this session's scripted process is.
   *
   * `cold` for a session holding none, including one never heard of — the
   * answer {@link AgentRuntime.getSessionWarmth} requires. There is no
   * `warming` or `crashed` here: nothing boots and nothing dies, and reporting
   * a state this fixture cannot reach would be an invention.
   *
   * @param sessionId - Session to report on.
   */
  warmth(sessionId: string): SessionWarmth {
    const held = this.processes.get(sessionId);
    if (!held) return 'cold';
    return held.turn === undefined ? 'warm' : 'running';
  }

  /**
   * Turns the currently-held process has served, or `0` when the session holds
   * none. Read by the `warm-echo` scenario to say whether it is answering on a
   * process that survived the last turn.
   *
   * @param sessionId - Session to report on.
   */
  turnsServed(sessionId: string): number {
    return this.processes.get(sessionId)?.turnsServed ?? 0;
  }

  /**
   * Begin a turn on this session's held process, booting one if the session has
   * opted in and holds none yet.
   *
   * @param sessionId - The session opening a turn.
   * @returns The turn's token, or `undefined` when this session is NOT on the
   *   held path — the resume-path answer, where each turn is its own scripted
   *   work and there is nothing to hand back.
   */
  beginTurn(sessionId: string): HeldTurnToken | undefined {
    if (!this.willHold(sessionId)) return undefined;
    const held = this.processes.get(sessionId) ?? { turnsServed: 0, turn: undefined, staged: [] };
    held.turnsServed += 1;
    held.turn = Symbol('test-mode-held-turn');
    this.processes.set(sessionId, held);
    return held.turn;
  }

  /**
   * End a turn, leaving the process WARM for the next one.
   *
   * A no-op when `token` is not the running turn's — see {@link HeldTurnToken}.
   * The process survives however the turn ended, a Stop included: an acked stop
   * on the real pump leaves the process alive (the 2026-08-17 flag-ON runs
   * measured exactly that), and a fixture that cooled the session on a stop
   * would make the browser leg prove the opposite of what ships.
   *
   * @param sessionId - The session whose turn ended.
   * @param token - The token {@link beginTurn} handed that turn.
   */
  endTurn(sessionId: string, token: HeldTurnToken): void {
    const held = this.processes.get(sessionId);
    if (!held || held.turn !== token) return;
    held.turn = undefined;
  }

  /**
   * Make sure this session holds a process, booting one if it opted in and
   * holds none yet — the warm-on-demand half of a native stage.
   *
   * **A stage may have to WARM a cold session, and that is not an optimisation.**
   * The words have to reach a transcript, and a session that has not run a turn
   * has none live — so claude-code's `PersistentDispatch.stage` launches the
   * pump before appending (`persistent-dispatch.ts`), gated on the same opt-in
   * that decides whether its next turn would run on a held process. Without this
   * the fake diverged from the pump in two states it genuinely reaches — opted
   * in before the first turn, and opted in after a reap — where
   * {@link willHold} answers `true` while {@link holds} answers `false`. There
   * the server would take the native route on the strength of
   * `canStageSession`, get a refusal it is not allowed to fold, and QUEUE the
   * words as an ordinary message that provokes a reply: the one outcome
   * Add context promises never to produce.
   *
   * The booted process has served no turns, so the next one still reports
   * `HELD-PROCESS-TURN-1` — the honest reading, since it is the turn that first
   * runs on it.
   *
   * @param sessionId - The session being staged onto.
   * @returns Whether the session holds a process now. `false` only for a
   *   session that never opted in, which has no path onto the held path at all.
   */
  ensureHeld(sessionId: string): boolean {
    if (!this.willHold(sessionId)) return false;
    if (!this.processes.has(sessionId)) {
      this.processes.set(sessionId, { turnsServed: 0, turn: undefined, staged: [] });
    }
    return true;
  }

  /**
   * Put words in front of the held process without provoking a turn — the
   * scripted native stage.
   *
   * @param sessionId - The session being staged onto.
   * @param content - The person's words.
   * @returns Whether there was a process to append to. `false` is the honest
   *   receipt for a session on the resume path, which the server answers by
   *   folding the words into the next dispatch instead.
   */
  stage(sessionId: string, content: string): boolean {
    const held = this.processes.get(sessionId);
    if (!held) return false;
    held.staged.push(content);
    return true;
  }

  /**
   * Drain everything staged onto this session's process since its last turn.
   *
   * Draining rather than reading is what makes the next answer carry the words
   * ONCE, the way a transcript entry is consumed once.
   *
   * @param sessionId - The session whose turn is starting.
   */
  takeStaged(sessionId: string): string[] {
    const held = this.processes.get(sessionId);
    if (!held || held.staged.length === 0) return [];
    return held.staged.splice(0, held.staged.length);
  }

  /**
   * Give the process back, leaving the session record and its transcript alone.
   *
   * Idempotent, and invisible to the person: the next message boots a fresh
   * process and the conversation carries on (conformance C5).
   *
   * @param sessionId - The session whose process should be given back.
   * @returns Whether one was actually held.
   */
  reap(sessionId: string): boolean {
    return this.processes.delete(sessionId);
  }

  /** Forget every opt-in and every held process — the `POST /api/test/reset` path. */
  reset(): void {
    this.optedIn.clear();
    this.processes.clear();
  }
}

/** The process-wide held-process bookkeeping for test-mode sessions. */
export const heldProcesses = new HeldProcessRegistry();
