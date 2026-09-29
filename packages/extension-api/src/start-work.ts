/**
 * Starting work in a new chat (spec `flow-multiproject` §7.7, §11): the input
 * `api.startWork` and `ctx.sessions.start` share, and the one error either
 * throws.
 *
 * @module @dorkos/extension-api/start-work
 */

/** Shared by api.startWork and ctx.sessions.start. */
export interface StartWorkInput {
  /** Any path inside a known project; the chat runs in the project root. */
  project: string;
  /** Sent at once as the first message (≤ 20,000). Never shown as the headline. */
  prompt: string;
  /** The chat's title, plain words (1-80), e.g. "Sorting 12 new ideas in dorkos". */
  title: string;
  /** Why it was started (1-200), shown as the chat's first line: "Started by Flow: <reason>". */
  reason: string;
}

/**
 * Why a start was refused:
 *
 * - `not_a_project`: the folder is in no project this extension may work in.
 * - `account_not_allowed_here`: no account may work in that project.
 * - `start_limit`: the extension started 10 chats in the last hour, or 3 of
 *   its chats are working right now.
 *
 * `message` is plain words, safe to show as it is. Nothing was started. Match
 * on `err.code` rather than `instanceof`: an extension bundle carries its own
 * copy of this class.
 */
export class StartWorkError extends Error {
  /** Which rule refused the start. */
  readonly code: 'not_a_project' | 'account_not_allowed_here' | 'start_limit';

  /**
   * Refuse a start.
   *
   * @param code - Which rule refused it.
   * @param message - What to tell the person, in plain words.
   */
  constructor(code: 'not_a_project' | 'account_not_allowed_here' | 'start_limit', message: string) {
    super(message);
    this.name = 'StartWorkError';
    this.code = code;
  }
}
