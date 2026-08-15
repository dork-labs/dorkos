/**
 * The lever a browser test needs to drive an INTERACTIVE turn deterministically.
 *
 * Every built-in test-mode scenario before this one ran to completion the moment
 * it was started: it could show an approval card, but it could never show what
 * happens after somebody presses Approve, because nothing in the scenario was
 * ever waiting for the answer. `TestModeRuntime.approveTool` answered `false`,
 * and so did `submitAnswers`, `submitElicitation` and `interruptQuery` — the
 * whole interactive half of the session contract was a stub.
 *
 * This module is the missing half. A scenario receives a {@link ScenarioContext}
 * and can PAUSE on it: on an operator's approval, on an answer to a question, on
 * an MCP elicitation response, or on a plain step barrier the test releases by
 * hand. The runtime's interactive methods resolve those pauses, so the real
 * product routes (`POST /:id/approve`, `/deny`, `/submit-answers`,
 * `/submit-elicitation`, `/interrupt`) drive a scripted turn end to end exactly
 * as they drive a real one.
 *
 * **Every wait is abortable, and that is load-bearing.** `Stop` on a turn that
 * is parked on an approval nobody will ever give has to end the turn rather than
 * leak a pending promise and a projector holding it open — so {@link abort}
 * rejects every outstanding wait for that session with {@link ScenarioAborted},
 * which `TestModeRuntime.sendMessage` catches and turns into an honest terminal
 * `aborted_streaming`.
 *
 * @module services/runtimes/test-mode/interaction-gate
 */

/** What an operator answered on a tool-approval card. */
export interface ToolDecision {
  /** True for Approve, false for Deny. */
  approved: boolean;
  /** Approve-and-don't-ask-again, from the card's "Always allow" affordance. */
  alwaysAllow?: boolean;
  /** The person's own words on a refusal, when they gave any. */
  denyReason?: string;
}

/** What an operator answered on an MCP elicitation card. */
export interface ElicitationDecision {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/**
 * Thrown into a scenario's pending wait when the turn is stopped.
 *
 * A named class rather than a plain `Error` so `sendMessage` can tell a deliberate
 * stop apart from a scenario that genuinely threw — the second must still surface
 * as a failure rather than be swallowed as a tidy interruption.
 */
export class ScenarioAborted extends Error {
  constructor() {
    super('Test-mode scenario aborted');
    this.name = 'ScenarioAborted';
  }
}

/**
 * The handle a scenario uses to wait for the outside world.
 *
 * Passed as the SECOND argument to every {@link ScenarioFn}, so the scenarios
 * that predate it — which declare only `(content)` — keep type-checking and
 * behaving identically.
 */
export interface ScenarioContext {
  /** The session this turn belongs to. */
  readonly sessionId: string;
  /**
   * This turn's identity, which {@link InteractionGate.close} requires so a
   * finished turn can never tear down the one that replaced it.
   */
  readonly token: TurnToken;
  /** Aborted when the turn is stopped; also drives {@link ScenarioContext.delay}. */
  readonly signal: AbortSignal;
  /** Park until the operator approves or denies `toolCallId`. */
  awaitApproval(toolCallId: string): Promise<ToolDecision>;
  /** Park until the operator answers the question posted under `toolCallId`. */
  awaitAnswers(toolCallId: string): Promise<Record<string, string>>;
  /** Park until the operator responds to the elicitation `interactionId`. */
  awaitElicitation(interactionId: string): Promise<ElicitationDecision>;
  /**
   * Park until the test releases one step (`POST /api/test/step`).
   *
   * The clock a test needs when the thing it is watching is a PROGRESSION —
   * todos advancing, sub-agents settling — rather than a single blocking ask.
   * Racing a paced scenario's own timers is the alternative, and that is how a
   * test ends up asserting whichever frame it happened to catch.
   */
  awaitStep(): Promise<void>;
  /** Sleep, waking early (and throwing {@link ScenarioAborted}) on a stop. */
  delay(ms: number): Promise<void>;
}

/**
 * Identity for ONE turn's gate on a session.
 *
 * Opaque on purpose: a caller may only ever pass back the token it was handed,
 * which is what makes {@link InteractionGate.close} unable to close a turn it
 * does not own.
 */
export type TurnToken = symbol;

/** One session's outstanding waits. */
interface SessionGate {
  /** This turn's identity — see {@link TurnToken}. */
  readonly token: TurnToken;
  readonly controller: AbortController;
  /** Keyed by tool-call id. */
  readonly approvals: Map<string, (decision: ToolDecision) => void>;
  /** Keyed by tool-call id. */
  readonly answers: Map<string, (answers: Record<string, string>) => void>;
  /** Keyed by interaction id. */
  readonly elicitations: Map<string, (decision: ElicitationDecision) => void>;
  /** FIFO of scenarios parked on {@link ScenarioContext.awaitStep}. */
  readonly steps: (() => void)[];
  /** Every pending wait's rejecter, so an abort can clear them all at once. */
  readonly rejecters: Set<(err: Error) => void>;
}

/**
 * Per-session interactive state for in-flight test-mode turns.
 *
 * A singleton for the same reason {@link scenarioStore} is one: the scenario
 * functions are module-level and the control routes reach them by session id.
 */
class InteractionGate {
  private readonly sessions = new Map<string, SessionGate>();

