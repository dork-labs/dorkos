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
  if (!/[\p{L}\p{N}]/u.test(words)) return null;
  // The first sentence: up to a full stop, question or exclamation mark that
  // ends a word. "v0.101.0" and "e.g." in the middle of a word stay whole.
  const sentence = (words.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? words).replace(/[.!]+$/, '').trim();
  // Counted in characters, not UTF-16 units, so a cut never splits an emoji.
  const chars = Array.from(sentence);
  let title = sentence;
  if (chars.length > REASON_TITLE_MAX) {
    const cut = chars.slice(0, REASON_TITLE_MAX - 1).join('');
    const lastSpace = cut.lastIndexOf(' ');
    title = `${(lastSpace > REASON_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
  }
  // "fix the docs" reads "Fix the docs"; "iOS build" stays as written.
  const [first = '', second = ''] = Array.from(title);
  const keep = second !== '' && second === second.toUpperCase() && second !== second.toLowerCase();
  return keep ? title : first.toUpperCase() + title.slice(first.length);
}

/**
 * The title a started chat gets: the agent's own, else one from its reason,
 * else "Started by <agent>". Never the brief. Always a title, so the link the
 * agent is handed names the chat the way the sidebar does.
 *
 * @param title - The title the agent gave, if any.
 * @param reason - The reason it gave, if any.
 * @param agentName - The starting agent's name, for the last fallback.
 */
export function startedChatTitle(
  title: string | undefined,
  reason: string | undefined,
  agentName: string
): string {
  const own = Array.from(title?.replace(/\s+/g, ' ').trim() ?? '')
    .slice(0, START_WORK_LIMITS.title)
    .join('');
  return own || titleFromReason(reason) || `Started by ${agentName}`;
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
 * Stops at the first success, and never tries again after the settle's last
 * try. Never throws.
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
    // Through a promise, so a rename that throws before it returns one is a
    // refusal like any other, never an uncaught throw from a timer.
    Promise.resolve()
      .then(rename)
      .then(
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
          // A retry that comes due after the settle's last try does not run:
          // by then a person may have renamed the chat themselves.
          if (delay !== undefined && !settled) {
            schedule(() => {
              if (!settled) tryRename(false);
            }, delay);
          }
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
