/**
 * The six verbs that let an agent use the preview it already opened, instead of
 * only looking at it (spec `canvas-agent-seat` §2, ADR `260912-025251`).
 *
 * `browser_read_console`, `browser_read_network` and `browser_screenshot`
 * ({@link ./devtools-tools}) gave an agent eyes on the page. These give it
 * hands: click, type, press, scroll, wait for, and read the page back as an
 * accessibility outline. Together they close the loop "check the signup flow"
 * has always needed — the agent tries the form, watches what happens, and says
 * what it saw, without a person relaying it.
 *
 * Everything happens in the person's own browser, in the sandboxed preview frame
 * DorkOS serves, with their own page state. Nothing runs a second browser
 * anywhere: the shim that is already in the page does the work, and the server's
 * only job is to address exactly one window and wait for exactly one answer.
 * {@link ../../../session/browser-seat} owns that half.
 *
 * These are registered ONLY on the in-process claude-code tool server, for the
 * reason the DevTools reads are: a session-less external surface cannot know
 * whose preview to reach, and a verb that acts has to know. Codex and OpenCode
 * parity is the `ui` capability domain, a tracked follow-up.
 *
 * @module services/runtimes/claude-code/mcp-tools/browser-driving-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createBrowserSeatHandlers,
  devtoolsCaptureStore,
  DOCUMENT_INPUT,
  DRIVING_SAFETY_SENTENCE,
  TARGET_INPUT,
  TARGET_INPUT_NO_TEXT,
  type BrowserSeatStore,
  type ClickInput,
  type DrivingAnswer,
  type PressInput,
  type ReadPageInput,
  type ScrollInput,
  type SessionEventSink,
  type TypeInput,
  type WaitForInput,
} from '../../../session/index.js';
import { WORKBENCH } from '../../../../config/constants.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Resolves the session whose preview these verbs reach, on every call. */
export type BrowserDrivingSessionResolver = () => string | undefined;

/** Input shape for `browser_click`. */
const CLICK_INPUT = { ...DOCUMENT_INPUT, ...TARGET_INPUT };

/** Input shape for `browser_type`. */
const TYPE_INPUT = {
  ...DOCUMENT_INPUT,
  // No visible-text route here: `text` below is what gets typed.
  ...TARGET_INPUT_NO_TEXT,
  text: z.string().max(10_000).describe('The text to put in the field.'),
  clear: z
    .boolean()
    .optional()
    .describe('Replace what is already in the field instead of adding to the end of it.'),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter afterwards, which submits the form the field is in.'),
};

/** Input shape for `browser_press`. */
const PRESS_INPUT = {
  ...DOCUMENT_INPUT,
  key: z
    .string()
    .max(64)
    .describe(
      'One key or a chord, written the way a browser names it: "Enter", "Escape", "Control+a".'
    ),
};

/** Input shape for `browser_scroll`. */
const SCROLL_INPUT = {
  ...DOCUMENT_INPUT,
  ...TARGET_INPUT,
  by: z
    .number()
    .optional()
    .describe('How many pixels to scroll. Positive is down, negative is up.'),
  to: z.enum(['top', 'bottom']).optional().describe('Jump to the top or the bottom of the page.'),
};

