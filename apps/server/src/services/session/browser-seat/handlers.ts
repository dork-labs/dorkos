/**
 * The server half of one driving round trip: address a window, mint a request,
 * wait for exactly one answer, and turn it into something an agent can read.
 *
 * ## Addressing, and why it is decided here
 *
 * One session can be open in two windows at once, each with its own idea of
 * which preview is in front. Asking the client "are you the active one" gives
 * two windows the same answer, so a command with no `documentId` would be
 * performed twice or nondeterministically once. The arbiter has to live
 * somewhere there is exactly one of, and that is the driver table in
 * `DevtoolsCaptureStore`: this module reads the seat, stamps the request with
 * the winning `targetClientId` and `documentId`, and every bridge that is not
 * that client ignores it (spec `canvas-agent-seat` §2.2).
 *
 * ## Three answers, not one silence
 *
 * Nothing open, open but not instrumented, and asked-but-silent are three
 * different things for an agent to do next, and the first two are answered
 * before a request is minted — instantly, instead of waiting out a timeout
 * nothing was ever going to answer.
 *
 * @module services/session/browser-seat/handlers
 */
import { randomUUID } from 'node:crypto';
import type {
  BrowserActCommand,
  BrowserTarget,
  DevtoolsActionResult,
} from '@dorkos/shared/schemas';
import { DEVTOOLS_OUTLINE_MAX_CHARS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { WORKBENCH } from '../../../config/constants.js';
import type { DevtoolsCaptureStore } from '../devtools-capture-store.js';
import {
  drivingTimeoutNote,
  NOT_INSTRUMENTED_NOTE,
  NO_DRIVER_NOTE,
  NO_PREVIEW_NOTE,
  UNKNOWN_DOCUMENT_NOTE,
  type SessionEventSink,
} from './act-protocol.js';
import { resolveTargetInput, targetIsEmpty, type TargetInput } from './target.js';

/** Resolves the session whose windows a driving verb should reach, per call. */
export type BrowserSeatSessionResolver = () => string | undefined;

/** The subset of the capture store the driving verbs depend on. */
export type BrowserSeatStore = Pick<
  DevtoolsCaptureStore,
  | 'read'
  | 'hasDrivers'
  | 'resolveDriver'
  | 'awaitAction'
  | 'recordingFor'
  | 'noteRecordedFrame'
  | 'noteMissedFrame'
>;

/** What a driving verb hands back: a JSON payload, and whether it is an error. */
export interface DrivingAnswer {
  /** The structured body the tool serializes into its result. */
  payload: Record<string, unknown>;
  /** True when this should surface to the model as a tool error. */
  isError?: boolean;
  /**
   * A picture to return beside the body, as an MCP image block.
   *
   * Only `browser_record_stop` fills it, with the recording's LAST frame — not
   * the GIF, which no model can watch animate (spec `canvas-agent-seat` §3.4).
   */
  image?: { data: string; mimeType: string };
}

/** Error payload for a surface with no session — there is no window to reach. */
const SESSIONLESS_ANSWER: DrivingAnswer = {
  payload: {
    error: 'The browser verbs require an attached interactive session',
    detail:
      "They act inside the preview a live session has open in somebody's window. The current " +
      'MCP surface has no session attached, so there is no preview to reach.',
  },
  isError: true,
};

/** Fields a driving verb takes beyond its own arguments. */
export interface DocumentInput {
  documentId?: string;
}

/** `browser_click` arguments. */
export type ClickInput = TargetInput & DocumentInput;

/**
 * `browser_type` arguments.
 *
 * Deliberately NOT `TargetInput`: `text` here is what gets typed, so this verb
 * offers the role-and-name and selector routes only. See
 * {@link ./target.TARGET_INPUT_NO_TEXT}.
 */
export interface TypeInput extends DocumentInput {
  role?: string;
  name?: string;
  selector?: string;
  nth?: number;
  text: string;
  clear?: boolean;
  submit?: boolean;
}

/** `browser_press` arguments. */
export interface PressInput extends DocumentInput {
  key: string;
}

/** `browser_scroll` arguments. */
export interface ScrollInput extends TargetInput, DocumentInput {
  by?: number;
  to?: 'top' | 'bottom';
}

/** `browser_wait_for` arguments. */
export interface WaitForInput extends DocumentInput {
  text?: string;
  selector?: string;
  gone?: boolean;
  fetchIdle?: boolean;
  timeoutMs?: number;
}

/** `browser_read_page` arguments. */
export interface ReadPageInput extends DocumentInput {
  selector?: string;
}

/** Everything the six handlers need to reach a window. */
export interface BrowserSeatDeps {
  /** Read-time resolver for the session whose windows to address. */
  resolveSessionId: BrowserSeatSessionResolver;
  /** The capture store holding the driver table and the pending waiters. */
  store: BrowserSeatStore;
  /** The live session whose event queue reaches the addressed window. */
  session: SessionEventSink;
}

/**
 * Send one command to whichever window is holding the page, and answer.
 *
 * @param deps - Session resolver, capture store, and the event sink.
 * @param documentId - The page to act in, or `undefined` for the driver seat.
 * @param command - The command, already composed and bounded.
 * @param verb - The tool's own name, for the timeout sentence.
 * @param timeoutMs - How long to wait for the one answer.
 */
async function dispatch(
  deps: BrowserSeatDeps,
  documentId: string | undefined,
  command: BrowserActCommand,
  verb: string,
  timeoutMs: number
): Promise<DrivingAnswer> {
  const sessionId = deps.resolveSessionId();
  if (!sessionId) return SESSIONLESS_ANSWER;

  // Nothing has ever captured for this session: no preview was ever opened.
  if (!deps.store.read(sessionId)) return { payload: { ok: false, note: NO_PREVIEW_NOTE } };

  const claim = deps.store.resolveDriver(sessionId, documentId);
  if (!claim) {
    // A named page nobody holds, and "nothing open at all", are different
    // things to do next: list what is open, or open something.
    const note = deps.store.hasDrivers(sessionId) ? UNKNOWN_DOCUMENT_NOTE : NO_DRIVER_NOTE;
    return { payload: { ok: false, note } };
  }
  if (!claim.instrumented) {
    return { payload: { ok: false, documentId: claim.documentId, note: NOT_INSTRUMENTED_NOTE } };
  }

  // A recording running on THIS window and THIS page turns every action into a
  // frame as well (spec `canvas-agent-seat` §3.2). It rides the same round trip
  // rather than a second one, so there is one message, one result, one frame and
  // no second timeout. A recording that has hit its ceiling keeps driving and
  // stops filming — which is the whole reason `full` is a flag and not a stop.
  const recording = deps.store.recordingFor(sessionId);
  const onTheRecordedPage =
    recording !== undefined &&
    recording.documentId === claim.documentId &&
    recording.clientId === claim.clientId;
  const capture = onTheRecordedPage && !recording.full;
  // This action is going somewhere the recording cannot reach — a person
  // activated a preview in another window mid-run. It still happens, and it is
  // still missing from the film, so the stop answer has to say so rather than
  // hand back a gap it calls a record (spec §10).
  if (recording !== undefined && !onTheRecordedPage) deps.store.noteMissedFrame(sessionId);

  const requestId = randomUUID();
  deps.session.eventQueue.push({
    type: 'devtools_action_request',
    data: {
      requestId,
      targetClientId: claim.clientId,
      documentId: claim.documentId,
      command,
      ...(capture ? { capture: true } : {}),
    },
  } as StreamEvent);
  deps.session.eventQueueNotify?.();

  const result = await deps.store.awaitAction(requestId, timeoutMs);
  // Counted from what the WINDOW said came back, never from what was asked for:
  // a page whose CSP blocks the rasterizer answers the action and keeps no
  // frame, and counting the request would make the stop answer claim a picture
  // nobody has.
  if (capture && result?.captured === true) {
    deps.store.noteRecordedFrame(sessionId, WORKBENCH.MAX_RECORDING_FRAMES);
  }
  if (result === undefined) {
    return {
      payload: {
        ok: false,
        documentId: claim.documentId,
        note: drivingTimeoutNote(verb, timeoutMs),
      },
    };
  }
  return { payload: describeResult(result, claim.documentId) };
}

/**
 * Turn one shim result into the body a tool returns.
 *
 * `documentId` comes from the CLAIM, not from the result: the claim is what the
 * server addressed, so it is the fact worth reporting even if a page echoed
 * something else back. Every successful answer carries it and the page summary,
 * because an agent that drove one of three previews needs to know which.
 */
function describeResult(result: DevtoolsActionResult, documentId: string): Record<string, unknown> {
  if (!result.ok) {
    return {
      ok: false,
      documentId,
      ...(result.matched !== undefined ? { matched: result.matched } : {}),
      note: result.error ?? 'The page could not do that, and said nothing about why.',
      ...(result.page ? { page: result.page } : {}),
    };
  }
  return {
    ok: true,
    documentId,
    ...(result.did !== undefined ? { did: result.did } : {}),
    ...(result.matched !== undefined ? { matched: result.matched } : {}),
    ...(result.waitedMs !== undefined ? { waitedMs: result.waitedMs } : {}),
    ...(result.outline !== undefined ? { outline: result.outline } : {}),
    ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    ...(result.page ? { page: result.page } : {}),
  };
}

/** A refusal decided before anything was minted. */
function refusal(error: string): DrivingAnswer {
  return { payload: { ok: false, note: error } };
}

/**
 * Build the six driving handlers, bound to one session's windows.
 *
 * Every handler resolves its session on each call, never at build time: a
 * brand-new session is rekeyed to its canonical id mid-first-turn, and an id
 * captured earlier would address a window that no longer answers.
 *
 * @param deps - Session resolver, capture store, and the event sink.
 * @param timeoutMs - Round-trip timeout for the verbs that do not carry their
 *   own wait. Injectable so a test does not spend it.
 */
export function createBrowserSeatHandlers(
  deps: BrowserSeatDeps,
  timeoutMs: number = WORKBENCH.DEVTOOLS_ACT_TIMEOUT_MS
) {
  const withTarget = (
    input: TargetInput,
    required: boolean
  ): { ok: true; target: BrowserTarget } | { ok: false; answer: DrivingAnswer } => {
    const resolved = resolveTargetInput(input, required);
    if (!resolved.ok) return { ok: false, answer: refusal(resolved.error) };
    return { ok: true, target: resolved.target };
  };

  return {
    /** Click the one element a target names. */
    async click(input: ClickInput): Promise<DrivingAnswer> {
      const resolved = withTarget(input, true);
      if (!resolved.ok) return resolved.answer;
      return dispatch(
        deps,
        input.documentId,
        { action: 'click', target: resolved.target },
        'browser_click',
        timeoutMs
      );
    },

    /** Type into a named field, or into whatever has focus. */
    async type(input: TypeInput): Promise<DrivingAnswer> {
      // `input.text` is the text being typed, never a naming route, so the
      // target is assembled from the three routes this verb does offer.
      const resolved = withTarget(
        {
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.selector !== undefined ? { selector: input.selector } : {}),
          ...(input.nth !== undefined ? { nth: input.nth } : {}),
        },
        false
      );
      if (!resolved.ok) return resolved.answer;
      return dispatch(
        deps,
        input.documentId,
        {
          action: 'type',
          ...(targetIsEmpty(resolved.target) ? {} : { target: resolved.target }),
          text: input.text,
          ...(input.clear !== undefined ? { clear: input.clear } : {}),
          ...(input.submit !== undefined ? { submit: input.submit } : {}),
        },
        'browser_type',
        timeoutMs
      );
    },

    /** Press one key or chord at whatever has focus. */
    async press(input: PressInput): Promise<DrivingAnswer> {
      return dispatch(
        deps,
        input.documentId,
        { action: 'press', key: input.key },
        'browser_press',
        timeoutMs
      );
    },

    /** Scroll to an element, by an amount, or to one end of the page. */
    async scroll(input: ScrollInput): Promise<DrivingAnswer> {
      const resolved = withTarget(input, false);
      if (!resolved.ok) return resolved.answer;
      const named = !targetIsEmpty(resolved.target);
      if (!named && input.by === undefined && input.to === undefined) {
        return refusal(
          'Say where to scroll: name an element, pass by with a number of pixels, or pass to ' +
            'with "top" or "bottom".'
        );
      }
      return dispatch(
        deps,
        input.documentId,
        {
          action: 'scroll',
          ...(named ? { target: resolved.target } : {}),
          ...(input.by !== undefined ? { by: input.by } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
        },
        'browser_scroll',
        timeoutMs
      );
    },

    /** Wait, bounded, for text, an element, or the page to stop fetching. */
    async waitFor(input: WaitForInput): Promise<DrivingAnswer> {
      const modes = [
        input.text !== undefined,
        input.selector !== undefined,
        input.fetchIdle === true,
      ].filter(Boolean).length;
      if (modes !== 1) {
        return refusal(
          'Say what to wait for, one way: some text, a CSS selector, or fetchIdle for the page ' +
            'to stop fetching.'
        );
      }
      const waitMs = Math.min(
        input.timeoutMs ?? WORKBENCH.DEVTOOLS_WAIT_DEFAULT_MS,
        WORKBENCH.DEVTOOLS_WAIT_MAX_MS
      );
      return dispatch(
        deps,
        input.documentId,
        {
          action: 'wait_for',
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.selector !== undefined ? { selector: input.selector } : {}),
          ...(input.gone !== undefined ? { gone: input.gone } : {}),
          ...(input.fetchIdle !== undefined ? { fetchIdle: input.fetchIdle } : {}),
          timeoutMs: waitMs,
        },
        'browser_wait_for',
        // The page is busy for the whole wait it was asked for, so the server's
        // own timeout sits past it rather than reporting a failure mid-wait.
        waitMs + WORKBENCH.DEVTOOLS_ACT_ROUND_TRIP_GRACE_MS
      );
    },

    /** Read the page back as an accessibility outline. */
    async readPage(input: ReadPageInput): Promise<DrivingAnswer> {
      return dispatch(
        deps,
        input.documentId,
        {
          action: 'read_page',
          ...(input.selector !== undefined ? { selector: input.selector } : {}),
          maxChars: Math.min(WORKBENCH.DEVTOOLS_OUTLINE_BUDGET_CHARS, DEVTOOLS_OUTLINE_MAX_CHARS),
        },
        'browser_read_page',
        timeoutMs
      );
    },
  };
}

/** The six handlers, as the tool layer sees them. */
export type BrowserSeatHandlers = ReturnType<typeof createBrowserSeatHandlers>;
