/**
 * The scripted room turns, and the one helper that lets any scripted turn speak
 * in a room (spec `tool-only-room-replies` §D14, §A2).
 *
 * ## A scripted turn speaks by calling the tool, because every turn does
 *
 * A room turn's own words are never posted for it, so a scenario that only
 * narrates answers nothing at all. That is no longer a mode to opt into: since
 * DOR-2099 it is the only behaviour, {@link TestModeRuntime.carriesRoomTools}
 * answers `true` for every session, and a scenario that means to say something
 * in a room says it through {@link sayInRoom} — the real `rooms.post`
 * capability, invoked in-process with the turn's own agent identity, exactly
 * where an injected `dorkos` MCP server's call would land.
 *
 * It can, because a room turn is handed `MessageOpts.roomTurn` — the room, the
 * member and the turn id, all server-derived (spec `room-canvas` §5.3) — so
 * nothing about which room it is in has to be invented. A turn with no
 * `roomTurn` is not in a room, and {@link sayInRoom} is a no-op there, which is
 * what keeps a scenario usable on an ordinary session.
 *
 * ## The two scenarios that deliberately do NOT post
 *
 * {@link roomReplyScenarios}'s `rooms-hold-then-narrate` writes a line and calls
 * nothing, which is the shape a person's agent takes when it forms an answer and
 * fails to send it: the room must show no message and one `agent_declined`
 * notice. `rooms-hold-then-quiet` produces nothing at all. Both hold the turn
 * open until `POST /api/test/finish-turn` so a driver can look at the room while
 * the claim is still held.
 *
 * @module services/runtimes/test-mode/room-reply-scenarios
 */
import fs from 'node:fs/promises';
import path from 'node:path';
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
    // Emitted at the END rather than at the start, and the ordering is what the
    // behaviour is measured against: this text must never reach the room, and a
    // turn that narrated before a driver had looked would leave "not posted" and
    // "not posted yet" indistinguishable in a transcript.
    if (say !== null) {
      yield { type: 'text_delta', data: { text: say } } as StreamEvent;
    }
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  };
}

/**
 * Say something in the room this turn was triggered from, through the real
 * posting capability.
 *
 * **This is the whole of how a scripted turn speaks.** It invokes
 * `rooms.post` — the same capability `post_to_room` is the MCP name of — with
 * the turn's own agent identity, resolved from `MessageOpts.roomTurn.authorId`
 * rather than guessed: an identity naming the wrong agent would be refused by
 * the membership check and the message would simply never appear, so this fails
 * closed and says so in what it returns.
 *
 * Every bound the product applies applies here: the per-turn post ceiling, the
 * stopped-turn refusal, the cascade stamp the live claim carries, and the
 * `answersEntryId`/`sessionId` pointers the claim fills in. That is the point of
 * calling the real thing.
 *
 * @param opts - The message options the runtime was called with.
 * @param text - What to say.
 * @param attachments - Files to show with it, by path, relative to the turn's
 *   own working directory.
 * @returns `true` when the message was posted; `false` when this turn is not in
 *   a room at all; the refusal's message when the room refused it.
 */
export async function sayInRoom(
  opts: Parameters<ScenarioFn>[2],
  text: string,
  attachments?: readonly string[]
): Promise<true | false | string> {
  const roomTurn = opts?.roomTurn;
  if (!roomTurn) return false;
  const rooms = getRoomService();
  const author = rooms.authorRegistry.getById(roomTurn.authorId);
  const registry = composeRegistry([roomsDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms },
  });
  try {
    await registry.invoke(
      'rooms.post',
      { roomId: roomTurn.roomId, text, ...(attachments ? { attachments } : {}) },
      {
        identity: {
          agentPath: author?.naturalKey ?? '',
          displayName: author?.displayName ?? '',
          tierCeiling: 'act',
          createdAt: new Date().toISOString(),
        },
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      }
    );
    return true;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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
    // way to tell a failed read from a slow one. Posted as well as narrated,
    // because the narration reaches nobody in the room.
    await sayInRoom(opts, read);
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
export const ROOM_DIFF_PATH = 'app.txt';

/**
 * A small striped PNG, written into the turn's own working directory.
 *
 * Real bytes rather than a placeholder because the whole path decides what a
 * file IS by sniffing it: a fake would store as an opaque stream and render as
 * a chip rather than as a picture, so the case would pass while proving the
 * opposite of what it claims. Big enough to SEE, so a browser proof of the
 * inline preview is a picture of something rather than of one pixel.
 */
const STRIPED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAAB0UlEQVR4nO3bsQnAMBAEwa/A/Tfg4hwqcOBMTRgEy8AU' +
    'cMGmN9f9QMYcXwA/EjQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZl1vtBhqBJETQp' +
    'giZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgibFSZYUQZMiaFIETYqgSRE0KYImRdCkCJoU' +
    'QZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqTLCmCJkXQpAiaFEGTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSBE2K' +
    'oEkRNCmCJkXQpAiaFCdZUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpTrKk' +
    'CJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFKcZEkRNCmCJkXQpAiaFEGTImhS' +
    'BE2KoEkRNCmCJkXQpAiaFEGTImhSBE2KoEkRNCmCJkXQpDjJkiJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQp' +
    'giZF0KQImhRBkyJoUgRNiqBJ2cNvHLHPIfVCAAAAAElFTkSuQmCC',
  'base64'
);

