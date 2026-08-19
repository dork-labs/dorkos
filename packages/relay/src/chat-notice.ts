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
 * One reason here is not a stop at all. `agent_held` reports a message that is
 * **waiting** for a busy agent rather than one that was turned away, and it
 * exists because the alternative was asking a person to send their message
 * again before the machine had even tried (ADR `260819-034718`).
 *
 * It promises nothing, on purpose. The hold's ceiling is not the ceiling on the
 * turn in its way, so "it will be picked up" is a sentence the code cannot
 * guarantee; "your message is waiting its turn" is one it can, and it answers
 * the only question the person actually has. If the wait then runs out,
 * `agent_busy` says so — and that line may ask for a resend, because by then
 * the machine has genuinely tried and failed, and resending is the one thing
 * that works. Asking FIRST, instead of waiting, is what this work removed.
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
 * A chat with **no binding at all** is deliberately not notified, and that is
 * enforced here rather than left to each caller: every notice resolves through
 * {@link ChatNoticeSenderDeps.resolveTarget} first. Nobody connected that
 * conversation to anything on this machine, so there is no agent whose silence
 * needs explaining — and speaking there would be this machine starting a
 * conversation it has no consent for, under a principal the consent gate
 * exempts.
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
  /**
   * The agent was already running everything it can, so this message is waiting
   * its turn. **Not a refusal** — nothing was dropped, and this is the one
   * notice here that reports work still to come rather than work declined.
   *
   * Reachable only for a message a person is waiting on in a bridged chat, and
   * only once the wait has lasted long enough to be worth a line
   * (`adapters/claude-code/capacity-hold.ts`), so an ordinary two-second wait
   * says nothing at all. It has no {@link RefusalReason} because nothing was
   * refused.
   */
  | 'agent_held'
  | 'delivery_failed'
  | 'rate_limited'
  | 'budget_exceeded'
  /**
   * The chat's DorkOS channel was archived out from under a live bridge, so an
   * inbound message had nowhere to land (chats-as-channels spec §10.9). The
   * bridge is switched off in the same breath; this line is what tells the
   * person in the chat, once, that their messages stopped being picked up.
   */
  | 'channel_archived'
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
    'Your agent was too busy to take this message, so it was not picked up. You can send it again now.',
  agent_held:
    'Your agent was busy when your message arrived, so your message is waiting its turn. There is nothing you need to do.',
  delivery_failed: 'Your message did not reach the agent.',
  rate_limited:
    'That was a lot of messages very quickly, so this one was not passed on. ' +
    'Try again in a minute.',
  budget_exceeded:
    'This message hit a safety limit in DorkOS, so it was not passed on. ' +
    'The DorkOS server log says which one.',
  channel_archived:
    'This chat is no longer connected in DorkOS, so your message was not passed on. ' +
    'Bridge it again under Integrations to reconnect.',
  empty_response: 'The agent finished without sending anything back.',
};

/**
 * Resolve a chat subject to the enabled binding that owns it.
 *
 * This is the authorization step, not a lookup convenience. See
 * {@link ChatNoticeSenderDeps.resolveTarget}.
 */
export type ChatNoticeTargetResolver = (subject: string) => { bindingId: string } | null;

/** Dependencies for {@link createChatNoticeSender}. */
export interface ChatNoticeSenderDeps {
  /** Publish a payload to a subject (the relay publish pipeline). */
  publish: (subject: string, payload: unknown, options: PublishOptions) => Promise<PublishResult>;
  /**
   * Resolve a chat subject to an **enabled** binding, through the binding
   * store — or `null`, which means silence.
   *
   * ## This is a security boundary, not a nicety
   *
   * One caller of this sender is the detached-delivery failure path, and the
   * subject it hands over is the failed envelope's `replyTo`. On `relay_send`
   * that field is written by the model: an agent could set it to
   * `relay.human.telegram.<any-adapter>.<any-chat>`, fail its own delivery, and
   * have this machine post into a chat nobody had bound to anything — under a
   * `relay.system.*` principal the consent gate exempts by design. Resolving
   * through the store closes that door, and doing it here rather than at each
   * call site means a new caller inherits the check instead of forgetting it.
   *
   * A resolver that cannot answer must return `null`. Not knowing is a denial,
   * exactly as it is for {@link InitiateConsentGate}.
   */
  resolveTarget: ChatNoticeTargetResolver;
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
 * @param options - Optional extra detail appended to the line, and the binding
 *   this notice is about when the caller has ALREADY resolved it from the store
 *   this same tick (the binding router has; nobody else should claim to).
 * @returns `true` when a notice was published, `false` when it was damped,
 *   refused as out of scope, or failed.
 */
export type ChatNoticeSender = (
  subject: string,
  reason: ChatNoticeReason,
  options?: { detail?: string; binding?: { id: string } }
) => Promise<boolean>;

/**
 * Build a {@link ChatNoticeSender} bound to the relay publish pipeline.
 *
 * The sender never throws: a notice that cannot be delivered must not take
 * down the path that was already reporting a problem.
 *
 * @param deps - Publish callback, binding resolver, logger, and clock.
 */
export function createChatNoticeSender(deps: ChatNoticeSenderDeps): ChatNoticeSender {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  /** Last time each `${bindingId}|${subject}|${reason}` was spoken. */
  const lastSpoken = new Map<string, number>();

  return async (subject, reason, options) => {
    // Only chats a person actually reads. The in-app console has its own
    // surfaces for this, and an agent or system subject has no person on it.
    if (!requiresInitiateConsent(subject)) return false;

    // Which binding this chat belongs to. A caller that resolved it from the
    // store this tick may name it; anyone else must go through the resolver,
    // which answers `null` for a chat nothing is bound to.
    const bindingId = options?.binding?.id ?? deps.resolveTarget(subject)?.bindingId;
    if (!bindingId) return false;

    // Keyed by (binding, chat, reason) — never by anything a caller supplies
    // freely. Keying on the failed agent subject, as this briefly did, let a
    // caller vary one field and speak past the damper as often as it liked.
    const key = `${bindingId}|${subject}|${reason}`;
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
