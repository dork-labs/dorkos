/**
 * The `ui` capability domain — an agent's typed hand on the window it is
 * talking through (spec `canvas-agent-seat` §5, ADR `260912-025252`).
 *
 * | Capability                | Tool                   | Tier      | What it is |
 * | ------------------------- | ---------------------- | --------- | ---------- |
 * | `ui.control`              | `control_ui`           | `act`     | Drive the app: the canvas, panels, the browser tab. |
 * | `ui.state`                | `get_ui_state`         | `observe` | What is on the canvas and which panels are open. |
 * | `ui.read_canvas_document` | `read_canvas_document` | `observe` | Read one document off your own canvas. |
 * | `ui.read_console`         | `browser_read_console` | `observe` | What the preview logged. |
 * | `ui.read_network`         | `browser_read_network` | `observe` | What the preview fetched. |
 * | `ui.screenshot`           | `browser_screenshot`   | `act`     | A picture of the preview as it renders now. |
 * | `ui.click`                | `browser_click`        | `act`     | Click one thing on the preview page. |
 * | `ui.type`                 | `browser_type`         | `act`     | Type into a field on it. |
 * | `ui.press`                | `browser_press`        | `act`     | Press a key or a chord. |
 * | `ui.scroll`               | `browser_scroll`       | `act`     | Scroll it. |
 * | `ui.wait_for`             | `browser_wait_for`     | `observe` | Wait, bounded, for it to catch up. |
 * | `ui.read_page`            | `browser_read_page`    | `observe` | Read it back as an outline. |
 *
 * ## Why the domain exists
 *
 * Every one of these used to be hand-registered on claude-code's in-process MCP
 * server, which is why a Codex or OpenCode member of a room could not see a
 * console error and a Claude Code member could — a hidden pecking order in a
 * product whose headline is one place for every agent you run. Codex had one
 * stub copy of `control_ui` on a scoped server of its own, with no session in
 * scope and therefore no effect; OpenCode had nothing. As capabilities they are
 * declared once and served to all three runtimes: claude-code in process, Codex
 * and OpenCode through the loopback `dorkos` server.
 *
 * ## `servers: ['in-session']`, and what that keeps out
 *
 * Every capability here declares the in-session surface alone, so nothing it
 * adds reaches the external `/mcp` server and it contributes nothing to
 * `READ_ONLY_MCP_TOOL_NAMES` or `GUARDED_READ_ONLY_TOOL_NAMES`. A test asserts
 * that directly rather than leaving it to be inferred from which table has fewer
 * entries. The reason is not policy but arithmetic: a verb that acts inside
 * somebody's preview has to know whose window is holding it, and the external
 * surface is session-less by construction.
 *
 * ## Every handler keys on `context.sessionId`
 *
 * Which the handler context carries on the in-session surface and only there,
 * and which the loopback `dorkos` server takes from the verified principal
 * rather than from anything a caller supplies. A call with no session id is
 * refused in one sentence: these verbs read and drive what a live session's
 * window is showing, and a surface with no session has no window.
 *
 * **In `services/session/` rather than a `services/ui/` domain**, because that
 * is where the state these verbs read already lives — the devtools capture store
 * is a session service, and every `ui` verb is session-scoped by construction.
 * (The canvas itself is the opposite case and has its own domain: it serves two
 * scopes and belongs to neither.) In `browser-seat/` inside it because a file
 * added to `services/session/` itself would fail the pre-commit growth check in
 * `scripts/check-dir-size.sh`.
 *
 * @module server/services/session/browser-seat/ui-capabilities
 */
