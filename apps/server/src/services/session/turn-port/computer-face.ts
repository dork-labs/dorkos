/**
 * The computer face's shape, and the one this computer installed at startup
 * (spec `turns-survive-restarts` §3.1). A leaf: the space side reaches the face
 * through here without loading the launch path it wraps
 * (`computer-turn-port.ts`, which startup builds).
 *
 * @module services/session/turn-port/computer-face
 */
import type { InterruptReceipt } from '@dorkos/shared/schemas';
import type { TurnStartAnswer, TurnStartRequest } from '@dorkos/shared/turn-port';

/** The computer face: what the space face's `start_turn` handler calls. */
export interface ComputerTurnPort {
  /**
   * Take a run, or refuse it.
   *
   * @param request - The run, its words inline, and what admission decided.
   */
  start(request: TurnStartRequest): Promise<TurnStartAnswer>;
  /**
   * Let go of a run still waiting in the dispatcher, because its deadline
   * passed. A launch already under way is not touched: that launch ends it.
   *
   * @param runId - The run.
   * @returns False when its launch is under way; true when nothing here holds it now.
   */
  withdraw(runId: string): boolean;
  /**
   * Whether this computer holds the run: waiting, launching or running.
   *
   * @param runId - The run.
   */
  holds(runId: string): boolean;
  /**
   * Take a run's words off the chat's queue, as a person's Remove does: its
   * run is cancelled with the row (`removed`), unless its launch is under way.
   *
   * @param sessionId - The chat.
   * @param runId - The run, whose queue row has the same id.
   * @returns Whether a row was removed.
   */
  removeQueued(sessionId: string, runId: string): boolean;
  /**
   * Stop one run's turn, leaving the chat's queue and every other run alone
   * (§3.1, §3.6).
   *
   * @param runId - The run.
   * @returns The runtime's receipt (ADR 260823-021312), or `undefined` when
   *   the run has no turn running on this computer.
   */
  stop(runId: string): Promise<InterruptReceipt | undefined>;
}

let installed: ComputerTurnPort | undefined;

/**
 * Wire (or clear) this computer's face at startup.
 *
 * @param port - The face, or `undefined`.
 */
export function setComputerTurnPort(port: ComputerTurnPort | undefined): void {
  installed = port;
}

/** This computer's face, or `undefined` before startup wired it. */
export function getComputerTurnPort(): ComputerTurnPort | undefined {
  return installed;
}
