/**
 * Recording a run in the preview as an animated GIF (spec `canvas-agent-seat`
 * §3) — the server half of a state machine whose frames live somewhere else.
 *
 * ## Why the server holds no pictures
 *
 * The frames are produced in the page and kept in the window that is showing
 * it. Shipping sixty base64 PNGs up the wire so the server could decode them
 * again and re-encode them would be the same work done twice, in the process
 * that has the least reason to do it — so the window encodes, and the server
 * keeps only the state machine: which page is being filmed, by which window,
 * how many frames have come back, and whether the ceiling is reached.
 *
 * ## What is left when something goes wrong
 *
 * Nothing. A recording nobody stops costs a bounded buffer in one browser tab
 * and is dropped when that tab lets the page go or the session's capture buffer
 * is evicted. A stop the window never answers fails plainly at
 * `RECORDING_STOP_TIMEOUT_MS`, claims no file, and leaves no state behind for
 * the next `browser_record_start` to trip over.
 *
 * @module services/session/browser-seat/recording
 */
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulidx';
import { WORKBENCH } from '../../../config/constants.js';
import type { DevtoolsCaptureStore } from '../devtools-capture-store.js';
import type { RawSessionEvent } from '../session-state-projector.js';
import {
  NOT_INSTRUMENTED_NOTE,
  NO_DRIVER_NOTE,
  NO_PREVIEW_NOTE,
  UNKNOWN_DOCUMENT_NOTE,
  type SessionEventEmitter,
} from './act-protocol.js';
import type { DocumentInput, DrivingAnswer } from './handlers.js';

/** A second `browser_record_start` while one is running. */
export const RECORDING_ALREADY_RUNNING_NOTE =
  'A recording is already running. Stop it first with browser_record_stop, then start a new one.';

/** `browser_record_stop` with nothing being recorded. */
export const NOTHING_RECORDING_NOTE =
  'Nothing is being recorded right now. Start one with browser_record_start, do the steps you ' +
  'want to show, then stop it.';

/** The window never came back with a file. Names the wait, claims nothing. */
export const RECORDING_STOP_TIMEOUT_NOTE =
  `The window showing the page did not finish the recording within ` +
  `${Math.round(WORKBENCH.RECORDING_STOP_TIMEOUT_MS / 1000)}s, so no file was written. It may ` +
  'have been closed or reloaded while the recording was running. Start a new recording and ' +
  'keep the window open.';

/** What the stop answer says about the file, for the agent to act on. */
const RECORDING_NOTE =
  'The last frame is attached. Open the file to watch the whole thing, or post it to a room ' +
  'with post_to_room.';

/** What the stop answer adds when the frame ceiling was reached mid-run. */
const RECORDING_FULL_NOTE =
  `The recording filled up at ${WORKBENCH.MAX_RECORDING_FRAMES} frames, so anything you did ` +
  'after that is not in it. Everything you did still happened.';

/**
 * What the stop answer adds when some of the run happened out of shot.
 *
 * A recording's frames live in the ONE window that started it, so an action the
 * server sent to a different window — somebody brought another preview to the
 * front mid-run — really ran and really is missing. Said in the same shape the
 * ceiling is said in, because it is the same kind of fact: the work happened,
 * the film is short of it.
 *
 * @param missed - How many actions ran somewhere this recording could not film.
 */
function recordingMissedNote(missed: number): string {
  const actions = missed === 1 ? '1 action you took' : `${missed} actions you took`;
  const missing = missed === 1 ? 'it is' : 'they are';
  return (
    `${actions} happened in another window while this was recording, so ${missing} not in the ` +
    'file. Everything you did still happened. Keep one window in front to film a whole run.'
  );
}

/** The subset of the capture store the two recording verbs depend on. */
export type RecordingStore = Pick<
  DevtoolsCaptureStore,
  | 'read'
  | 'hasDrivers'
  | 'resolveDriver'
  | 'startRecording'
  | 'recordingFor'
  | 'endRecording'
  | 'awaitRecording'
>;

/** Everything the two recording handlers need. */
export interface RecordingDeps {
  /** The session whose window is filming, resolved by the caller for this call. */
  sessionId: string;
  /**
   * That session's working directory — where the file lands. A recording with
   * nowhere to land is refused before it starts, rather than filmed and then
   * dropped.
   */
  cwd?: string;
  /** The capture store holding the driver table and the recording state. */
  store: RecordingStore;
  /** Puts one event on the calling session's stream, for its windows to read. */
  emit: SessionEventEmitter;
}

/** No working directory means nowhere to write the file. Said before filming. */
const NO_CWD_NOTE =
  'This session has no working directory, so there is nowhere to save a recording.';

/**
 * Build the two recording handlers, bound to one session's windows.
 *
 * Built PER CALL rather than per session, for the reason the driving handlers
 * are: which session is calling is a fact of the call, resolved from the
 * verified capability context, and an id captured earlier would address a
 * window that no longer answers.
 *
 * @param deps - The calling session, its directory, the capture store, and the
 *   event emitter.
 * @param stopTimeoutMs - How long a stop waits for the encode and upload.
 *   Injectable so a test does not spend thirty seconds proving the timeout.
 */
