/**
 * Sending one of the person's agents a message from an extension's server half
 * (`ctx.agent.send`, DOR-2683): the input, the receipt, the delivery events
 * that acknowledge it, and the one error it throws.
 *
 * Plain types and one error class with no runtime dependencies, so an
 * extension bundle can import it.
 *
 * @module @dorkos/extension-api/agent-messaging
 */

/** What `ctx.agent.send` takes. Any other field is refused. */
export interface AgentSendInput {
  /**
   * Who the message is for: a Mesh agent id or a chat (session) id. An agent
   * id is tried first. It goes to the one chat this extension keeps with that
   * agent: the first message opens it in the agent's home, and every later one
   * lands in the same chat.
   */
  to: string;
  /** The message, 1-20,000 characters. The agent reads it as app data, not as instructions. */
  text: string;
  /** Optional background, up to 20,000 characters, fenced with the message. */
  context?: string;
  /**
   * Your own key for this message, 1-200 characters, such as `"reply:DOR-123:4"`.
   * Sending again with the same key answers with the first receipt and sends
   * nothing, so a resend after a timeout is always safe. A key is remembered
   * for 24 hours, and for as long as its message has not finished.
   */
  idempotencyKey: string;
}

/**
 * Why a message is waiting rather than running:
 *
 * - `busy`: the agent is in the middle of a turn. The message runs when it ends.
 * - `at_capacity`: too many chats nobody typed into are running right now, or
 *   this extension started too many chats lately. The message is kept and sent
 *   as soon as there is room.
 */
export type AgentSendWaitReason = 'busy' | 'at_capacity';

/**
 * What `ctx.agent.send` answers, at once.
 *
 * `messageId` is the handle for everything after: the delivery events
 * ({@link AgentDeliveryEvent}) carry it, and a resend with the same
 * `idempotencyKey` answers with this same receipt.
 */
export interface AgentSendReceipt {
  /** The message's id. Delivery events carry it. */
  messageId: string;
  /** `started`: the agent is working on it now. `queued`: it is waiting; see `reason`. */
  status: 'started' | 'queued';
  /** Why it is waiting. Present only when `status` is `queued`. */
  reason?: AgentSendWaitReason;
  /** The chat it went to, or `null` while the agent's chat has not been opened yet. */
  sessionId: string | null;
}

/**
 * Why a message will never run. The message is gone; send it again (with a new
 * key) if it still matters.
 *
 * - `removed`: a person took it off the chat's queue, or pressed Stop.
 * - `session_gone`: the chat it was waiting in no longer exists.
 * - `interrupted`: DorkOS restarted while the message was running, or before
 *   it could tell whether it ran. Read the chat to see how far it got.
 * - `undeliverable`: it was waiting for room, and by the time there was room
 *   the agent or chat could no longer take it (removed, or not allowed there).
 */
export type AgentDeliveryFailureReason =
  'removed' | 'session_gone' | 'interrupted' | 'undeliverable';

/**
 * What happened to a message this extension sent: the acknowledgement for a
 * receipt. Each message gets at most one `turn.started`, then exactly one of
 * `turn.done` or `turn.failed`. Carries ids and outcomes only, never what the
 * agent said.
 */
export type AgentDeliveryEvent =
  /** The agent started a turn with the message. This is the ack. */
  | { kind: 'turn.started'; messageId: string; sessionId: string }
  /** The turn the message started ended. `error` means it failed partway. */
  | { kind: 'turn.done'; messageId: string; sessionId: string; outcome: 'ok' | 'error' }
  /** The message will never run. `message` says why in plain words. */
  | {
      kind: 'turn.failed';
      messageId: string;
      sessionId: string | null;
      reason: AgentDeliveryFailureReason;
      message: string;
    };

/** The `ctx.agent` surface. Probe with `ctx.agent !== undefined`. */
export interface AgentApi {
  /**
   * Send one of the person's agents a message. Answers at once with a
   * receipt; a busy agent holds the message until its current turn ends, with
   * no time limit, and the message survives a restart while it waits.
   *
   * @throws AgentSendError when the input breaks a rule (`invalid_input`), no
   *   agent or chat has that id (`not_found`), the chat is one an extension may
   *   not write into (`not_allowed`), DorkOS cannot send right now
   *   (`unavailable`), or the extension was stopped (`stopped`). Nothing was
   *   sent, and nothing was remembered under the key.
   */
  send(input: AgentSendInput): Promise<AgentSendReceipt>;
  /**
   * Hear what happens to the messages this extension sent. Events that came
   * while nothing was listening (around a restart or a reload) are delivered
   * to the first listener. Removed automatically when the extension shuts down
   * or reloads.
   *
   * @returns A function that stops listening.
   */
  subscribe(listener: (event: AgentDeliveryEvent) => void): () => void;
}

/** Why `ctx.agent.send` refused a call. See {@link AgentSendError}. */
export type AgentSendErrorCode =
  'invalid_input' | 'not_found' | 'not_allowed' | 'unavailable' | 'stopped';

/**
 * A call `ctx.agent.send` refused, with nothing sent. `message` is plain words,
 * safe to show as it is. Match on `err.code` rather than `instanceof`: an
 * extension bundle carries its own copy of this class.
 */
export class AgentSendError extends Error {
  /** Which rule refused the call. */
  readonly code: AgentSendErrorCode;

  /**
   * Refuse a call.
   *
   * @param code - Which rule refused it.
   * @param message - What went wrong, in plain words.
   */
  constructor(code: AgentSendErrorCode, message: string) {
    super(message);
    this.name = 'AgentSendError';
    this.code = code;
  }
}