import { z } from 'zod';
import {
  CONTROL_UI_DESCRIPTION,
  CONTROL_UI_INPUT,
} from '../../runtimes/shared/ui-tool-contract.js';
import {
  defineCapability,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import { devtoolsCaptureStore } from '../devtools-capture-store.js';
import {
  READ_CONSOLE_DESCRIPTION,
  READ_CONSOLE_INPUT,
  READ_NETWORK_DESCRIPTION,
  READ_NETWORK_INPUT,
  SCREENSHOT_DESCRIPTION,
  readConsole,
  readNetwork,
  takeScreenshot,
  type ReadConsoleInput,
  type ReadNetworkInput,
} from './devtools-reads.js';
import {
  CLICK_DESCRIPTION,
  CLICK_INPUT,
  PRESS_DESCRIPTION,
  PRESS_INPUT,
  READ_PAGE_DESCRIPTION,
  READ_PAGE_INPUT,
  SCROLL_DESCRIPTION,
  SCROLL_INPUT,
  TYPE_DESCRIPTION,
  TYPE_INPUT,
  WAIT_FOR_DESCRIPTION,
  WAIT_FOR_INPUT,
} from './driving-contract.js';
import {
  createBrowserSeatHandlers,
  type BrowserSeatHandlers,
  type ClickInput,
  type DrivingAnswer,
  type PressInput,
  type ReadPageInput,
  type ScrollInput,
  type TypeInput,
  type WaitForInput,
} from './handlers.js';
import { readSessionCanvasDocument } from './read-canvas-document.js';
import { emitToSession } from './session-reach.js';
import { controlUi, getUiState, type UiCallerContext } from './ui-control.js';

/** What `get_ui_state` tells the model it does. */
const GET_UI_STATE_DESCRIPTION =
  'Get the current DorkOS UI state — what is on the canvas right now, which panels are open, the active agent, and (embedded app only) the sidebar tab. The canvas part is a LIVE read of the table: every document on it, what each one is, what it is called, whether you or the person put it there ("agent" or "owner"), which one is at the front of its view, and how many windows are open on this session (windows, not people — 0 means nobody is looking). Each document\'s id is what the canvas-reading tool takes to read that one back. The panels, sidebar and agent parts reflect the last state the client reported at the start of this turn, merged with the UI commands issued this turn, so they are intent rather than a live read; sidebar.activeTab is null in the web app, which has no sidebar tab strip.';

/**
 * Narrow a capability's handler context to the three facts a `ui` verb reads.
 *
 * `fromRuntimeSurface` is derived from the verified server principal and nothing
 * else: a `runtime` principal is minted only by the loopback listener, for one
 * turn, from a bearer the server itself issued — so no tool argument and no
 * header can claim or disclaim it.
 *
 * @param context - What the registry handed the handler.
 * @returns The caller, as the `ui` handlers see it.
 */
function callerOf(context: CapabilityHandlerContext): UiCallerContext {
  return {
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
    ...(context.serverPrincipal?.claims.kind === 'runtime' ? { fromRuntimeSurface: true } : {}),
  };
}

/**
 * Build the six driving handlers for one call, bound to the session that made
 * it.
 *
 * Per call rather than once: the session is a fact of the CALL, and a handler
 * set built at registration would address whichever session happened to be
 * first. The closures are cheap; the store and the stream are process-wide.
 *
 * @param sessionId - The calling session.
 * @returns The handlers, bound to that session's windows.
 */
function seatFor(sessionId: string): BrowserSeatHandlers {
  return createBrowserSeatHandlers({
    sessionId,
    store: devtoolsCaptureStore,
    emit: (event) => emitToSession(sessionId, event),
  });
}

/**
 * Run one driving verb for the calling session, or refuse a surface that has
 * none.
 *
 * @param context - What the registry handed the handler.
 * @param run - The verb, given a seat bound to the calling session.
 * @returns The verb's answer, as plain data.
 */
async function drive(
  context: CapabilityHandlerContext,
  run: (seat: BrowserSeatHandlers) => Promise<DrivingAnswer>
): Promise<Record<string, unknown>> {
  const sessionId = context.sessionId;
  if (sessionId === undefined) return SESSIONLESS_DRIVING_ANSWER;
  const answer = await run(seatFor(sessionId));
  return answer.payload;
}

/**
 * What a driving verb answers on a surface with no session.
 *
 * A note rather than a thrown refusal, matching every other "nothing to drive"
 * answer these verbs give: the agent is told what is missing and what to do, and
 * the turn carries on.
 */
const SESSIONLESS_DRIVING_ANSWER: Record<string, unknown> = {
  ok: false,
  note:
    'The browser verbs act inside the preview a live session has open in a window. The current ' +
    'surface has no session attached, so there is no preview to reach.',
};

/**
 * The `ui` domain: what an agent can see and do in the window it is answering
 * in.
 *
 * Unconditional, like `memory`: there is no service handle to switch off. The
 * canvas service and the room service are resolved per call — the rooms
 * subsystem registers them during boot, and a capability built before that would
 * otherwise capture nothing — and their absence degrades to a sentence rather
 * than a stack trace.
 */
export const uiDomain: CapabilityDomain = {
  name: 'ui',
  assertDeps: () => undefined,
  capabilities: [
    defineCapability({
      id: 'ui.control',
      title: 'Drive the DorkOS app',
      description: CONTROL_UI_DESCRIPTION,
      tier: 'act',
      input: z.object(CONTROL_UI_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'control_ui', servers: ['in-session'] } },
      invoke: (_deps, input, context) => controlUi(input, callerOf(context)),
    }),
    defineCapability({
      id: 'ui.state',
      title: "Read the app's state",
      description: GET_UI_STATE_DESCRIPTION,
      tier: 'observe',
      input: z.object({}),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'get_ui_state',
          servers: ['in-session'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: (_deps, _input, context) => getUiState(callerOf(context)),
    }),
    defineCapability({
      id: 'ui.read_canvas_document',
      title: 'Read a document on your canvas',
      description:
        'Read one document off the canvas of the window you are talking through — the chart you ' +
        'drew last turn, the file somebody opened, the page in the browser tab. ' +
        'It takes a document id, which the tool that reports the window’s state lists for every ' +
        'document that is open. ' +
        'A document backed by a file is read off DISK, so you get what the file holds NOW rather ' +
        'than what it held when the tab was opened. ' +
        'Reading the canvas notifies nobody and starts no turn.',
      tier: 'observe',
      input: z.object({
        documentId: z
          .string()
          .min(1)
          .describe(
            'A document id from get_ui_state. Reads what is on your own canvas — the one in the ' +
              'window you are talking through.'
          ),
      }),
      output: z.unknown(),
      surfaces: {
        mcp: {
          // **In-session only, and that is a security property rather than a
          // configuration.** There is no session argument to pass, so there is
          // no way to name a canvas that is not your own — and the external
          // `/mcp` surface, which carries no session at all, never sees the
          // verb.
          toolName: 'read_canvas_document',
          servers: ['in-session'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: (_deps, input, context) => readSessionCanvasDocument(input.documentId, context),
    }),
    defineCapability({
      id: 'ui.read_console',
      title: "Read the preview's console log",
      description: READ_CONSOLE_DESCRIPTION,
      tier: 'observe',
      input: z.object(READ_CONSOLE_INPUT),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'browser_read_console',
          servers: ['in-session'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: (_deps, input, context) =>
        readConsole(input as ReadConsoleInput, context.sessionId, devtoolsCaptureStore),
    }),
    defineCapability({
      id: 'ui.read_network',
      title: "Read the preview's network log",
      description: READ_NETWORK_DESCRIPTION,
      tier: 'observe',
      input: z.object(READ_NETWORK_INPUT),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'browser_read_network',
          servers: ['in-session'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: (_deps, input, context) =>
        readNetwork(input as ReadNetworkInput, context.sessionId, devtoolsCaptureStore),
    }),
    defineCapability({
      id: 'ui.screenshot',
      title: 'Take a screenshot of the preview',
      description: SCREENSHOT_DESCRIPTION,
      tier: 'act',
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'browser_screenshot', servers: ['in-session'] } },
      invoke: (_deps, _input, context) => takeScreenshot(context.sessionId, devtoolsCaptureStore),
    }),
    defineCapability({
      id: 'ui.click',
      title: 'Click something in the preview',
      description: CLICK_DESCRIPTION,
      tier: 'act',
      input: z.object(CLICK_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'browser_click', servers: ['in-session'] } },
      invoke: (_deps, input, context) => drive(context, (seat) => seat.click(input as ClickInput)),
    }),
    defineCapability({
      id: 'ui.type',
      title: 'Type into the preview',
      description: TYPE_DESCRIPTION,
      tier: 'act',
      input: z.object(TYPE_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'browser_type', servers: ['in-session'] } },
      invoke: (_deps, input, context) => drive(context, (seat) => seat.type(input as TypeInput)),
    }),
    defineCapability({
      id: 'ui.press',
      title: 'Press a key in the preview',
      description: PRESS_DESCRIPTION,
      tier: 'act',
      input: z.object(PRESS_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'browser_press', servers: ['in-session'] } },
      invoke: (_deps, input, context) => drive(context, (seat) => seat.press(input as PressInput)),
    }),
    defineCapability({
      id: 'ui.scroll',
      title: 'Scroll the preview',
      description: SCROLL_DESCRIPTION,
      tier: 'act',
      input: z.object(SCROLL_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'browser_scroll', servers: ['in-session'] } },
      invoke: (_deps, input, context) =>
        drive(context, (seat) => seat.scroll(input as ScrollInput)),
    }),
    defineCapability({
      id: 'ui.wait_for',
      title: 'Wait for the preview to catch up',
      description: WAIT_FOR_DESCRIPTION,
      tier: 'observe',
      input: z.object(WAIT_FOR_INPUT),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'browser_wait_for', servers: ['in-session'] } },
      invoke: (_deps, input, context) =>
        drive(context, (seat) => seat.waitFor(input as WaitForInput)),
    }),
    defineCapability({
      id: 'ui.read_page',
      title: "Read the preview's page outline",
      description: READ_PAGE_DESCRIPTION,
      tier: 'observe',
      input: z.object(READ_PAGE_INPUT),
      output: z.unknown(),
      surfaces: {
        mcp: {
          toolName: 'browser_read_page',
          servers: ['in-session'],
          annotations: { idempotentHint: true },
        },
      },
      invoke: (_deps, input, context) =>
        drive(context, (seat) => seat.readPage(input as ReadPageInput)),
    }),
  ],
};