  /**
   * Begin a turn and hand back the context its scenario will wait on.
   *
   * Tears down any gate left by a previous turn on the same session — a turn
   * that ended (naturally or by a stop) has no waits worth keeping, and carrying
   * them forward would let a stale approval answer the next turn's card.
   *
   * The returned context carries this turn's {@link TurnToken}, which
   * {@link close} requires. See that method for why.
   *
   * @param sessionId - The session opening a turn.
   */
  open(sessionId: string): ScenarioContext {
    const previous = this.sessions.get(sessionId);
    if (previous) {
      this.sessions.delete(sessionId);
      this.rejectAll(previous);
    }
    const gate: SessionGate = {
      token: Symbol('test-mode-turn'),
      controller: new AbortController(),
      approvals: new Map(),
      answers: new Map(),
      elicitations: new Map(),
      steps: [],
      rejecters: new Set(),
    };
    this.sessions.set(sessionId, gate);
    return this.contextFor(sessionId, gate);
  }

  /**
   * Drop a turn's gate once it has finished, aborting anything still parked.
   *
   * **Closes only the turn that owns `token`, and that is the whole point.**
   * This is called from `sendMessage`'s `finally`, which runs when the generator
   * is disposed — and on a busy session that can happen AFTER the next turn has
   * already opened its own gate. A close that simply deleted whatever was
   * registered would then destroy the live turn's gate: its approval card
   * becomes unanswerable, every parked wait rejects, and the turn dies as
   * `aborted_streaming` for no reason anybody can see from the outside. On a
   * shared mock leg driven by several specs that is a flake generator.
   *
   * A token that no longer matches means this turn was already superseded, so
   * there is nothing left to clean up and this is a no-op.
   *
   * @param sessionId - The session the turn belonged to.
   * @param token - The token {@link open} returned on that turn's context.
   */
  close(sessionId: string, token: TurnToken): void {
    const gate = this.sessions.get(sessionId);
    if (!gate || gate.token !== token) return;
    this.sessions.delete(sessionId);
    this.rejectAll(gate);
  }

  /**
   * Answer a pending tool approval.
   *
   * @returns Whether a scenario was actually waiting on this id — the signal the
   *   `/approve` and `/deny` routes turn into 200 versus 409.
   */
  resolveApproval(sessionId: string, toolCallId: string, decision: ToolDecision): boolean {
    const gate = this.sessions.get(sessionId);
    const resolve = gate?.approvals.get(toolCallId);
    if (!gate || !resolve) return false;
    gate.approvals.delete(toolCallId);
    resolve(decision);
    return true;
  }

  /** Answer a pending question. Returns whether anything was waiting. */
  resolveAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const gate = this.sessions.get(sessionId);
    const resolve = gate?.answers.get(toolCallId);
    if (!gate || !resolve) return false;
    gate.answers.delete(toolCallId);
    resolve(answers);
    return true;
  }

  /** Answer a pending elicitation. Returns whether anything was waiting. */
  resolveElicitation(
    sessionId: string,
    interactionId: string,
    decision: ElicitationDecision
  ): boolean {
    const gate = this.sessions.get(sessionId);
    const resolve = gate?.elicitations.get(interactionId);
    if (!gate || !resolve) return false;
    gate.elicitations.delete(interactionId);
    resolve(decision);
    return true;
  }

