/**
 * The two scripted turns that make tool-only room replies testable (spec
 * `tool-only-room-replies` §D14).
 *
 * ## Why test-mode is not tool-capable by default, and these two are
 *
 * Under `rooms.toolOnlyReplies` a turn's own words are never posted for it, so a
 * scenario that only narrates would answer nothing. Six e2e specs across
 * `room-autonomy.spec.ts` and `team-room.spec.ts`, plus the free structural eval
 * cases, all reach the room through exactly that path — so if the flag alone
 * decided suppression, turning it on would redden every one of them at once.
 *
 * {@link TestModeRuntime.carriesRoomTools} therefore answers `false` unless the
 * session's selected scenario is one of {@link TOOL_CAPABLE_SCENARIOS}. Flag-ON
 * changes nothing for any existing scenario, by construction rather than by
 * editing tests, and coverage of the flip comes from new specs that opt in.
 *
 * ## How a scripted turn "calls the tool"
 *
 * It does not, and it deliberately cannot: a scenario is handed the message it
 * is answering and nothing else — no room id, no entry id, no capability
 * registry — so a scenario that posted would have to be told which room to post
 * into, which is a whole second seam for a fixture. Both scenarios here HOLD the
 * turn open until `POST /api/test/finish-turn` instead, and the driver does the
 * posting: it mints a real agent token (`POST /api/test/agent-token`) and calls
 * the real `post_to_room` capability with it, mid-turn, exactly as an injected
 * `dorkos` MCP server would. So what is under test is the production mechanism —
 * `postFromTool`, the claim marks, `deliver` — driven deterministically.
 *
 * @module services/runtimes/test-mode/room-reply-scenarios
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioFn } from './scenario-store.js';

/**
 * How long a held room turn waits to be told it is over before ending anyway.
 *
 * A bound as well as a signal, the same reasoning `workingTurn` carries: a turn
 * nothing ever ends would outlive the run holding a projector open. Long enough
 * that a driver can mint a token, post, and read the room back; short enough
 * that a forgotten `finish-turn` costs one slow case rather than a hung suite.
 */
const HOLD_TICKS = 120;

/** Heartbeat interval while a room turn is held open. */
const HOLD_TICK_MS = 500;

/**
 * Whether `POST /api/test/finish-turn` has been raised, read through the store
 * so both files answer the same question.
 */
type FinishRequested = () => boolean;

/**
 * Build a room turn that parks until the driver has acted, then ends with the
 * words it was given — or with none.
 *
 * @param say - What the turn narrates back to its own session at the end, or
 *   `null` for a turn that produces no text at all.
 * @param finishRequested - Reads the store's finish flag.
 */
function heldRoomTurn(say: string | null, finishRequested: FinishRequested): ScenarioFn {
  return async function* (_content, ctx) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    for (let tick = 0; tick < HOLD_TICKS && !finishRequested() && !ctx.signal.aborted; tick += 1) {
      await ctx.delay(HOLD_TICK_MS);
    }
    // Emitted at the END rather than at the start, and that ordering is what the
    // flip is measured against: in tool-only mode this text must never reach the
    // room, and in text mode it must. A turn that narrated before the driver
    // posted would leave the two orders indistinguishable in a transcript.
    if (say !== null) {
      yield { type: 'text_delta', data: { text: say } } as StreamEvent;
    }
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  };
}

/**
 * The scripted room turns that declare themselves tool-capable.
 *
 * @param finishRequested - Reads the store's finish flag.
 * @returns The scenarios, keyed by the names `POST /api/test/scenario` accepts.
 */
export function roomReplyScenarios(finishRequested: FinishRequested): Record<string, ScenarioFn> {
  return {
    // Holds, then narrates. With the flip on, this text is the thing that must
    // NOT appear in the room; with it off, it is the answer.
    'rooms-hold-then-narrate': heldRoomTurn(
      'I looked at it and here is what I think.',
      finishRequested
    ),
    // Holds, then ends having produced nothing at all — the turn shape that is
    // silence in both modes, and the one `agent_declined` is measured on.
    'rooms-hold-then-quiet': heldRoomTurn(null, finishRequested),
  };
}

/**
 * Scenario names whose sessions report as carrying the DorkOS room tools.
 *
 * Every other scenario — every one that predates this feature — reports `false`,
 * which is what keeps the existing e2e and eval suites green with the flag on
 * (spec `tool-only-room-replies` §D14, acceptance criterion 19).
 */
export const TOOL_CAPABLE_SCENARIOS: ReadonlySet<string> = new Set([
  'rooms-hold-then-narrate',
  'rooms-hold-then-quiet',
]);