/**
 * Write a file into this turn's working directory and post it to the room.
 *
 * The one scenario that attaches, and it calls the capability itself for the
 * same reason `roomReadsCanvas` does: what it proves is that an agent can show
 * a file it MADE, so the file has to be made inside the turn, in the directory
 * that turn runs in. A driver doing it from outside would be attaching
 * somebody else's file, which is the case the feature refuses.
 *
 * @param finishRequested - Reads the store's finish flag.
 */
function roomPostsAttachment(finishRequested: FinishRequested): ScenarioFn {
  return async function* (_content, ctx, opts) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;

    const cwd = opts?.cwd;
    let said = 'NO-ROOM-TURN';
    if (opts?.roomTurn && cwd) {
      await fs.writeFile(path.join(cwd, 'shot.png'), STRIPED_PNG);
      const posted = await sayInRoom(opts, 'Here is what I saw.', ['shot.png']);
      said = posted === true ? 'POSTED-ATTACHMENT' : `POST-ATTACHMENT-FAILED: ${posted}`;
    }
    yield { type: 'text_delta', data: { text: said } } as StreamEvent;

    for (let tick = 0; tick < HOLD_TICKS && !finishRequested() && !ctx.signal.aborted; tick += 1) {
      await ctx.delay(HOLD_TICK_MS);
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
      const said =
        titles.length === 0
          ? 'CANVAS-IN-MY-CONTEXT: nothing'
          : `CANVAS-IN-MY-CONTEXT: ${titles.join(' | ')}`;
      await sayInRoom(opts, said);
      yield { type: 'text_delta', data: { text: said } } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    },
    'rooms-open-canvas': async function* (_content, _ctx, opts) {
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
      await sayInRoom(opts, 'Put the plan on the canvas.');
      yield { type: 'text_delta', data: { text: 'Put the plan on the canvas.' } } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    },
    // Opens a REVIEW of one of the room's files, from inside the turn — so the
    // document lands labelled with the tree that turn was standing in, which for
    // a project room is the agent's own working copy. It is the only way a
    // browser test can produce the one document a room's table treats as work
    // waiting for a decision (spec `canvas-agent-seat` §8).
    'rooms-open-diff': async function* (_content, _ctx, opts) {
      yield {
        type: 'session_status',
        data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
      } as StreamEvent;
      yield {
        type: 'ui_command',
        data: { command: { action: 'open_diff', sourcePath: ROOM_DIFF_PATH } },
      } as StreamEvent;
      await sayInRoom(opts, 'Put the diff on the canvas.');
      yield { type: 'text_delta', data: { text: 'Put the diff on the canvas.' } } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    },
    // Holds, then narrates and calls nothing. This text is the thing that must
    // NOT appear in the room: it is an agent that formed an answer and never
    // sent it, which is a silent turn and earns the `agent_declined` notice.
    'rooms-hold-then-narrate': heldRoomTurn(
      'I looked at it and here is what I think.',
      finishRequested
    ),
    // Holds, then ends having produced nothing at all — silence with nothing
    // even written down.
    'rooms-hold-then-quiet': heldRoomTurn(null, finishRequested),
    // Reads the canvas from inside a live turn and holds, so a browser can see
    // the face that read put on the tab while the claim is still held.
    'rooms-read-canvas': roomReadsCanvas(finishRequested),
    // Makes a file in its own working directory and posts it to the room, so a
    // browser can see the chip and a second agent's copy can be looked for on
    // disk (spec `canvas-agent-seat` §4).
    'rooms-post-attachment': roomPostsAttachment(finishRequested),
  };
}
