/**
 * `Conversation.Composer` — one composer card, for every surface that has one.
 *
 * What collapsed into it: `features/chat/ui/input/ChatInputContainer.tsx` (536
 * lines) and `widgets/room-view/ui/RoomComposer.tsx` (604 lines). What is left
 * of each of those is its own WIRING — which palettes it opens, what Enter means
 * to it, where its draft lives — and that stays in the host widget, because it
 * is the part that genuinely differs.
 *
 * **What this owns is the card's shape and the rules that follow from the
 * target.** In order, inside `Composer.Root`: the head, the overlay lane
 * (palettes, then the armed-clear hint, in that order because stacking is child
 * order), the chip bar, the queue chrome, whatever else sits above the field,
 * the field, and the footer. Every surface gets that arrangement, so a file
 * waiting to be sent is in the same place in a channel as it is in a session.
 *
 * And three rules the target decides rather than the host:
 *
 * - **No queue chrome at all when the target has no queue.** A room does not,
 *   and a disabled queue button in a channel would be a control explaining a
 *   feature the surface does not have.
 * - **`canSend: false` is drawn honestly**, with the target's own sentence
 *   saying why. A dead input with no explanation is the dishonest half of
 *   refusing a send.
 * - **The chip bar and the paperclip come from the attachment port**, never
 *   from a flag: a surface has attach because its target staged files.
 *
 * **A note on `features/composer`'s doctrine.** That slice says composition IS
 * the capability declaration, and that there will never be a config object.
 * This does not contradict it: the parts are still composed here, in one place,
 * and what a surface can do is still read off what it passes — a target with no
 * `queue`, an `attachments` port that is `null`. What moved is only WHERE the
 * composition is written, from two surfaces to one.
 *
 * @module features/conversation/ui/ComposerHost
 */
import { useState, type ReactNode, type Ref } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Composer,
  type ComposerInputHandle,
  type ComposerInputProps,
} from '@/layers/features/composer';
import { useConversation } from '../model/conversation-context';

/** Everything a surface still decides about its own field. */
export type ConversationComposerInputProps = Omit<
  ComposerInputProps,
  | 'value'
  | 'onChange'
  | 'onSubmit'
  | 'onAttach'
  | 'onClearArmedChange'
  | 'isUploading'
  | 'onCancelUpload'
>;

/** What {@link ConversationComposer} needs to draw a surface's composer. */
export interface ConversationComposerProps {
  /** The draft, as the surface's own store holds it. */
  value: string;
  /** Told what was typed. */
  onChange: (next: string) => void;
  /**
   * Send it.
   *
   * The HOST's funnel, not `target.send` directly: a surface has things to do
   * on the way — dismiss its palettes, intercept a native command, read the
   * draft out of its store rather than out of a stale render closure. The
   * target is what that funnel ends in.
   */
  onSubmit: () => void;
  /** The field's handle, for a host that focuses it. */
  inputRef?: Ref<ComposerInputHandle>;
  /**
   * The top of the card, inside it: a session's streaming edge, a channel's
   * live region for its `@` picker.
   */
  head?: ReactNode;
  /** Stacked over the field: the palettes, the recents panel. */
  overlays?: ReactNode;
  /**
   * The held drafts.
   *
   * Drawn only when the target HAS a queue: the presence of `target.queue` is
   * the whole gate, so a surface without one grows no queue chrome even if it
   * passed a node.
   */
  queue?: ReactNode;
  /** Between the queue and the field: a session's background-task bar. */
  aboveInput?: ReactNode;
  /**
   * The prompt that REPLACES this composer while it waits for an answer.
   *
   * Three states, and the distinction between the last two is deliberate:
   * `undefined` means this surface is never taken over (a channel draws its
   * Asks in the lane instead — one card, in the place the work is); `null`
   * means it can be and is not right now, which is what keeps the exit
   * animation able to play; a node means it is.
   */
  asks?: ReactNode;
  /** Below the field. `Conversation.Footer` content. */
  footer?: ReactNode;
  /** Outside the animated body: dialogs the card owns. */
  children?: ReactNode;
  /** Extra classes for the card. */
  className?: string;
  /** A file dragged out of a local file browser becomes a reference, not an upload. */
  onPathDropped?: (path: string) => void;
  /** Everything about the field the surface still decides. */
  input: ConversationComposerInputProps;
}

