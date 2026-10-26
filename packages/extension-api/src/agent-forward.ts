/**
 * Forwarding what the person typed in a mini app to an agent, as their own
 * words (`api.forward`, DOR-3325): the shapes it returns, the one error it
 * throws, and the API itself.
 *
 * Plain types and one error class with no runtime dependencies, so an
 * extension bundle can import it.
 *
 * **Different from `ctx.agent.send`.** A server half's `ctx.agent.send` is the
 * app talking: the agent reads it as data from an app, never as the person,
 * and runs no looser than its default. `api.forward` is the person talking.
 * DorkOS reads the person's own POST from their own window, posts their typed
 * words into their Direct chat with the agent, and the agent treats them as a
 * message from the person. The app never touches the words in between.
 *
 * **Scoped to one agent.** The person picks, in Settings → Extensions, the one
 * agent a mini app may forward to. The app cannot name another. With no agent
 * picked, or no `capabilities.forward` in its manifest, every call is refused.
 *
 * @module @dorkos/extension-api/agent-forward
 */

/** The longest comment `api.forward.send` takes, in characters. */
export const FORWARD_TEXT_MAX_CHARS = 8_000;

/** The longest item id `api.forward.send` takes, in characters. */
export const FORWARD_ITEM_ID_MAX_CHARS = 200;

/** The longest item title `api.forward.send` takes, in characters. */
export const FORWARD_ITEM_TITLE_MAX_CHARS = 200;

/** The agent a forward goes to. */
export interface ForwardAgent {
  /** The agent's id. */
  readonly id: string;
  /** Its name, as DorkOS shows it. */
  readonly name: string;
}

/** What {@link ExtensionForwardApi.send} answers with once the comment is posted. */
export interface ForwardReceipt {
  /** The forward's id. Pass it to {@link ExtensionForwardApi.replies}. */
  readonly id: string;
  /** Who it went to. */
  readonly agent: ForwardAgent;
  /** ISO-8601 time it was posted. */
  readonly sentAt: string;
}

/** One answer the agent posted to a forward. */
export interface ForwardReply {
  /** The answer's id. Stable. */
  readonly id: string;
  /** Who wrote it: always the agent, never the person. */
  readonly agent: ForwardAgent;
  /**
   * What it says, as markdown with every `<` escaped and script links removed,
   * so no HTML can come through. Render it as markdown, not as HTML.
   */
  readonly markdown: string;
  /** ISO-8601 time it was posted. */
  readonly createdAt: string;
}

/** Why `api.forward` refused a call. See {@link ForwardError}. */
export type ForwardErrorCode =
  /** The person has not picked an agent for this mini app. */
  | 'no_agent'
  /** No such forward, or the agent is gone. */
  | 'not_found'
  /** Forwarding needs the person, signed in, in their own window of the app. */
  | 'person_required'
  /** The mini app is turned off. */
  | 'extension_off'
  /** The call broke a rule (empty text, too long, an unknown field). */
  | 'invalid_input'
  /** DorkOS could not answer. Try again. */
  | 'unavailable';

/**
 * A call `api.forward` refused, with nothing sent. `message` is plain words,
 * safe to show as it is. Match on `err.code` rather than `instanceof`: an
 * extension bundle carries its own copy of this class.
 */
export class ForwardError extends Error {
  /** Which rule refused the call. */
  readonly code: ForwardErrorCode;

  /**
   * Refuse a call.
   *
   * @param code - Which rule refused it.
   * @param message - What went wrong, in plain words.
   */
  constructor(code: ForwardErrorCode, message: string) {
    super(message);
    this.name = 'ForwardError';
    this.code = code;
  }
}

/** What {@link ExtensionForwardApi.send} takes. Nothing else: unknown fields are refused. */
export interface ForwardInput {
  /** Exactly what the person typed. 1 to {@link FORWARD_TEXT_MAX_CHARS} characters. */
  readonly text: string;
  /** The app's own id for the item they typed it on. */
  readonly itemId: string;
  /**
   * The item's title, shown to the person above the message as quoted text
   * from this app. Never part of the person's words, and never shown to the
   * agent as theirs.
   */
  readonly itemTitle?: string;
}

/**
 * The `api.forward` surface: send what the person typed to the agent they
 * picked for this mini app, and read the agent's answers back. Probe with
 * `api.forward !== undefined` to run on hosts from before it.
 *
 * Every method throws {@link ForwardError} on refusal.
 *
 * @example
 * ```ts
 * const sent = await api.forward.send({ text: comment, itemId: item.id, itemTitle: item.title });
 * // later, to show the agent's answer under the comment:
 * const replies = await api.forward.replies(sent.id);
 * ```
 */
export interface ExtensionForwardApi {
  /** The agent the person picked for this mini app, or `null` when none. */
  agent(): Promise<ForwardAgent | null>;
  /**
   * Post what the person typed into their Direct chat with the picked agent,
   * as their own message. A muted "via {app} · {item}" line sits above it.
   * The agent answers as if they had typed it there. Recorded in the audit
   * trail with this mini app named.
   *
   * Only works from the person's own window, signed in with a password. An
   * agent, a request from another site, a server half, and a DorkOS with no
   * password are refused with `person_required`.
   *
   * @param input - The typed text and the item it is about.
   * @returns The receipt.
   */
  send(input: ForwardInput): Promise<ForwardReceipt>;
  /**
   * The agent's answers to one forward, oldest first (at most 20). Empty
   * until it answers.
   *
   * @param forwardId - The receipt's `id`.
   */
  replies(forwardId: string): Promise<ForwardReply[]>;
}