export function createRecordingHandlers(
  deps: RecordingDeps,
  stopTimeoutMs: number = WORKBENCH.RECORDING_STOP_TIMEOUT_MS
) {
  return {
    /** Start filming the page a window is holding. One per session. */
    async start(input: DocumentInput): Promise<DrivingAnswer> {
      const sessionId = deps.sessionId;
      if (!deps.cwd) return { payload: { ok: false, note: NO_CWD_NOTE } };

      // Refused before anything is addressed, so a second start never sends a
      // window a request that would reset the buffer it is already filling.
      if (deps.store.recordingFor(sessionId)) {
        return { payload: { ok: false, note: RECORDING_ALREADY_RUNNING_NOTE } };
      }

      if (!deps.store.read(sessionId)) return { payload: { ok: false, note: NO_PREVIEW_NOTE } };
      const claim = deps.store.resolveDriver(sessionId, input.documentId);
      if (!claim) {
        const note = deps.store.hasDrivers(sessionId) ? UNKNOWN_DOCUMENT_NOTE : NO_DRIVER_NOTE;
        return { payload: { ok: false, note } };
      }
      if (!claim.instrumented) {
        return {
          payload: { ok: false, documentId: claim.documentId, note: NOT_INSTRUMENTED_NOTE },
        };
      }

      const recordingId = ulid();
      const started = deps.store.startRecording(sessionId, {
        id: recordingId,
        documentId: claim.documentId,
        clientId: claim.clientId,
      });
      // Lost a race with another call between the check above and here. Says
      // the same sentence: one recording per session is the rule either way.
      if (!started) return { payload: { ok: false, note: RECORDING_ALREADY_RUNNING_NOTE } };

      push(deps, 'start', randomUUID(), recordingId, claim.clientId, claim.documentId);
      return {
        payload: {
          ok: true,
          documentId: claim.documentId,
          recordingId,
          did: 'Started recording. Every browser action from here takes a frame.',
          note:
            `It keeps at most ${WORKBENCH.MAX_RECORDING_FRAMES} frames. Call ` +
            'browser_record_stop when you are done, and you get the file and its last frame.',
        },
      };
    },

    /** Stop filming, wait for the file, and answer with where it landed. */
    async stop(): Promise<DrivingAnswer> {
      const sessionId = deps.sessionId;
      // Ended FIRST, before anything else can refuse. A stop that returns
      // without clearing the state leaves a recording nothing can ever finish:
      // every later start is refused "already running" and every later stop
      // refuses again. Nothing about this phase is allowed to leave dangling
      // state, and this is the one path that could.
      const recording = deps.store.endRecording(sessionId);
      if (!recording) return { payload: { ok: false, note: NOTHING_RECORDING_NOTE } };

      const cwd = deps.cwd;
      if (!cwd) return { payload: { ok: false, note: NO_CWD_NOTE } };

      const requestId = randomUUID();
      // Registered BEFORE the request goes out, so the upload route can never
      // arrive at a destination nobody has decided yet — and so the destination
      // is one the server chose rather than one the wire named.
      const waiter = deps.store.awaitRecording(
        requestId,
        { recordingId: recording.id, cwd, full: recording.full },
        stopTimeoutMs
      );
      push(deps, 'stop', requestId, recording.id, recording.clientId, recording.documentId);

      const outcome = await waiter;
      if (outcome === undefined) {
        return {
          payload: {
            ok: false,
            documentId: recording.documentId,
            note: RECORDING_STOP_TIMEOUT_NOTE,
          },
        };
      }
      if (!outcome.ok) {
        return { payload: { ok: false, documentId: recording.documentId, note: outcome.error } };
      }

      // Every true thing about the film, in the order it matters: what is
      // missing first, then where to find what is there.
      const caveats = [
        ...(recording.full ? [RECORDING_FULL_NOTE] : []),
        ...(recording.missed > 0 ? [recordingMissedNote(recording.missed)] : []),
      ];
      const body = {
        ok: true,
        documentId: recording.documentId,
        path: outcome.path,
        frames: outcome.frames,
        bytes: outcome.bytes,
        seconds: Math.max(1, Math.round(outcome.durationMs / 1000)),
        ...(recording.missed > 0 ? { missed: recording.missed } : {}),
        note: [...caveats, RECORDING_NOTE].join(' '),
      };
      // The GIF itself is never a tool result. Megabytes of base64 that no model
      // can watch animate buys nothing; the LAST frame is the state the page
      // ended in, which is the frame an agent actually reasons about, and the
      // path is what makes the recording useful to a person.
      return { payload: body, ...(outcome.keyframe ? { image: outcome.keyframe } : {}) };
    },
  };
}

/**
 * Address one window with one recording request.
 *
 * @param deps - The emitter that reaches the calling session's windows.
 * @param action - Start filming, or stop and hand the file back.
 * @param requestId - The round trip id a stop is answered under.
 * @param recordingId - The recording this is about.
 * @param targetClientId - The window holding the page.
 * @param documentId - The page.
 */
function push(
  deps: RecordingDeps,
  action: 'start' | 'stop',
  requestId: string,
  recordingId: string,
  targetClientId: string,
  documentId: string
): void {
  deps.emit({
    type: 'devtools_recording_request',
    requestId,
    targetClientId,
    documentId,
    action,
    recordingId,
    bounds: {
      longEdgePx: WORKBENCH.RECORDING_LONG_EDGE_PX,
      frameMs: WORKBENCH.RECORDING_FRAME_MS,
      maxBytes: WORKBENCH.MAX_RECORDING_BYTES,
    },
  } as RawSessionEvent);
}

/** The two handlers, as the tool layer sees them. */
export type RecordingHandlers = ReturnType<typeof createRecordingHandlers>;
