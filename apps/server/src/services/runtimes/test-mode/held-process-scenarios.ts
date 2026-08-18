/**
 * Scenarios that say, in their own answer, WHICH path served the turn.
 *
 * Every other test-mode scenario answers identically whether the session is
 * holding a process or starting fresh, which makes them useless for the rows
 * DOR-1326 exists to cover: "the second reply came from the same agent" and
 * "the words I added reached it" are claims about the machinery BEHIND the
 * answer, and a browser can only check them if the answer names it.
 *
 * So `warm-echo` reads the two facts only the held path can produce — how many
 * turns this session's process has served ({@link heldProcesses.turnsServed})
 * and what was staged onto it since the last one — and puts them in the text.
 * Turn the held path off and the same scenario says `NO-HELD-PROCESS`, so an
 * assertion on the warm marker goes red rather than quietly passing on the
 * resume path.
 *
 * It also renders the OTHER route a staged message can take: when the session
 * cannot be staged onto natively, the server folds the words into the next
 * dispatch as a `staged_context` entry (ADR-0273), which arrives in
 * `MessageOpts.additionalContext`. The two are labelled differently on purpose
 * — `staged-native:` versus `staged-folded:` — so a test that means to exercise
 * one path cannot pass on the other.
 *
 * Deliberately absent from `features.testModeScenarios`, like the other gated
 * fixtures: it parks on a step barrier only its own test releases, and a reader
 * who picked it off a list would be left holding an unfinished turn.
 *
 * @module services/runtimes/test-mode/held-process-scenarios
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { heldProcesses } from './held-process.js';
import type { ScenarioFn } from './scenario-store.js';

/** Session id stamped on the synthetic status events, matching the other families. */
const SCENARIO_SESSION_ID = 'test-mode';

/** Model reported on the opening `session_status`. */
const SCENARIO_MODEL = 'claude-haiku-4-5';

/** The staged words the server folded into this dispatch, in the order it sent them. */
function foldedStagedText(opts: MessageOpts | undefined): string[] {
  return (opts?.additionalContext ?? [])
    .filter((entry) => entry.kind === 'staged_context')
    .map((entry) => entry.data.text);
}

/**
 * How this turn's answer opens — the marker a browser test reads to learn which
 * path served it.
 *
 * `NO-HELD-PROCESS` is the resume path: this session holds nothing, so the turn
 * is its own scripted work. `HELD-PROCESS-TURN-1` is the turn that booted a
 * process; anything higher is a process that SURVIVED the turns before it,
 * which is the whole claim of L-11. A reap drops the process, so the turn after
 * one counts from 1 again — the honest report that a fresh process answered.
 *
 * @param turnsServed - Turns this session's held process has served, `0` when
 *   it holds none.
 */
function pathMarker(turnsServed: number): string {
  return turnsServed === 0 ? 'NO-HELD-PROCESS' : `HELD-PROCESS-TURN-${turnsServed}`;
}

/**
 * L-11 / C-09b / C-11 — an echo that names the process it came from, holds the
 * turn open until the test says otherwise, and repeats anything staged onto it.
 *
 * The step barrier is what makes it usable for a MOMENT as well as for an
 * outcome: a steer and an Add context both need a turn genuinely running under
 * them, and every scenario that finishes in one pass closes that window before a
 * browser can reach it (the argument `live-turn-visibility.ts` makes at length).
 * One `POST /api/test/step` per turn ends it normally.
 */
const warmEcho: ScenarioFn = async function* (content, ctx, opts) {
  // Read BEFORE anything is yielded: the turn is already counted (the runtime
  // begins it before the scenario runs), and the staged words are drained here
  // so they ride exactly one answer.
  const marker = pathMarker(heldProcesses.turnsServed(ctx.sessionId));
  const staged = heldProcesses.takeStaged(ctx.sessionId);
  const folded = foldedStagedText(opts);

  yield {
    type: 'session_status',
    data: { sessionId: SCENARIO_SESSION_ID, model: SCENARIO_MODEL },
  } as StreamEvent;
  // An opening sentence before the barrier, which is a contract rather than
  // flavour: `ChatPage.sendAndLand` proves a send started a turn by waiting for
  // the agent to BEGIN answering, and a scenario that parked in silence would
  // look exactly like a send that was dropped.
  yield { type: 'text_delta', data: { text: `${marker}: ${content}` } } as StreamEvent;
  for (const words of staged) {
    yield { type: 'text_delta', data: { text: `\nstaged-native: ${words}` } } as StreamEvent;
  }
  for (const words of folded) {
    yield { type: 'text_delta', data: { text: `\nstaged-folded: ${words}` } } as StreamEvent;
  }

  await ctx.awaitStep();
  yield { type: 'done', data: { sessionId: SCENARIO_SESSION_ID } } as StreamEvent;
};

/**
 * Held-path scenarios keyed by the name accepted at `POST /api/test/scenario`.
 * Merged into the test-mode scenario registry at import time.
 */
export const HELD_PROCESS_SCENARIOS: Record<string, ScenarioFn> = {
  'warm-echo': warmEcho,
};
