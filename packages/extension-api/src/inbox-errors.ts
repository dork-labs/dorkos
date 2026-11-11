/**
 * The two errors `ctx.inbox` throws. Split out of `server-extension-api.ts`,
 * which re-exports them, so that file stays under its size limit.
 *
 * @module extension-api/inbox-errors
 */

/** Which limit an {@link InboxLimitError} names. */
export type InboxLimit =
  'why' | 'title' | 'detail' | 'open' | 'key' | 'choices' | 'decideBy' | 'rate';

/**
 * Thrown by `raise`/`record` when a limit is broken: missing or long why,
 * title > 120, detail > 500, > 50 open, a bad key, a bad choice set or
 * decideBy, or more than 60 new decisions (raised or recorded) in an hour
 * (`rate`). Nothing is written. Match on `err.code === 'inbox_limit'` rather
 * than `instanceof`: an extension bundle carries its own copy of this class.
 */
export class InboxLimitError extends Error {
  /** Always `inbox_limit`. */
  readonly code = 'inbox_limit' as const;
  /** Which limit was broken. */
  readonly limit: InboxLimit;

  /**
   * Refuse a decision that broke a limit.
   *
   * @param limit - Which limit was broken.
   * @param message - What was wrong, in plain words.
   */
  constructor(limit: InboxLimit, message: string) {
    super(message);
    this.name = 'InboxLimitError';
    this.limit = limit;
  }
}

/**
 * Thrown by `raise` when `link` or a word action's `href` is not an allowed
 * in-app path. Nothing is written. Match on `err.code === 'inbox_link'`.
 */
export class InboxLinkError extends Error {
  /** Always `inbox_link`. */
  readonly code = 'inbox_link' as const;

  /**
   * Refuse a link.
   *
   * @param message - Which link was refused, and why.
   */
  constructor(message: string) {
    super(message);
    this.name = 'InboxLinkError';
  }
}
