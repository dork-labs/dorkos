/**
 * The restart half of the runtime conformance suite (spec
 * `turns-survive-restarts` §7.2, DOR-5213): every runtime says whether it wakes
 * a chat for background work a restart stopped, and whether a turn killed in
 * the middle can be continued, and a runtime that claims the second proves it
 * here.
 *
 * Two rules, both ways:
 *
 * - both capabilities are declared as booleans, never left `undefined`, so
 *   recovery never has to guess from a missing value;
 * - `continuesInterruptedTurn: true` comes with a {@link RestartContinueDriver}
 *   and `false` with a reason, never both and never neither. A driver for a
 *   runtime that does not claim the capability fails too: recovery would never
 *   use what it proved.
 *
 * **What a pass proves.** The runtime's SDK or binary is mocked in every
 * conformance file, so a pass proves DorkOS's side of a continuation only,
 * never that the real program resumes. A real runtime flips the flag with a
 * measured run recorded in the spec's §7.6.
 *
 * **What it does not assert yet.** The spec's case also reads the chat's
 * history back and expects the cut turn's tool result in it. A cut turn of a
 * log-backed runtime leaves no durable rows today (the projector flushes only
 * a finished turn), so that half waits for recovery's run record (T15).
 *
 * Kept apart from `runtime-conformance.ts`, which registers it, and exported so
 * the suite and its proof of failure (`__tests__/runtime-conformance-restart.test.ts`)
 * run the SAME rule.
 *
 * @module test-utils/runtime-conformance-restart
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, RuntimeCapabilities, SessionOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';

/** The two restart capabilities every runtime declares. */
export const RESTART_CAPABILITY_FLAGS = [
  'wakesForLostBackgroundWork',
  'continuesInterruptedTurn',
] as const satisfies readonly (keyof RuntimeCapabilities)[];

/** What the continuation turn is sent. Recovery's own words are T15's copy, not this. */
export const RESTART_CONTINUE_CONTENT = 'conformance: carry on with the turn a restart cut short';

/**
 * How one runtime's conformance run cuts a turn short and starts the runtime
 * again. The suite does the cutting: it reads the turn until a tool call ends,
 * then abandons it (never drained, returned or interrupted, the way a killed
 * process leaves it) and drops the instance.
 */
export interface RestartContinueDriver {
  /** The runtime that runs the turn to cut, set up so its next turn calls one tool. */
  start: (sessionId: string) => AgentRuntime | Promise<AgentRuntime>;
  /** A fresh runtime instance on the same storage, as a restarted server builds it. */
  restart: (sessionId: string) => AgentRuntime | Promise<AgentRuntime>;
}

/** The restart options a runtime's conformance run passes to `runtimeConformance`. */
export interface RestartCaseOpts {
  /**
   * Wire this exactly when the runtime declares `continuesInterruptedTurn: true`.
   * Otherwise give {@link restartContinueUnprovenReason}.
   */
  restartContinueTurn?: RestartContinueDriver;
  /**
   * Why this runtime does not continue a turn cut in the middle, in a sentence
   * somebody wrote (whitespace declares nothing). Exactly one of this and
   * {@link restartContinueTurn} must be given.
   */
  restartContinueUnprovenReason?: string;
}

/** What one run of the continuation case saw. */
export interface RestartContinueObservation {
  /** The cut turn's events, up to the moment it was abandoned. */
  cut: StreamEvent[];
  /** The continuation turn's events, from the fresh instance. */
  continuation: StreamEvent[];
}

/** Events that say a tool call has ended. */
const TOOL_ENDED = new Set(['tool_call_end', 'tool_result']);

/**
 * What is wrong with how a runtime declares its restart capabilities, one
 * sentence per problem; empty when the declaration is honest.
 *
 * @param capabilities - The runtime's declared capabilities.
 * @param opts - The restart options its conformance run passed.
 */
