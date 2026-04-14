import { motion } from 'motion/react';
import { ArrowUp, CornerDownLeft, Square, Clock, Check } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

type ButtonState = 'send' | 'stop' | 'queue' | 'update';

interface InputActionButtonProps {
  hasText: boolean;
  isStreaming: boolean;
  isUploading: boolean;
  sessionBusy: boolean;
  editingQueueItem: boolean;
  queueDepth: number;
  isMobile: boolean;
  onSubmit: () => void;
  onStop?: () => void;
  onQueue?: () => void;
  onSaveEdit?: () => void;
}

const BUTTON_CONFIG = {
  send: {
    icon: null, // resolved at render time (mobile vs desktop)
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
} satisfies Record<
  ButtonState,
  { icon: React.ElementType | null; className: string; label: string }
>;

function resolveButtonState(
  hasText: boolean,
  isStreaming: boolean,
  isUploading: boolean,
  editingQueueItem: boolean
): ButtonState | null {
  if (editingQueueItem && hasText) return 'update';
  if (isStreaming && hasText) return 'queue';
  // Only show stop for actual streaming — uploading alone should not show stop
  if (isStreaming) return 'stop';
  if (hasText && !isUploading) return 'send';
  return null;
}

/** Action button + dedicated stop button for the chat input. */
export function InputActionButton({
  hasText,
  isStreaming,
  isUploading,
  sessionBusy,
  editingQueueItem,
  queueDepth,
  isMobile,
  onSubmit,
  onStop,
  onQueue,
  onSaveEdit,
}: InputActionButtonProps) {
  const buttonState = resolveButtonState(hasText, isStreaming, isUploading, editingQueueItem);
  const SendIcon = isMobile ? ArrowUp : CornerDownLeft;

  const onClick =
    buttonState === 'send'
      ? onSubmit
      : buttonState === 'stop'
        ? onStop
        : buttonState === 'queue'
          ? onQueue
          : buttonState === 'update'
            ? onSaveEdit
            : undefined;

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

      {buttonState && (
        <div className="relative">
          <motion.button
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.15 }}
            whileHover={!sessionBusy ? { scale: 1.1 } : undefined}
            whileTap={!sessionBusy ? { scale: 0.9 } : undefined}
            onClick={onClick}
            disabled={buttonState === 'send' && sessionBusy}
            className={cn(
              'shrink-0 rounded-lg p-1.5 transition-colors max-md:p-2',
              BUTTON_CONFIG[buttonState].className,
              buttonState === 'send' && sessionBusy && 'pointer-events-none opacity-50'
            )}
            aria-label={BUTTON_CONFIG[buttonState].label}
          >
            {buttonState === 'send' ? (
              <SendIcon className="size-(--size-icon-sm)" />
            ) : (
              (() => {
                const Icon = BUTTON_CONFIG[buttonState].icon!;
                return <Icon className="size-(--size-icon-sm)" />;
              })()
            )}
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
