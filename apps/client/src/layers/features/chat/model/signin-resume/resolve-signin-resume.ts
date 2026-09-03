/**
 * Whether a sign-in that just landed should re-send the turn it fixed, and with
 * what words (DOR-1650).
 *
 * The promise this serves is one sentence: someone whose sign-in died mid-task
 * signs in once, and their message sends itself. The whole difficulty is the
 * word "their". Every rule below exists to answer one question honestly: **is
 * the message that failed still the message they want sent?** Where the answer
 * is anything but a clear yes, this returns `null`, the card settles on "Signed
 * in.", and the Retry button hands the decision back.
 *
 * It is a pure function on purpose. "Did they move on?" is the whole risk in
 * this feature, and a rule nobody can read is a rule nobody can check.
 *
 * ## Why the last user message is the right words
 *
 * An auth failure happens AFTER the message was accepted — the turn opened, the
 * runtime rejected the credentials, the turn closed — so the text is in the
 * transcript, and the last user message is it. That is also exactly what Retry
 * re-sends, so the automatic path and the manual one can never send different
 * things. (The transport-error path needs {@link resolveTransportRetryText}'s
 * birth-record fallback because a failed POST drops the optimistic bubble; no
 * such gap exists here, because the POST succeeded.)
 *
 * ## Rule 4 is what keeps this agreeing with DOR-1677
 *
 * `AssistantMessageContent` gates the manual Retry button by CARD POSITION:
 * only the session's final message may offer it (`isFinalMessage`, DOR-1677),
 * because Retry always sends the LAST user message and a card six turns back is
 * not about that message.
 *
 * This gates the AUTOMATIC send by CONVERSATION TAIL instead — position is not
 * something a rule handed a transcript can see, and the tail is the fact that
 * actually matters.
 *
 * The two are not the same test, and they agree only because rule 4 holds. Sign
 * in from a mid-history card and rule 4 is what declines: the tail after the
 * last user message no longer carries the auth failure. **Relax rule 4 and
 * DOR-1677's bug comes straight back through the automatic door** — with no
 * button press to blame it on, which is worse than the version that shipped.
 * Anything that widens rule 4 has to answer that first.
 *
 * ## Two limits, decided rather than overlooked
 *
 * **No recency bound, deliberately.** A conversation reopened a week later,
 * still ending on its auth failure, still resumes when you sign in. That reads
 * wrong at first and is right on inspection: the card's own promise is "sign in
 * again to pick up where you left off", and a tail that never moved IS where
 * they left off. Age is not evidence of changed intent — the four rules that
 * ARE evidence (a draft, a running turn, a queued message, a newer failure) do
 * not weaken with time. A bound would also have to invent a number, and no
 * number here is defensible.
 *
 * **A steer or a staged note can be the words.** Not every user message is a
 * prompt: a mid-turn steer and a staged context note are both `role: 'user'`,
 * so "also add tests" can be what gets re-sent. That is Retry's invariant too —
 * the manual button has always had it — but doing it automatically removes the
 * moment where a person would have noticed. It stays because the alternative is
 * worse: filtering by message kind would silently withhold the resume from
 * whoever steers most, and a steer that ended in an auth failure is still a
 * message the runtime never received.
 *
 * @module features/chat/model/signin-resume/resolve-signin-resume
 */
import type { ErrorCategory } from '@dorkos/shared/types';
import type { ChatMessage, ChatStatus } from '@/layers/shared/model';

/** Everything the resume rule reads, gathered where the conversation lives. */
export interface SigninResumeState {
  /** The rendered transcript. */
  messages: ChatMessage[];
  /** The rendered coarse chat status. */
  status: ChatStatus;
  /**
   * Category of the failed turn's typed error (`status.lastError`), when the
   * session recorded one. This is what the panel-level `TurnFailedNotice` reads,
   * and it is the only evidence of the failure when it folded no inline part.
   */
  lastErrorCategory?: ErrorCategory;
  /** How many messages are already waiting on the server queue. */
  queuedCount: number;
  /** What is currently typed in the composer. */
  draft: string;
}

/**
 * The category of the last `error` part in these messages — the one the turn
 * actually ended on — or `NO_ERROR_PART` when there is none.
 *
 * Three answers, not two, and the difference decides the branch below: a
 * categorised part names the failure, an UNCATEGORISED one (`undefined`) is a
 * failure nothing could classify — the CLI's own limit and connection notices
 * arrive that way (DOR-1649) — and `NO_ERROR_PART` means the turn folded no
 * inline part at all, which is the panel-notice path.
 */
const NO_ERROR_PART = Symbol('no-error-part');

/** Scan back for the error part a turn ended on. See {@link NO_ERROR_PART}. */
function lastErrorPartCategory(
  messages: ChatMessage[]
): ErrorCategory | undefined | typeof NO_ERROR_PART {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      if (part.type === 'error') return part.category;
    }
  }
  return NO_ERROR_PART;
}

/**
 * The message to re-send now that a sign-in landed, or `null` to leave the
 * conversation alone.
 *
 * Five ways to get `null`, each a different shape of "they moved on":
 *
 * 1. **The composer holds a draft.** Someone typing is someone with newer
 *    intent, and sending their older message over the top of it is the one
 *    outcome worse than making them press Retry. Nothing clears or overwrites
 *    what they typed either — the draft is theirs.
 * 2. **A turn is already running.** Whatever started it is what the session is
 *    doing now. This is also what stops a second window from duplicating the
 *    send: the first window's turn reaches every tab over the session stream,
 *    and every other card then stands down.
 * 3. **Something is already queued.** They lined up work — from this window or
 *    another one — and inserting the failed prompt ahead of it reorders their
 *    day without asking.
 * 4. **The newest failure is not the one signing in fixed.** A turn that has
 *    since died of something else is not evidence that credentials were the
 *    problem, so resuming would present a fix for a failure it did not fix.
 * 5. **There is nothing to send.** No user message, or a blank one.
 *
 * A turn that auth-failed AGAIN while the sign-in ran is not "moving on" — it is
 * the same wall, hit twice — so the newest prompt resumes, which is also what
 * Retry would send.
 *
 * @param state - The conversation as it stands at the moment the sign-in landed.
 */
export function resolveSigninResumeText(state: SigninResumeState): string | null {
  const { messages, status, lastErrorCategory, queuedCount, draft } = state;

  if (draft.trim().length > 0) return null;
  if (status === 'streaming') return null;
  if (queuedCount > 0) return null;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const text = lastUserIdx === -1 ? '' : messages[lastUserIdx].content.trim();
  if (!text) return null;

  // Only the CURRENT turn decides — everything after the last user message.
  // An auth error from three turns ago is history, not a licence to resend.
  const tailErrorCategory = lastErrorPartCategory(messages.slice(lastUserIdx + 1));
  if (tailErrorCategory !== NO_ERROR_PART) {
    return tailErrorCategory === 'auth_error' ? text : null;
  }

  // No inline error part: the `TurnFailedNotice` path, whose card is on screen
  // under exactly this condition (see `shouldShowTurnFailedNotice`). The typed
  // error is the only record the failure left.
  if (status === 'error' && lastErrorCategory === 'auth_error') return text;
  return null;
}
