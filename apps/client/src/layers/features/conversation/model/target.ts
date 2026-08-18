/**
 * Where a conversation's words go when you press Enter.
 *
 * The composer host that consumes this lands in P4 (DOR-1331); the contract is
 * declared now because the rest of the compound already needs parts of it — the
 * live lane reads {@link ConversationTarget.queueDepth} for its "1 queued" rung,
 * and anything that has to address the conversation reads `id`.
 *
 * It is a PORT, not a store: each host widget implements it over whatever it
 * already has (`useChatSession` for a session, the room's post mutation for a
 * room), and the compound never learns which one it got.
 *
 * @module features/conversation/model/target
 */

/** One message on its way into a conversation. */
export interface ConversationDraft {
  /** What was typed. */
  text: string;
  /** Files already uploaded and staged against this draft. */
  attachmentIds: readonly string[];
  /** Set when the draft is a thread reply. */
  parentEntryId?: string;
}

/** How a composer stages files onto a draft. */
export interface ConversationAttachmentPort {
  /**
   * Upload one file and answer the id the draft carries for it.
   *
   * Rejects rather than answering an id the server never stored — a draft
   * holding an id nothing can resolve would post a message with a dead file on
   * it.
   */
  upload(file: File): Promise<string>;
  /** Drop a staged file from the draft. */
  remove(attachmentId: string): void;
}

/** Somebody a draft can name with an `@`. */
export interface ConversationMentionCandidate {
  /** The author id the markup resolves to. */
  id: string;
  /** The verified handle, without its `@` — the only string that addresses them. */
  handle: string;
  /** What the picker shows. */
  displayName: string;
}

/** How a composer offers and inserts mentions. */
export interface ConversationMentionPort {
  /** Who matches what has been typed after the `@`, in the order to offer them. */
  search(query: string): readonly ConversationMentionCandidate[];
  /** The text a chosen candidate puts into the draft. */
  markupFor(candidate: ConversationMentionCandidate): string;
}

/** What the composer needs to send into this conversation. */
export interface ConversationTarget {
  /** Which kind of thing is being written to. */
  readonly kind: 'session' | 'room';
  /** Session id or room id. */
  readonly id: string;
  /** Placeholder, already phrased for this surface ("Message #mio…"). */
  readonly placeholder: string;
  /** False while the conversation cannot accept input (archived room, gone session). */
  readonly canSend: boolean;
  /** Send now. Rejects rather than silently dropping. */
  send(draft: ConversationDraft): Promise<void>;
  /**
   * Hold for the current turn instead of sending. Absent when the surface has no
   * queue — a room does not, and `Conversation.Composer` shows no queue chrome
   * when this is undefined rather than showing a disabled one.
   */
  queue?(draft: ConversationDraft): Promise<void>;
  /** How many drafts are already held. `0` when `queue` is absent. */
  readonly queueDepth: number;
  /** Attachment upload + removal, or `null` when `capabilities.attachments` is false. */
  readonly attachments: ConversationAttachmentPort | null;
  /** Mention search + insertion, or `null` when `capabilities.mentions` is false. */
  readonly mentions: ConversationMentionPort | null;
}