/**
 * Draw a conversation's composer.
 *
 * @param props - The draft, the surface's own wiring, and its slots.
 */
export function ConversationComposer({
  value,
  onChange,
  onSubmit,
  inputRef,
  head,
  overlays,
  queue,
  aboveInput,
  asks,
  footer,
  children,
  className,
  onPathDropped,
  input,
}: ConversationComposerProps) {
  const { capabilities, target } = useConversation();
  if (target === null) {
    throw new Error(
      '<Conversation.Composer> needs a target. A host that draws a composer has to say where its words go — pass `target` to <Conversation.Root>.'
    );
  }

  // The composer owns WHEN the double-Escape is armed (it owns the keyboard);
  // this owns WHERE that reads out, because the lane it belongs in floats above
  // the queue rows and the chips, which are rendered here.
  const [clearArmed, setClearArmed] = useState(false);

  // Attach exists because the target staged files, never because a flag said
  // so — and the capability is what a surface OFFERS, so both have to agree.
  const attachments = capabilities.attachments ? target.attachments : null;
  const staged = attachments?.staged ?? [];
  // A failed attachment blocks the send outright. Sending anyway delivered a
  // message with no attachment and then wiped the error chips, leaving the
  // person waiting on an answer about a file the agent never received
  // (DOR-480).
  const blockedByUpload = attachments?.hasFailed === true;
  const canSubmit = target.canSend && !blockedByUpload && (input.canSubmit ?? true);
  // The REASON is never invented here. A conversation that cannot be written to
  // says why through its target; a surface that refuses a send for its own
  // reason says so through its field. Writing a sentence for the failed-upload
  // case would put a refusal line on a surface whose design answers it with the
  // red chip above the box instead — the two shipped composers disagree about
  // that on purpose, and this is not the place to settle it.
  const canSubmitReason = !target.canSend ? target.canSendReason : input.canSubmitReason;

  const body = (
    <>
      {/* Stacking is child order: palettes first, the armed-clear hint last, so
          the hint never lands on the queue rows' controls. */}
      <Composer.OverlayLane>
        {overlays}
        {clearArmed && <Composer.ClearArmedHint />}
      </Composer.OverlayLane>
      {attachments !== null && staged.length > 0 && (
        <Composer.Attachments
          files={[...staged]}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
          onCancel={attachments.cancel}
        />
      )}
      {/* The whole queue gate, in one place: a surface without a queue draws no
          queue chrome, rather than a disabled version of somebody else's.
          WHETHER there is a queue is the target's answer; how many are in it
          right now is the host's own, because the panel counts the drafts this
          window is holding and the target counts what the server has. */}
      {target.queue !== undefined && queue}
      {aboveInput}
      <Composer.Input
        {...input}
        ref={inputRef}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={input.placeholder ?? target.placeholder}
        canSubmit={canSubmit}
        {...(canSubmitReason === undefined ? {} : { canSubmitReason })}
        {...(attachments === null
          ? {}
          : {
              onAttach: attachments.add,
              isUploading: attachments.isUploading,
              onCancelUpload: attachments.cancel,
            })}
        onClearArmedChange={setClearArmed}
      />
      {footer}
    </>
  );

  return (
    <Composer.Root
      className={className}
      {...(attachments === null ? {} : { onFilesDropped: attachments.add })}
      {...(onPathDropped === undefined ? {} : { onPathDropped })}
    >
      {head}
      {asks === undefined ? (
        body
      ) : (
        <AnimatePresence mode="wait">
          {asks !== null ? (
            <motion.div
              key="interactive"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {asks}
            </motion.div>
          ) : (
            <motion.div
              key="normal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {body}
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {children}
    </Composer.Root>
  );
}
