import { motion } from 'motion/react';
import { ArrowUp, CornerDownLeft, Square, Clock, Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

type ButtonState = 'send' | 'stop' | 'queue' | 'update' | 'cancel' | 'uploading' | 'dispatching';

interface InputActionButtonProps {
  hasText: boolean;
  isStreaming: boolean;
  isUploading: boolean;
  /** A dispatched native command has not settled — its text is still in the box. */
  commandPending?: boolean;
  sessionBusy: boolean;
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
}

const BUTTON_CONFIG = {
  send: {
    icon: null, // resolved at render time (tap vs Enter key)
    className: 'bg-primary text-primary-foreground hover:bg-primary/90',
    label: 'Send message',
  },
  stop: {
    icon: Square,
    className: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    label: 'Stop generating',
  },
  queue: {
    icon: Clock,
    className: 'bg-muted text-muted-foreground hover:bg-muted/80',
    label: 'Queue message',
  },
  update: {
    icon: Check,
    className: 'bg-primary text-primary-foreground hover:bg-primary/90',
    label: 'Save edit',
  },
  cancel: {
    icon: X,
    className: 'bg-muted text-muted-foreground hover:bg-muted/80',
    label: 'Cancel edit',
  },
  uploading: {
    icon: Loader2,
    className: 'bg-muted text-muted-foreground',
    label: 'Uploading attachment',
  },
  dispatching: {
    icon: Loader2,
    className: 'bg-muted text-muted-foreground',
    label: 'Running command',
  },
} satisfies Record<
  ButtonState,
  { icon: React.ElementType | null; className: string; label: string }
>;

function resolveButtonState(
  hasText: boolean,
  isStreaming: boolean,
  isUploading: boolean,
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
  // An attachment upload IS this send, already in flight. Show its progress
  // rather than a Send the click cannot start or a Stop with no turn to stop.
  if (isUploading) return 'uploading';
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
    // 'uploading' is a progress indicator, not a control.
    default:
      return undefined;
  }
}

/** Action button + dedicated stop button for the chat input. */
export function InputActionButton({
  hasText,
  isStreaming,
  isUploading,
  commandPending = false,
  sessionBusy,
  submitDisabled = false,
  editingQueueItem,
  queueDepth,
  isTouchOnly,
  onSubmit,
  onStop,
  onQueue,
  onSaveEdit,
  onCancelEdit,
}: InputActionButtonProps) {
  const buttonState = resolveButtonState(
    hasText,
    isStreaming,
    isUploading,
    editingQueueItem,
    commandPending
  );
  // The icon has to name the same gesture the Enter rule uses, or it advertises
  // a contract the keyboard does not honour (see `useIsTouchOnly`).
  const SendIcon = isTouchOnly ? ArrowUp : CornerDownLeft;

  // The send action is blocked while the session is busy or the target is not
  // ready yet; other actions are never blocked here.
  const sendBlocked = buttonState === 'send' && (sessionBusy || submitDisabled);
  const onClick =
    sendBlocked || buttonState === null
      ? undefined
      : resolveOnClick(buttonState, { onSubmit, onStop, onQueue, onSaveEdit, onCancelEdit });
  const ActionIcon =
    buttonState === null
      ? null
      : buttonState === 'send'
        ? SendIcon
        : BUTTON_CONFIG[buttonState].icon!;
  // Progress, not a control: rendered as a live region rather than a disabled
  // button, since several screen readers skip disabled controls entirely and
  // these are the only things on screen saying the send is already happening.
  const isProgress = buttonState === 'uploading' || buttonState === 'dispatching';

  return (
    <>
      {/* Dedicated stop button — visible when streaming + text so the user can
          always stop without clearing input. Hidden when main button is already stop. */}
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

      {isProgress && (
        <div
          role="status"
          className={cn(
            'shrink-0 rounded-lg p-1.5 max-md:p-2',
            BUTTON_CONFIG[buttonState].className
          )}
        >
          <Loader2 className="size-(--size-icon-sm) animate-spin" aria-hidden="true" />
          <span className="sr-only">{BUTTON_CONFIG[buttonState].label}</span>
        </div>
      )}

      {buttonState && !isProgress && ActionIcon && (
        <div className="relative">
          <motion.button
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.15 }}
            whileHover={!sendBlocked ? { scale: 1.1 } : undefined}
            whileTap={!sendBlocked ? { scale: 0.9 } : undefined}
            onClick={onClick}
            disabled={sendBlocked}
            className={cn(
              'shrink-0 rounded-lg p-1.5 transition-colors max-md:p-2',
              BUTTON_CONFIG[buttonState].className,
              sendBlocked && 'pointer-events-none opacity-50'
            )}
            aria-label={BUTTON_CONFIG[buttonState].label}
          >
            <ActionIcon className="size-(--size-icon-sm)" />
          </motion.button>
          {queueDepth > 0 && buttonState === 'queue' && (
            <span className="bg-foreground text-background absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium">
              {queueDepth}
            </span>
          )}
        </div>
      )}
    </>
  );
}
