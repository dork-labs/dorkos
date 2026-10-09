/**
 * The title of a chat an agent starts with `session_start` (DOR-2824).
 *
 * A started chat used to take its title from its first message, which is the
 * brief the starting agent wrote for another agent ("DOR-2823 end to end rooms
 * conversation routing") and reads like one. The agent now names it, and when
 * it does not, the title comes from the plain-words `reason` it gave, never
 * from the brief.
 *
 * Naming the chat is a runtime rename, and a runtime whose transcript is not on
 * disk until the first turn writes it (Claude Code) refuses a rename that comes
 * too early. {@link nameStartedChat} keeps trying for a short while, then once
 * more when the first turn settles, and gives up quietly: a chat that keeps its
 * derived title is a worse name, not a failure anybody needs to hear about.
 *
 * @module services/session/launch/started-chat-title
 */
import { START_WORK_LIMITS } from '@dorkos/shared/extension-decision-schemas';
import { logError, logger } from '../../../lib/logger.js';

/** The longest title {@link titleFromReason} makes; the sidebar shows about this much. */
export const REASON_TITLE_MAX = 60;

/** When to try the rename again after the first try fails, in ms from then. */
export const RENAME_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

/**
 * A short, plain title from the reason an agent gave for starting a chat: its
 * first sentence, cut at a word to at most {@link REASON_TITLE_MAX} characters,
 * with a capital first letter and no closing full stop.
 *
 * @param reason - Why the chat was started, as the agent wrote it.
 * @returns The title, or null when the reason has no words.
 */
export function titleFromReason(reason: string | undefined): string | null {
  const words = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  // The first sentence: up to a full stop, question or exclamation mark that
  // ends a word. "v0.101.0" and "e.g." in the middle of a word stay whole.
  const sentence = (words.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? words).replace(/[.!]+$/, '').trim();
  let title = sentence;
  if (title.length > REASON_TITLE_MAX) {
    const cut = title.slice(0, REASON_TITLE_MAX - 1);
    const lastSpace = cut.lastIndexOf(' ');
    title = `${(lastSpace > REASON_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
  }
  if (!title) return null;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * The title a started chat gets: the agent's own, else one from its reason.
 *
 * @param title - The title the agent gave, if any.
 * @param reason - The reason it gave, if any.
 */
export function startedChatTitle(
  title: string | undefined,
  reason: string | undefined
): string | null {
  const own = title?.replace(/\s+/g, ' ').trim().slice(0, START_WORK_LIMITS.title);
  return own || titleFromReason(reason);
}

/** What {@link nameStartedChat} needs. */
export interface NameStartedChatOptions {
  /** Renames the chat; rejects when the runtime cannot yet. */
  rename: () => Promise<void>;
  /** The chat, for the log. */
  sessionId: string;
  /** Overridable for tests. */
  delaysMs?: readonly number[];
  /** Overridable for tests. */
  schedule?: (run: () => void, ms: number) => void;
}

/**
 * Give a started chat its title: now, else after each of
 * {@link RENAME_RETRY_DELAYS_MS}, else once more when the first turn settles.
 * Stops at the first success. Never throws.
 *
 * @param options - See {@link NameStartedChatOptions}.
 * @returns A callback for the first turn's settle: the last try.
 */
export function nameStartedChat(options: NameStartedChatOptions): () => void {
  const { rename, sessionId } = options;
  const delays = options.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref();
    });
  let named = false;
  let settled = false;
  let attempt = 0;

  const tryRename = (last: boolean): void => {
    if (named) return;
    rename().then(
      () => {
        named = true;
      },
      (err: unknown) => {
        if (last) {
          logger.warn('[session_start] could not give a started chat its title', {
            sessionId,
            ...logError(err),
          });
          return;
        }
        const delay = delays[attempt++];
        if (delay !== undefined && !settled) schedule(() => tryRename(false), delay);
      }
    );
  };

  tryRename(false);
  return () => {
    if (settled) return;
    settled = true;
    tryRename(true);
  };
}
