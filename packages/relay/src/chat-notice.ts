/**
 * One-line notices a person sees in the chat where they asked.
 *
 * ## Why this exists
 *
 * Nine different conditions could stop a chat message before the agent ever
 * ran — a paused binding, a chat not allowed to send, a missing agent, a
 * session that failed to start, an adapter at capacity, the rate limiter, the
 * budget gate — and every one of them ended at a log line on the server. The
 * person who wrote the message saw nothing at all. A bot that silently ignores
 * you is indistinguishable from a broken one, and both are indistinguishable
 * from one that is thinking.
 *
 * A notice goes back out through the **adapter outbound path**: it is published
 * to the same chat subject the message arrived on, so the person reads it in
 * the conversation they were already looking at.
 *
 * ## Two rules that keep this from becoming a new bug
 *
 * 1. **The principal must be one the binding router skips.**
 *    {@link CHAT_NOTICE_SENDER} is a `relay.system.*` principal: the consent
 *    gate treats it as trusted server code (a reply, not an agent starting a
 *    conversation), and `BindingRouter` refuses to route it back to an agent.
 *    Sending a notice under any other principal feeds it to the agent as a
 *    fresh prompt.
 * 2. **A flood of drops is one line.** Every notice is damped per chat and
 *    reason for {@link NOTICE_DAMP_MS}. Somebody retrying six times into a
 *    paused chat is told once.
 *
 * A chat with **no binding at all** is deliberately not notified. Nobody
 * connected that conversation to anything on this machine, so there is no
 * agent whose silence needs explaining — and speaking there would be this
 * machine starting a conversation it has no consent for.
 *
 * @module relay/chat-notice
 */
import { requiresInitiateConsent } from './lib/consent-scope.js';
import type { PublishOptions, PublishResult, RelayLogger } from './types.js';
import { noopLogger } from './types.js';

/**
 * The principal every chat notice is published under.
 *
 * `relay.system.*` on purpose — see rule 1 in the module doc. Changing this
 * prefix silently turns notices into agent prompts.
 */
export const CHAT_NOTICE_SENDER = 'relay.system.chat.notice';

/** How long the same reason stays quiet in the same chat (10 minutes). */
export const NOTICE_DAMP_MS = 10 * 60 * 1_000;

/** Most damper entries kept before the oldest are dropped. */
const MAX_DAMPER_ENTRIES = 500;

/** Why a message did not reach the agent. */
export type ChatNoticeReason =
  | 'binding_paused'
  | 'receive_denied'
  | 'agent_missing'
  | 'session_failed'
  | 'agent_busy'
  | 'delivery_failed'
  | 'rate_limited'
  | 'budget_exceeded'
  /**
   * The turn ran and ended without sending anything. Not a refusal — the one
   * outcome here the machine did not decide — but the same experience from the
   * chat: a question, and then nothing. Adapters render this one directly at
   * the terminal rather than publishing it, because only they can see that
   * nothing went out.
   */
  | 'empty_response';

/**
 * What the person reads.
 *
 * One sentence, no jargon, and it names the thing they can change. These are
 * read by people who are not developers and who are, at this moment, waiting
 * on an answer that is not coming.
 */
const NOTICE_TEXT: Record<ChatNoticeReason, string> = {
  binding_paused:
    'This chat is paused in DorkOS, so your message was not passed on. ' +
    'Turn it back on under Integrations to start it again.',
  receive_denied:
    'This chat is set not to send messages to its agent, so your message was not passed on. ' +
    'You can change that under Integrations in DorkOS.',
  agent_missing:
    'The agent this chat is connected to is not available right now, so your message was not ' +
    'passed on. Check the connection under Integrations in DorkOS.',
  session_failed:
    'I could not start a session for this chat, so your message was not passed on. ' +
    'The DorkOS server log says why.',
  agent_busy:
    'The agent is handling as much as it can right now, so your message was not picked up. ' +
    'Send it again in a moment.',
  delivery_failed: 'Your message did not reach the agent.',
  rate_limited:
    'That was a lot of messages very quickly, so this one was not passed on. ' +
    'Try again in a minute.',
  budget_exceeded:
    'This message hit a safety limit in DorkOS, so it was not passed on. ' +
    'The DorkOS server log says which one.',
  empty_response: 'The agent finished without sending anything back.',
};

/** Dependencies for {@link createChatNoticeSender}. */
export interface ChatNoticeSenderDeps {
  /** Publish a payload to a subject (the relay publish pipeline). */
  publish: (subject: string, payload: unknown, options: PublishOptions) => Promise<PublishResult>;
  /** Logger for the best-effort publish. Silent by default. */
  logger?: RelayLogger;
  /** Clock, injectable so the damper is testable without waiting ten minutes. */
  now?: () => number;
}

/**
 * Send a one-line notice into a chat.
 *
 * @param subject - The `relay.human.*` subject the person's message arrived on.
 * @param reason - Which refusal happened.
 * @param options - Optional extra detail appended to the line, and a damper key
 *   scope (normally the binding id) so two bindings on one chat damp apart.
 * @returns `true` when a notice was published, `false` when it was damped,
 *   skipped as out of scope, or failed.
 */
export type ChatNoticeSender = (
  subject: string,
  reason: ChatNoticeReason,
  options?: { detail?: string; scope?: string }
) => Promise<boolean>;

/**
 * Build a {@link ChatNoticeSender} bound to the relay publish pipeline.
 *
 * The sender never throws: a notice that cannot be delivered must not take
 * down the path that was already reporting a problem.
 *
 * @param deps - Publish callback, logger, and clock.
 */
export function createChatNoticeSender(deps: ChatNoticeSenderDeps): ChatNoticeSender {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  /** Last time each `${scope}|${subject}|${reason}` was spoken. */
  const lastSpoken = new Map<string, number>();

  return async (subject, reason, options) => {
    // Only chats a person actually reads. The in-app console has its own
    // surfaces for this, and an agent or system subject has no person on it.
    if (!requiresInitiateConsent(subject)) return false;

    const key = `${options?.scope ?? ''}|${subject}|${reason}`;
    const at = now();
    const previous = lastSpoken.get(key);
    if (previous !== undefined && at - previous < NOTICE_DAMP_MS) return false;

    // Refresh insertion order so an active chat is not the one evicted.
    lastSpoken.delete(key);
    lastSpoken.set(key, at);
    while (lastSpoken.size > MAX_DAMPER_ENTRIES) {
      const oldest = lastSpoken.keys().next().value;
      if (oldest === undefined) break;
      lastSpoken.delete(oldest);
    }

    const text = options?.detail
      ? `${NOTICE_TEXT[reason]} (${options.detail})`
      : NOTICE_TEXT[reason];

    try {
      await deps.publish(subject, { content: text }, { from: CHAT_NOTICE_SENDER });
      return true;
    } catch (err) {
      // Forget it, so the next drop gets a chance to speak rather than being
      // damped by a notice that never actually reached anyone.
      lastSpoken.delete(key);
      logger.warn?.(
        `chat-notice: failed to tell ${subject} about '${reason}': ` +
          (err instanceof Error ? err.message : String(err))
      );
      return false;
    }
  };
}

/**
 * The exact line a given reason produces.
 *
 * Exported for tests and for callers that render the same copy on a surface
 * that is not the relay bus.
 *
 * @param reason - Which refusal happened.
 */
export function chatNoticeText(reason: ChatNoticeReason): string {
  return NOTICE_TEXT[reason];
}