/** Input shape for `browser_wait_for`. */
const WAIT_FOR_INPUT = {
  ...DOCUMENT_INPUT,
  text: z.string().max(512).optional().describe('Wait until this text is visible on the page.'),
  selector: z
    .string()
    .max(512)
    .optional()
    .describe('Wait until an element matching this CSS selector is on the page.'),
  gone: z
    .boolean()
    .optional()
    .describe('Wait for the text or the element to DISAPPEAR instead of appear.'),
  fetchIdle: z
    .boolean()
    .optional()
    .describe(
      'Wait until the page has made no fetch or XMLHttpRequest call for half a second. It does ' +
        'not cover images, stylesheets, WebSockets or service workers — wait for the element ' +
        'those produce instead.'
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(WORKBENCH.DEVTOOLS_WAIT_MAX_MS)
    .optional()
    .describe(
      `How long to wait, in milliseconds (default ${WORKBENCH.DEVTOOLS_WAIT_DEFAULT_MS}, ` +
        `max ${WORKBENCH.DEVTOOLS_WAIT_MAX_MS}). Waiting longer than that is not a thing to do ` +
        'in one call.'
    ),
};

/** Input shape for `browser_read_page`. */
const READ_PAGE_INPUT = {
  ...DOCUMENT_INPUT,
  selector: z
    .string()
    .max(512)
    .optional()
    .describe('Read only the part of the page inside this CSS selector, rather than all of it.'),
};

const CLICK_DESCRIPTION =
  'Click one thing on the preview page your session already has open. Name it the way the ' +
  'page-outline read printed it — a role and an accessible name; its name ends in `read_page` ' +
  '— or by its visible text, or as a last resort with a CSS selector. It tells you what it ' +
  'clicked, which tab it clicked it in, and where that page is now. If several things match it ' +
  'refuses instead of guessing, and says how to pick one. ' +
  DRIVING_SAFETY_SENTENCE;

const TYPE_DESCRIPTION =
  'Type into a field on the preview page. Name the field by its role and name the way the ' +
  'page-outline read printed it, or with a CSS selector, or leave both out to type into ' +
  'whatever has focus — `text` here is what gets typed, so there is no name-it-by-its-text ' +
  'route on this one. `clear` replaces what is there; `submit` presses Enter afterwards, which ' +
  'submits the form. ' +
  DRIVING_SAFETY_SENTENCE;

const PRESS_DESCRIPTION =
  'Press one key, or a chord, on the preview page — "Enter", "Escape", "Control+a". It goes to ' +
  'whatever has focus, so click or type into something first if you mean it for a field. ' +
  DRIVING_SAFETY_SENTENCE;

const SCROLL_DESCRIPTION =
  'Scroll the preview page: to an element you name, by a number of pixels, or to the top or ' +
  'bottom. Use it when something you need is below the fold. ' +
  DRIVING_SAFETY_SENTENCE;

const WAIT_FOR_DESCRIPTION =
  'Wait for the preview page to catch up — until some text appears, until an element appears, ' +
  'or until the page stops fetching. Use it after a click that starts something, before you ' +
  'read the result. Every wait is bounded and a wait that never happens comes back as a plain ' +
  'failure, never a hang.';

const READ_PAGE_DESCRIPTION =
  'Read the preview page back as an outline of what is on it: one line per thing, with its ' +
  'role, its name and whether it is disabled, required or checked. Call it before clicking or ' +
  'typing, and the names it prints are the names those tools take. The names are worked out ' +
  'cheaply rather than exactly, so if you cannot find something by name, reach for a CSS ' +
  'selector instead of concluding it is not there. Long pages are cut from the deepest level ' +
  'first and say so.';

/**
 * The subset of the live session these verbs need: the event queue that reaches
 * the window holding the preview.
 */
export type BrowserDrivingSession = SessionEventSink;

/** Answer given on a surface with no session — the same shape as a refusal. */
const SESSIONLESS_ANSWER: DrivingAnswer = {
  payload: {
    error: 'The browser verbs require an attached interactive session',
    detail:
      'They act inside the preview a live session has open in a window. The current MCP ' +
      'surface has no session attached, so there is no preview to reach.',
  },
  isError: true,
};

/**
 * Returns the six browser-driving tool definitions for the claude-code
 * in-process MCP server.
 *
 * Without a session resolver or a live session — an external MCP surface with no
 * interactive client — every verb answers with an error rather than pretending
 * to succeed, exactly as the DevTools reads do. A verb that acts must never
 * report success for something it could not have done.
 *
 * @param _deps - Shared tool dependencies (unused by these verbs).
 * @param resolveSessionId - Read-time resolver for the bound session's id.
 * @param store - The capture store holding the driver table (injectable for tests).
 * @param session - The live session whose event queue reaches the addressed window.
 */
export function getBrowserDrivingTools(
  _deps: McpToolDeps,
  resolveSessionId?: BrowserDrivingSessionResolver,
  store: BrowserSeatStore = devtoolsCaptureStore,
  session?: BrowserDrivingSession
) {
  const handlers =
    resolveSessionId && session
      ? createBrowserSeatHandlers({ resolveSessionId, store, session })
      : null;

  const answer = (result: DrivingAnswer) => jsonContent(result.payload, result.isError);
  const sessionless = () => jsonContent(SESSIONLESS_ANSWER.payload, true);

  return [
    tool('browser_click', CLICK_DESCRIPTION, CLICK_INPUT, async (input) =>
      handlers ? answer(await handlers.click(input as ClickInput)) : sessionless()
    ),
    tool('browser_type', TYPE_DESCRIPTION, TYPE_INPUT, async (input) =>
      handlers ? answer(await handlers.type(input as TypeInput)) : sessionless()
    ),
    tool('browser_press', PRESS_DESCRIPTION, PRESS_INPUT, async (input) =>
      handlers ? answer(await handlers.press(input as PressInput)) : sessionless()
    ),
    tool('browser_scroll', SCROLL_DESCRIPTION, SCROLL_INPUT, async (input) =>
      handlers ? answer(await handlers.scroll(input as ScrollInput)) : sessionless()
    ),
    tool('browser_wait_for', WAIT_FOR_DESCRIPTION, WAIT_FOR_INPUT, async (input) =>
      handlers ? answer(await handlers.waitFor(input as WaitForInput)) : sessionless()
    ),
    tool('browser_read_page', READ_PAGE_DESCRIPTION, READ_PAGE_INPUT, async (input) =>
      handlers ? answer(await handlers.readPage(input as ReadPageInput)) : sessionless()
    ),
  ];
}
