import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, CornerDownLeft, Square, Clock, Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { DispositionMenu } from './DispositionMenu';

type ButtonState =
  | 'send'
  | 'stop'
  | 'queue'
  | 'update'
  | 'cancel'
  | 'cancel-upload'
  | 'dispatching';

interface InputActionButtonProps {
  hasText: boolean;
  isStreaming: boolean;
  /** A dispatched native command has not settled — its text is still in the box. */
  commandPending?: boolean;
  /** When true, the send action reads disabled and does nothing (target not ready). */
  submitDisabled?: boolean;
  editingQueueItem: boolean;
  queueDepth: number;
  /**
   * Touch is the only pointer — the send icon advertises a tap rather than the
   * Enter key, because on that device Enter inserts a newline. Must be the same
   * signal the keyboard rule uses, or the icon names a gesture the keyboard
   * does not honour.
   */
  isTouchOnly: boolean;
  onSubmit: () => void;
  onStop?: () => void;
  onQueue?: () => void;
  onSaveEdit?: () => void;
  /** Leave the queue-item edit without saving — the way out of an emptied edit. */
  onCancelEdit?: () => void;
  /**
   * Stop the attachment upload that is in flight — and, by being present at
   * all, the signal that one IS in flight.
   *
   * One prop rather than an `isUploading` flag beside it, because the pair
   * could express a state this composer must never reach: an upload on screen
   * with nothing to press. A host with no cancel to offer simply does not show
   * the upload here (see `ComposerInput`).
   */
  onCancelUpload?: () => void;
  /**
   * Send the message into the running task now (steer). Passed ONLY when the
   * agent can take a message mid-task, so the caret beside Queue shows a Steer
   * row; omitted, the row is absent, never greyed. Only ever offered in the
   * `queue` state — an idle send never splits.
   */
  onSteer?: () => void;
  /**
   * Add the message as context the agent uses next, without cutting in (stage).
   * Passed ONLY when the agent can take added context. Same "hidden, not
   * disabled" rule as {@link onSteer}.
   */
  onStage?: () => void;
}

const BUTTON_CONFIG = {
  send: {
    className: 'bg-primary text-primary-foreground hover:bg-primary/90',
    label: 'Send message',
  },
  stop: {
    className: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    label: 'Stop generating',
  },
  queue: {
    className: 'bg-muted text-muted-foreground hover:bg-muted/80',
    label: 'Queue message',
  },
  update: {
    className: 'bg-primary text-primary-foreground hover:bg-primary/90',
    label: 'Save edit',
  },
  cancel: {
    className: 'bg-muted text-muted-foreground hover:bg-muted/80',
    label: 'Cancel edit',
  },
  'cancel-upload': {
    // Turns red under the pointer for the same reason Stop is red: this ends
    // the send that is happening — so it borrows Stop's exact pairing rather
    // than a literal colour, which would have been white on both themes.
    className:
      'bg-muted text-muted-foreground hover:bg-destructive/90 hover:text-destructive-foreground',
    label: 'Cancel upload',
  },
  dispatching: {
    className: 'bg-muted text-muted-foreground',
    label: 'Running command',
  },
} satisfies Record<ButtonState, { className: string; label: string }>;

/**
 * The glyph per state. Send is the one that depends on the pointer — an
 * up-arrow reads as "send" where Enter inserts a newline — so it is swapped at
 * the use site rather than stored twice. Total over the union, so resolving an
 * icon needs no non-null assertion; the inert progress states draw their own
 * spinner and never read this.
 */
const BUTTON_ICON: Record<ButtonState, React.ElementType> = {
  send: CornerDownLeft,
  stop: Square,
  queue: Clock,
  update: Check,
  cancel: X,
  // Keeps spinning while it waits — the upload's progress and its off switch are
  // the same control, so neither costs the other its place.
  'cancel-upload': Loader2,
  dispatching: Loader2,
};

function resolveButtonState(
  hasText: boolean,
  isStreaming: boolean,
  uploadInFlight: boolean,
  editingQueueItem: boolean,
  commandPending: boolean
): ButtonState | null {
  // A command already on its way. It goes first because the composer still
  // holds the command's text (so a refusal cannot eat it), which would
  // otherwise resolve to a live Queue or Send that re-fires the same intent.
  if (commandPending) return 'dispatching';
  // An edit always offers a way out. Emptying the field used to resolve to
  // `null` — no button at all — while the banner still read "Editing message",
  // and a phone has no Escape key to rescue it with: the only exit left was the
  // row's X, which deletes the queued message.
  if (editingQueueItem) return hasText ? 'update' : 'cancel';
  if (isStreaming && hasText) return 'queue';
  // Only show stop for actual streaming — uploading alone should not show stop
  if (isStreaming) return 'stop';
  // An attachment upload IS this send, already in flight. Its progress and its
  // off switch are the same control: a Send the click cannot start would be a
  // lie, a Stop has no turn to stop, and a spinner with nothing behind it is
  // exactly how a hung upload used to trap the whole composer (DOR-494).
  if (uploadInFlight) return 'cancel-upload';
  if (hasText) return 'send';
  return null;
}

/** The click handler for the current button state, or `undefined` when none applies. */
function resolveOnClick(
  state: ButtonState,
  handlers: {
    onSubmit: () => void;
    onStop?: () => void;
    onQueue?: () => void;
    onSaveEdit?: () => void;
    onCancelEdit?: () => void;
    onCancelUpload?: () => void;
  }
): (() => void) | undefined {
  switch (state) {
    case 'send':
      return handlers.onSubmit;
    case 'stop':
      return handlers.onStop;
    case 'queue':
      return handlers.onQueue;
    case 'update':
      return handlers.onSaveEdit;
    case 'cancel':
      return handlers.onCancelEdit;
    case 'cancel-upload':
      return handlers.onCancelUpload;
    // 'dispatching' is a progress indicator, not a control.
    default:
      return undefined;
  }
}