  /** Release ONE step barrier. Returns whether a scenario was parked on one. */
  step(sessionId: string): boolean {
    const gate = this.sessions.get(sessionId);
    const release = gate?.steps.shift();
    if (!release) return false;
    release();
    return true;
  }

  /**
   * The ids of every interaction this session's turn is currently parked on.
   *
   * Read BEFORE {@link abort}, which clears them: a stop has to resolve these on
   * the projector, or the cards it just made unanswerable stay in
   * `pendingInteractions` forever. See `TestModeRuntime.interruptQuery`.
   *
   * @param sessionId - The session to inspect.
   */
  pendingInteractionIds(sessionId: string): string[] {
    const gate = this.sessions.get(sessionId);
    if (!gate) return [];
    return [...gate.approvals.keys(), ...gate.answers.keys(), ...gate.elicitations.keys()];
  }

  /**
   * Stop a running turn: abort its signal and reject every outstanding wait.
   *
   * Deliberately targets whatever gate is REGISTERED rather than taking a
   * {@link TurnToken} the way {@link close} does, and the asymmetry is the
   * point. A close is a finished turn tidying up after itself, so it must prove
   * it still owns what it is tearing down. An abort is an operator pressing Stop
   * — "end whatever is running on this session now" — and its only caller,
   * `interruptQuery`, is handed a session id and nothing else. There is no
   * stale-abort path: nobody holds an abort across a turn boundary.
   *
   * @returns Whether a turn was actually open — what `interruptQuery` reports,
   *   and therefore what the Stop route answers `ok` with.
   */
  abort(sessionId: string): boolean {
    const gate = this.sessions.get(sessionId);
    if (!gate) return false;
    this.sessions.delete(sessionId);
    this.rejectAll(gate);
    return true;
  }

  /** Whether a turn is currently open on this session. */
  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Abort every session — the `POST /api/test/reset` path. */
  reset(): void {
    for (const sessionId of [...this.sessions.keys()]) this.abort(sessionId);
  }

  /** Abort the signal and reject every parked wait exactly once. */
  private rejectAll(gate: SessionGate): void {
    gate.controller.abort();
    const rejecters = [...gate.rejecters];
    gate.rejecters.clear();
    gate.approvals.clear();
    gate.answers.clear();
    gate.elicitations.clear();
    gate.steps.length = 0;
    for (const reject of rejecters) reject(new ScenarioAborted());
  }

  /** Build the scenario-facing handle over one session's gate. */
  private contextFor(sessionId: string, gate: SessionGate): ScenarioContext {
    /**
     * A wait that settles either when `register` is answered or when the turn is
     * aborted — never neither, which is the shape that leaks a hung turn.
     */
    const parked = <T>(register: (resolve: (value: T) => void) => void): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (gate.controller.signal.aborted) {
          reject(new ScenarioAborted());
          return;
        }
        const settle = (value: T) => {
          gate.rejecters.delete(reject);
          resolve(value);
        };
        gate.rejecters.add(reject);
        register(settle);
      });

    return {
      sessionId,
      token: gate.token,
      signal: gate.controller.signal,
      awaitApproval: (toolCallId) =>
        parked<ToolDecision>((resolve) => gate.approvals.set(toolCallId, resolve)),
      awaitAnswers: (toolCallId) =>
        parked<Record<string, string>>((resolve) => gate.answers.set(toolCallId, resolve)),
      awaitElicitation: (interactionId) =>
        parked<ElicitationDecision>((resolve) => gate.elicitations.set(interactionId, resolve)),
      awaitStep: () => parked<void>((resolve) => gate.steps.push(() => resolve())),
      delay: (ms) =>
        parked<void>((resolve) => {
          const timer = setTimeout(() => resolve(), ms);
          // Stop must not wait out a sleep that could be minutes long.
          gate.controller.signal.addEventListener('abort', () => clearTimeout(timer), {
            once: true,
          });
        }),
    };
  }
}

/** The process-wide interactive gate for test-mode turns. */
export const interactionGate = new InteractionGate();