export function restartDeclarationProblems(
  capabilities: Pick<RuntimeCapabilities, (typeof RESTART_CAPABILITY_FLAGS)[number]>,
  opts: RestartCaseOpts
): string[] {
  const problems: string[] = [];
  for (const flag of RESTART_CAPABILITY_FLAGS) {
    if (typeof capabilities[flag] !== 'boolean') {
      problems.push(`\`${flag}\` must be declared as a boolean, so recovery never guesses`);
    }
  }
  const claims = capabilities.continuesInterruptedTurn === true;
  const wired = opts.restartContinueTurn !== undefined;
  const said = (opts.restartContinueUnprovenReason ?? '').trim().length > 0;
  if (claims && !wired) {
    problems.push(
      'declares `continuesInterruptedTurn` but wires no `restartContinueTurn`, so nothing here drives the continuation it claims'
    );
  }
  if (!claims && wired) {
    problems.push(
      'wires `restartContinueTurn` but does not declare `continuesInterruptedTurn`, so recovery would never use what it proves'
    );
  }
  if (wired && said) {
    problems.push(
      'wires `restartContinueTurn`, so a reason it cannot continue a turn would be dead copy'
    );
  }
  if (!claims && !wired && !said) {
    problems.push(
      'wires no `restartContinueTurn` and gives no `restartContinueUnprovenReason`, so nobody can tell why a turn of it cut by a restart is not continued'
    );
  }
  return problems;
}

/**
 * What is wrong with one run of the continuation case; empty when the cut turn
 * really was cut after a tool call and the fresh instance answered the next.
 *
 * @param observation - What the case saw.
 */
export function restartContinueProblems(observation: RestartContinueObservation): string[] {
  const problems: string[] = [];
  const { cut, continuation } = observation;
  if (!cut.some((event) => TOOL_ENDED.has(event.type))) {
    problems.push('the turn to cut never finished a tool call, so nothing was cut after one');
  }
  if (cut.some((event) => event.type === 'done')) {
    problems.push('the turn to cut reached `done`, so it ended rather than being cut');
  }
  const terminals = continuation.filter((event) => event.type === 'done');
  if (terminals.length !== 1 || continuation.at(-1)?.type !== 'done') {
    problems.push(
      `the continuation must end with exactly one \`done\`; it had ${terminals.length}, and its last event was ${continuation.at(-1)?.type ?? 'none'}`
    );
  }
  if (continuation.some((event) => event.type === 'error')) {
    problems.push('the continuation failed with an `error` event');
  }
  if (!continuation.some((event) => event.type === 'text_delta')) {
    problems.push('the continuation said nothing, so it did not answer');
  }
  return problems;
}

/**
 * Read one turn until a tool call ends, then abandon it: no more `next()`, no
 * `return()`, no interrupt, which is how a killed process leaves a turn.
 *
 * @param runtime - The runtime running the turn.
 * @param sessionId - The chat.
 * @param content - What the turn is sent.
 * @param cwd - The turn's working directory.
 */
async function readUntilToolEnds(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const turn = runtime.sendMessage(sessionId, content, { cwd })[Symbol.asyncIterator]();
  for (let step = await turn.next(); !step.done; step = await turn.next()) {
    events.push(step.value);
    if (TOOL_ENDED.has(step.value.type) || step.value.type === 'done') break;
  }
  return events;
}

/**
 * Register the restart cases for one runtime. `runtimeConformance` calls it, so
 * every runtime's conformance file runs it.
 *
 * @param makeRuntime - Factory producing a fresh runtime.
 * @param wiring - The runtime's restart options, plus the parent suite's session helpers.
 */
export function runtimeRestartConformance(
  makeRuntime: () => AgentRuntime,
  wiring: RestartCaseOpts & {
    nextSessionId: () => string;
    sessionOpts: (runtime: AgentRuntime) => SessionOpts & { cwd: string };
    messageContent: string;
  }
): void {
  const { restartContinueTurn, nextSessionId, sessionOpts, messageContent } = wiring;
  describe('restarts (turns-survive-restarts §7.2)', () => {
    it('declares both restart capabilities, and proves or explains continuesInterruptedTurn', () => {
      expect(restartDeclarationProblems(makeRuntime().getCapabilities(), wiring)).toEqual([]);
    });

    if (restartContinueTurn) {
      it('a turn cut after a tool call is continued by a fresh instance on the same chat', async () => {
        const sessionId = nextSessionId();
        const first = await restartContinueTurn.start(sessionId);
        const { cwd } = sessionOpts(first);
        first.ensureSession(sessionId, sessionOpts(first));
        const cut = await readUntilToolEnds(first, sessionId, messageContent, cwd);

        const second = await restartContinueTurn.restart(sessionId);
        second.ensureSession(sessionId, sessionOpts(second));
        const continuation: StreamEvent[] = [];
        for await (const event of second.sendMessage(sessionId, RESTART_CONTINUE_CONTENT, {
          cwd,
        })) {
          continuation.push(event);
        }
        expect(restartContinueProblems({ cut, continuation })).toEqual([]);
      });
    }
  });
}