/** Action button + dedicated stop button for the chat input. */
export function InputActionButton({
  hasText,
  isStreaming,
  commandPending = false,
  submitDisabled = false,
  editingQueueItem,
  queueDepth,
  isTouchOnly,
  onSubmit,
  onStop,
  onQueue,
  onSaveEdit,
  onCancelEdit,
  onCancelUpload,
  onSteer,
  onStage,
}: InputActionButtonProps) {
  const buttonState = resolveButtonState(
    hasText,
    isStreaming,
    onCancelUpload !== undefined,
    editingQueueItem,
    commandPending
  );
  // The send action is blocked while the target is not ready yet; other actions
  // are never blocked here.
  const sendBlocked = buttonState === 'send' && submitDisabled;
  const onClick =
    sendBlocked || buttonState === null
      ? undefined
      : resolveOnClick(buttonState, {
          onSubmit,
          onStop,
          onQueue,
          onSaveEdit,
          onCancelEdit,
          onCancelUpload,
        });
  // The send icon has to name the same gesture the Enter rule uses, or it
  // advertises a contract the keyboard does not honour (see `useIsTouchOnly`).
  const ActionIcon =
    buttonState === null
      ? null
      : buttonState === 'send' && isTouchOnly
        ? ArrowUp
        : BUTTON_ICON[buttonState];
  // Progress with nothing to press: rendered as a live region rather than a
  // disabled button, since several screen readers skip disabled controls
  // entirely and this is the only thing on screen saying the send is already
  // happening. An upload is not here — it is a real button that does something,
  // and it carries its own live region below.
  const isProgress = buttonState === 'dispatching';

  return (
    <>
      {/* Dedicated stop button — visible when streaming + text so the user can
          always stop without clearing input. Hidden when main button is already
          stop. Wrapped in AnimatePresence so the exit below actually runs; a
          bare conditional unmounts it instantly and the config was decoration. */}
      <AnimatePresence>
        {isStreaming && hasText && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={onStop}
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 shrink-0 rounded-lg p-1.5 transition-colors max-md:p-2"
            aria-label="Stop generating"
          >
            <Square className="size-(--size-icon-sm)" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* The alternates to Queue — Steer and Add context — sit to its LEFT so
          Queue stays the rightmost, primary tap target. Only in the queue state,
          and only when the agent supports at least one: an idle send never
          splits, and a queue-only runtime shows no caret at all. */}
      {buttonState === 'queue' && <DispositionMenu onSteer={onSteer} onStage={onStage} />}

      {/* The slot is always here, even at rest with nothing to offer. It used to
          appear with the first character, so the composer's right edge — and the
          text you were typing — jumped sideways the moment you started. The
          spacer mirrors the button's own box model rather than hard-coding a
          width, so it stays true under the icon-scale token. */}
      <div className="relative shrink-0">
        {/* The button's name says what it DOES ("Cancel upload"); this says what
            is HAPPENING. Both are needed: a reader who never tabs onto the
            control would otherwise get no announcement that the send is already
            under way, which is what the inert spinner used to provide. */}
        {buttonState === 'cancel-upload' && (
          <span role="status" className="sr-only">
            Uploading attachment
          </span>
        )}
        {isProgress && buttonState ? (
          <div
            role="status"
            className={cn('rounded-lg p-1.5 max-md:p-2', BUTTON_CONFIG[buttonState].className)}
          >
            <Loader2 className="size-(--size-icon-sm) animate-spin" aria-hidden="true" />
            <span className="sr-only">{BUTTON_CONFIG[buttonState].label}</span>
          </div>
        ) : buttonState && ActionIcon ? (
          <motion.button
            // Motion owns this element's opacity outright, so the blocked state
            // is expressed HERE and not as a class. An `opacity-50` beside an
            // animated `opacity: 1` is not a tie the stylesheet can win: motion
            // writes the value inline every frame, so every blocked send looked
            // fully live while being inert (DOR-850). One owner, no fight.
            animate={{ opacity: sendBlocked ? 0.5 : 1, scale: 1 }}
            // First paint takes the animate target directly: without this, a
            // button mounting into the blocked state paints fully live and
            // fades to dim over the transition, which reads as a flash.
            initial={false}
            transition={{ duration: 0.15 }}
            whileHover={!sendBlocked ? { scale: 1.1 } : undefined}
            whileTap={!sendBlocked ? { scale: 0.9 } : undefined}
            onClick={onClick}
            disabled={sendBlocked}
            type="button"
            className={cn(
              'focus-ring rounded-lg p-1.5 transition-colors max-md:p-2',
              BUTTON_CONFIG[buttonState].className,
              sendBlocked && 'pointer-events-none'
            )}
            aria-label={BUTTON_CONFIG[buttonState].label}
          >
            <ActionIcon
              className={cn(
                'size-(--size-icon-sm)',
                buttonState === 'cancel-upload' && 'animate-spin'
              )}
            />
          </motion.button>
        ) : (
          <div aria-hidden="true" data-testid="action-slot-spacer" className="p-1.5 max-md:p-2">
            <div className="size-(--size-icon-sm)" />
          </div>
        )}
        {queueDepth > 0 && buttonState === 'queue' && (
          <span className="bg-foreground text-background absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium">
            {queueDepth}
          </span>
        )}
      </div>
    </>
  );
}
