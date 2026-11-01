/**
 * The "Confirm it's you" password window (DOR-3234), and therefore a file the
 * build has to package.
 *
 * On the Mac app the owner never types their password into the app's own
 * page: anything that runs in that page could draw a look-alike. The shell
 * opens its own small window for one held action instead, from a local file
 * with its own preload, and the shell itself talks to the server.
 *
 * One set of constants, three consumers: `src/main/step-up/` opens the window
 * and answers its preload, `src/preload/step-up.ts` drives the page, and
 * `electron.vite.config.ts` emits the page beside the compiled main process
 * and builds the preload beside the app's own.
 *
 * @module shared/step-up-page
 */

/** Name of the page, in {@link STEP_UP_PAGE_SOURCE_DIR} and beside the compiled main process. */
export const STEP_UP_PAGE_FILE = 'step-up-window.html';

/** Directory the page is authored in, relative to `apps/desktop/`. */
export const STEP_UP_PAGE_SOURCE_DIR = 'src/main/step-up';

/** Name of the window's preload, beside the app's own in `dist/preload/`. */
export const STEP_UP_PRELOAD_FILE = 'step-up.js';

/** The app's page asks the shell to confirm one held action. */
export const STEP_UP_CONFIRM_CHANNEL = 'step-up:confirm';

/** The window's preload asks the shell what it is confirming. */
export const STEP_UP_WINDOW_VIEW_CHANNEL = 'step-up-window:view';

/** The window's preload sends the password, or a change of it, to the shell. */
export const STEP_UP_WINDOW_SUBMIT_CHANNEL = 'step-up-window:submit';

/** The window's preload asks the shell to close it. */
export const STEP_UP_WINDOW_CLOSE_CHANNEL = 'step-up-window:close';

/** What the window shows: the server's own words. */
export interface StepUpWindowView {
  reason: string;
  notes: string[];
  /** Why no password is offered, when it is not. */
  unavailable?: 'insecure-connection' | 'no-password';
}

/** What the window sends: a password, or a change of a too-short one. */
export type StepUpWindowSubmit =
  | { kind: 'password'; password: string }
  | { kind: 'change'; currentPassword: string; newPassword: string };

/** What the shell answers a submit with. */
export type StepUpWindowAnswer =
  /** Confirmed: the shell closes the window. */
  | { kind: 'confirmed' }
  /** Try again on the same form, with the server's words. */
  | { kind: 'retry'; message: string; retryAfterSeconds?: number }
  /** The password matched but is too short: ask for a longer one. */
  | { kind: 'too-short'; minLength: number }
  /** Over: show the words, then only Close. */
  | { kind: 'ended'; message: string };

/** How the window ended, as the app's page hears it. Never a password. */
export type StepUpWindowOutcome =
  | { kind: 'confirmed'; status: number; result: unknown }
  | { kind: 'not-confirmed' }
  | { kind: 'ask-again' };
