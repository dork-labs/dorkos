/**
 * What the six driving verbs take, and what they tell the model they do (spec
 * `canvas-agent-seat` §2, ADR `260912-025251`).
 *
 * The reads gave an agent eyes on the page; these give it hands: click, type,
 * press, scroll, wait for, and read the page back as an accessibility outline.
 * Together they close the loop "check the signup flow" has always needed — the
 * agent tries the form, watches what happens, and says what it saw, without a
 * person relaying it.
 *
 * Everything happens in the person's own browser, in the sandboxed preview frame
 * DorkOS serves, with their own page state. Nothing runs a second browser
 * anywhere: the shim that is already in the page does the work, and the server's
 * only job is to address exactly one window and wait for exactly one answer.
 * {@link ./handlers} owns that half.
 *
 * Schemas and prose live apart from the handlers for the same reason the rest of
 * the `ui` domain does: one declaration serves every runtime, and the capability
 * that carries it is where a model actually reads it.
 *
 * @module services/session/browser-seat/driving-contract
 */
import { z } from 'zod';
import { WORKBENCH } from '../../../config/constants.js';
import { DRIVING_SAFETY_SENTENCE } from './act-protocol.js';
import { DOCUMENT_INPUT, TARGET_INPUT, TARGET_INPUT_NO_TEXT } from './target.js';

/** Input shape for `browser_click`. */
export const CLICK_INPUT = { ...DOCUMENT_INPUT, ...TARGET_INPUT };

/** Input shape for `browser_type`. */
export const TYPE_INPUT = {
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
export const PRESS_INPUT = {
  ...DOCUMENT_INPUT,
  key: z
    .string()
    .max(64)
    .describe(
      'One key or a chord, written the way a browser names it: "Enter", "Escape", "Control+a".'
    ),
};

/** Input shape for `browser_scroll`. */
export const SCROLL_INPUT = {
  ...DOCUMENT_INPUT,
  ...TARGET_INPUT,
  by: z
    .number()
    .optional()
    .describe('How many pixels to scroll. Positive is down, negative is up.'),
  to: z.enum(['top', 'bottom']).optional().describe('Jump to the top or the bottom of the page.'),
};

/** Input shape for `browser_wait_for`. */
export const WAIT_FOR_INPUT = {
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
export const READ_PAGE_INPUT = {
  ...DOCUMENT_INPUT,
  selector: z
    .string()
    .max(512)
    .optional()
    .describe('Read only the part of the page inside this CSS selector, rather than all of it.'),
};

/** What `browser_click` tells the model it does. */
export const CLICK_DESCRIPTION =
  'Click one thing on the preview page your session already has open. Name it the way the ' +
  'page-outline read printed it — a role and an accessible name; its name ends in `read_page` ' +
  '— or by its visible text, or as a last resort with a CSS selector. It tells you what it ' +
  'clicked, which tab it clicked it in, and where that page is now. If several things match it ' +
  'refuses instead of guessing, and says how to pick one. ' +
  DRIVING_SAFETY_SENTENCE;

/** What `browser_type` tells the model it does. */
export const TYPE_DESCRIPTION =
  'Type into a field on the preview page. Name the field by its role and name the way the ' +
  'page-outline read printed it, or with a CSS selector, or leave both out to type into ' +
  'whatever has focus — `text` here is what gets typed, so there is no name-it-by-its-text ' +
  'route on this one. `clear` replaces what is there; `submit` presses Enter afterwards, which ' +
  'submits the form. ' +
  DRIVING_SAFETY_SENTENCE;

/** What `browser_press` tells the model it does. */
export const PRESS_DESCRIPTION =
  'Press one key, or a chord, on the preview page — "Enter", "Escape", "Control+a". It goes to ' +
  'whatever has focus, so click or type into something first if you mean it for a field. ' +
  DRIVING_SAFETY_SENTENCE;

/** What `browser_scroll` tells the model it does. */
export const SCROLL_DESCRIPTION =
  'Scroll the preview page: to an element you name, by a number of pixels, or to the top or ' +
  'bottom. Use it when something you need is below the fold. ' +
  DRIVING_SAFETY_SENTENCE;

/** What `browser_wait_for` tells the model it does. */
export const WAIT_FOR_DESCRIPTION =
  'Wait for the preview page to catch up — until some text appears, until an element appears, ' +
  'or until the page stops fetching. Use it after a click that starts something, before you ' +
  'read the result. Every wait is bounded and a wait that never happens comes back as a plain ' +
  'failure, never a hang.';

/** What `browser_read_page` tells the model it does. */
export const READ_PAGE_DESCRIPTION =
  'Read the preview page back as an outline of what is on it: one line per thing, with its ' +
  'role, its name and whether it is disabled, required or checked. Call it before clicking or ' +
  'typing, and the names it prints are the names those tools take. The names are worked out ' +
  'cheaply rather than exactly, so if you cannot find something by name, reach for a CSS ' +
  'selector instead of concluding it is not there. Long pages are cut from the deepest level ' +
  'first and say so.';
