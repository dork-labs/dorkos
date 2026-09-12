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
 * For the two tool-only scenarios it does not, and deliberately: a turn that
 * posted would have to be told which room to post into, so both HOLD the turn
 * open until `POST /api/test/finish-turn` and the DRIVER does the posting — it
 * mints a real agent token (`POST /api/test/agent-token`) and calls the real
 * `post_to_room` capability with it, mid-turn, exactly as an injected `dorkos`
 * MCP server would.
 *
 * {@link roomReadsCanvas} is the one scenario that does call a capability
 * itself, and it has to: what it exists to prove is that a face appears on a
 * canvas tab **only while a claim is held**, and the claim is held for exactly
 * as long as the turn runs. A driver calling from outside would be calling after
 * the turn, which is the case that must show nothing. It can, because a room
 * turn is now handed `MessageOpts.roomTurn` — the room, the member and the turn
 * id, all server-derived (spec `room-canvas` §5.3) — so nothing about which room
 * it is in has to be invented.
 *
 * @module services/runtimes/test-mode/room-reply-scenarios
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { getRoomService } from '../../rooms/index.js';
import { roomsDomain } from '../../rooms/room-capabilities.js';
import { composeRegistry } from '../../core/capabilities/registry.js';
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
 * The room's own canvas, as this turn's context was handed it.
 *
 * @param opts - The message options the runtime was called with.
 * @returns The documents, or an empty list when the room has none.
 */
function canvasInContext(
  opts: Parameters<ScenarioFn>[2]
): NonNullable<RoomContextData['canvas']>['documents'] {
  const room = (opts?.additionalContext ?? []).find((entry) => entry.kind === 'room_context');
  return room?.kind === 'room_context' ? (room.data.canvas?.documents ?? []) : [];
}

/**
 * Read the first document on the room's canvas, then hold the turn open.
 *
 * **The only scenario that calls a capability itself, and the reason is the
 * property under test.** A face on a canvas tab is meant to appear only while
 * the dispatcher holds a claim for a turn that really read that document
 * (etiquette E16a), and the claim lives exactly as long as the turn — so a
 * driver reading from outside would be reading with no claim, which is the case
 * that must show NOTHING. The read has to happen from in here.
 *
 * It reads through the real registry with the turn's own author, resolved from
 * `MessageOpts.roomTurn.authorId` rather than guessed: an identity that named
 * the wrong agent would be refused by the membership check and the face would
 * simply never appear, so this fails closed and says so in its answer.
 *
 * @param finishRequested - Reads the store's finish flag.
 */
function roomReadsCanvas(finishRequested: FinishRequested): ScenarioFn {
  return async function* (_content, ctx, opts) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;

    const roomTurn = opts?.roomTurn;
    const first = canvasInContext(opts)[0];
    let read = 'NO-ROOM-TURN';
    if (roomTurn && first) {
      const rooms = getRoomService();
      const author = rooms.authorRegistry.getById(roomTurn.authorId);
      const registry = composeRegistry([roomsDomain], {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        roomDeps: { rooms },
      });
      try {
        await registry.invoke(
          'rooms.read_canvas',
          { roomId: roomTurn.roomId, documentId: first.id },
          {
            identity: {
              agentPath: author?.naturalKey ?? '',
              displayName: author?.displayName ?? '',
              tierCeiling: 'act',
              createdAt: new Date().toISOString(),
            },
          }
        );
        read = `READ-CANVAS: ${first.id}`;
      } catch (err) {
        read = `READ-CANVAS-FAILED: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // Said before the barrier: a scenario that parked in silence looks exactly
    // like a send that was dropped, and a test waiting on the face would have no
    // way to tell a failed read from a slow one.
    yield { type: 'text_delta', data: { text: read } } as StreamEvent;

    for (let tick = 0; tick < HOLD_TICKS && !finishRequested() && !ctx.signal.aborted; tick += 1) {
      await ctx.delay(HOLD_TICK_MS);
    }
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  };
}

/**
 * The file `rooms-open-diff` reviews.
 *
 * Named here rather than passed in, because a scenario takes no arguments: the
 * spec that drives it writes this same path into the agent's working copy first,
 * so the two have to agree on one string.
 */
export const ROOM_DIFF_PATH = 'src/app.txt';

/**
 * The scripted room turns that declare themselves tool-capable.
 *
 * @param finishRequested - Reads the store's finish flag.
 * @returns The scenarios, keyed by the names `POST /api/test/scenario` accepts.
 */
export function roomReplyScenarios(finishRequested: FinishRequested): Record<string, ScenarioFn> {
  return {
    // Puts one document on the room's shared canvas and says so, through the
    // same `ui_command` path a real runtime produces one on (spec
    // `room-canvas`). It needs no room id and no token: the room turn's own
    // collector applies every UNSTAMPED `ui_command` it sees, which is exactly
    // what makes a deterministic, credential-free end-to-end test of the canvas
    // possible at all.
    // Answers with what the ROOM told it is on the canvas — the one channel a
    // canvas change reaches another member by (spec `room-canvas` §6.1). It
    // reads the same `room_context` bag every runtime is handed, so "the next
    // turn is told" becomes something a browser or a curl can see rather than
    // something only a unit test can.
    'rooms-report-canvas': async function* (_content, _ctx, opts) {
      const room = (opts?.additionalContext ?? []).find((entry) => entry.kind === 'room_context');
      const titles =
        room?.kind === 'room_context'
          ? (room.data.canvas?.documents ?? []).map((document) => document.title)
          : [];
      yield {
        type: 'session_status',
        data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
      } as StreamEvent;
      yield {
        type: 'text_delta',
        data: {
          text:
            titles.length === 0
              ? 'CANVAS-IN-MY-CONTEXT: nothing'
              : `CANVAS-IN-MY-CONTEXT: ${titles.join(' | ')}`,
        },
      } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    },
    'rooms-open-canvas': async function* () {
      yield {
        type: 'session_status',
        data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
      } as StreamEvent;
      yield {
        type: 'ui_command',
        data: {
          command: {
            action: 'open_canvas',
            content: {
              type: 'markdown',
              title: 'The plan',
              content: '# The plan\n\nOne: measure. Two: decide.',
            },
          },
        },
      } as StreamEvent;
      yield { type: 'text_delta', data: { text: 'Put the plan on the canvas.' } } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    },
    // Opens a REVIEW of one of the room's files, from inside the turn — so the
    // document lands labelled with the tree that turn was standing in, which for
    // a project room is the agent's own working copy. It is the only way a
    // browser test can produce the one document a room's table treats as work
    // waiting for a decision (spec `canvas-agent-seat` §8).
    'rooms-open-diff': async function* () {
      yield {
        type: 'session_status',
        data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
      } as StreamEvent;
      yield {
        type: 'ui_command',
        data: { command: { action: 'open_diff', sourcePath: ROOM_DIFF_PATH } },
      } as StreamEvent;
      yield { type: 'text_delta', data: { text: 'Put the diff on the canvas.' } } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    },
    // Holds, then narrates. With the flip on, this text is the thing that must
    // NOT appear in the room; with it off, it is the answer.
    'rooms-hold-then-narrate': heldRoomTurn(
      'I looked at it and here is what I think.',
      finishRequested
    ),
    // Holds, then ends having produced nothing at all — the turn shape that is
    // silence in both modes, and the one `agent_declined` is measured on.
    'rooms-hold-then-quiet': heldRoomTurn(null, finishRequested),
    // Reads the canvas from inside a live turn and holds, so a browser can see
    // the face that read put on the tab while the claim is still held.
    'rooms-read-canvas': roomReadsCanvas(finishRequested),
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
