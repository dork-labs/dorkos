/**
 * Where a conversation's words go when you press Enter.
 *
 * `Conversation.Composer` is what consumes it; anything that has to address the
 * conversation reads `id`.
 *
 * It is a PORT, not a store: each host widget implements it over whatever it
 * already has (`useChatSession` for a session, the room's post mutation for a
 * room), and the compound never learns which one it got.
 *
 * @module features/conversation/model/target
 */
import type { PendingFile } from '@/layers/features/composer';

/** One message on its way into a conversation. */
export interface ConversationDraft {
  /** What was typed. */
  text: string;
  /**
   * Ids of files already uploaded and bound to this draft.
   *
   * Optional, and usually absent: both shipped surfaces STAGE at the keystroke
   * and upload at send, so the ids do not exist until the target is already
   * sending. A surface that genuinely holds ids in hand passes them.
   */
  attachmentIds?: readonly string[];
  /** Set when the draft is a thread reply. */
  parentEntryId?: string;
}

/**
 * How a composer stages files onto a draft.
 *
 * **Staging, not uploading, and P4 corrected the shape to say so.** P1 declared
 * this as `upload(file): Promise<string>` — a chip that already holds the id its
 * message will carry. Neither surface works that way, and neither could: a room
 * mints its attachment ids in the same breath as the post (`uploadAndGetIds` at
 * the keystroke, so a failed upload leaves no half-made entry), and a session
 * rewrites the message text with the saved PATHS at submit. Both stage at the
 * keystroke and upload at send, so this is what a chip actually is.
 *
 * It is also exactly what `Composer.Attachments` renders from, which is the
 * point: the port hands the composer host the chip bar without the host
 * learning which surface filled it.
 */
export interface ConversationAttachmentPort {
  /** Files staged against this draft, in the order they were added. */
  readonly staged: readonly PendingFile[];
  /** Stage files. Clicking the paperclip, a drop and a paste all land here. */
  add(files: File[]): void;
  /** Drop one staged file. */
  remove(fileId: string): void;
  /** Try a failed one again. */
  retry(fileId: string): void;
  /** Abandon the upload in flight. */
  cancel(): void;
  /** True while a file failed — the send must not go out (DOR-480). */
  readonly hasFailed: boolean;
  /** True while bytes are going up. */
  readonly isUploading: boolean;
  /**
   * Whether an upload still in flight holds this surface's send.
   *
   * True where the send needs the bytes to have LANDED first: a session
   * rewrites the message text with the saved paths, so Enter mid-upload would
   * send a sentence pointing at a file that is not there yet. Enter waits, and
   * Escape offers to abandon the upload.
   *
   * False where uploading IS part of sending — a room awaits its own upload
   * inside `send` — and holding Enter there would refuse a send the surface can
   * complete perfectly well. It is also what keeps Escape meaning one thing in a
   * channel: take the `@` picker down, never cancel a send in progress.
   *
   * A flag on the PORT rather than a capability, because it is a fact about how
   * this surface's own send is built, and the two surfaces that exist disagree
   * about it for that reason alone.
   */
  readonly holdsSendWhileUploading: boolean;
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
  /**
   * Why not, in a sentence a person can act on.
   *
   * Present exactly when {@link ConversationTarget.canSend} is false: a dead
   * input with no explanation is the dishonest half of refusing a send.
   */
  readonly canSendReason?: string;
  /** Send now. Rejects rather than silently dropping. */
  send(draft: ConversationDraft): Promise<void>;
  /**
   * Hold for the current turn instead of sending. Absent when the surface has no
   * queue — a room does not, and `Conversation.Composer` shows no queue chrome
   * when this is undefined rather than showing a disabled one.
   */
  queue?(draft: ConversationDraft): Promise<void>;
  /** Staged files, or `null` when `capabilities.attachments` is false. */
  readonly attachments: ConversationAttachmentPort | null;
}

/**
 * **There is no `mentions` port, and P4 decided that deliberately.**
 *
 * P1 declared one (`search` + `markupFor`) alongside the attachment port. The
 * `@` picker is not a data source, though — it is a keyboard controller over the
 * field: it owns when it is open, which row is highlighted, what Arrow and Tab
 * and Escape mean while it is, and where the caret lands after an insert
 * (`useMentionAutocomplete`, and the caret rule the room composer documented at
 * length). A port that answered "who matches `an`" would leave every one of
 * those decisions somewhere else, so the composer host would need both — two
 * sources for one picker.
 *
 * So the picker rides the host's own overlay slot, and the one fact the neutral
 * tree needs about it stays where the rest of the surface's differences live:
 * `ConversationCapabilities.mentions`.
 */
