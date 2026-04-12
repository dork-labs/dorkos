import { useRef, useCallback, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { motion } from 'motion/react';
import { ArrowUp, CornerDownLeft, Square, X, Paperclip, Clock, Check } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';

export interface ChatInputHandle {
  focus: () => void;
  focusAt: (pos: number) => void;
}

type ButtonState = 'send' | 'stop' | 'queue' | 'update' | 'hidden';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Agent is streaming a response. Replaces the old isLoading prop. */
  isStreaming: boolean;
  /** File upload is in progress. */
  isUploading?: boolean;
  sessionBusy?: boolean;
  /** Currently editing a queued message item. */
  editingQueueItem?: boolean;
  /** Number of items currently in the message queue (for badge display). */
  queueDepth?: number;
  onStop?: () => void;
  /** Queue the current input for sending after streaming completes. */
  onQueue?: () => void;
  /** Save the queue item currently being edited. */
  onSaveEdit?: () => void;
  /** Cancel editing the current queue item and restore draft. */
  onCancelEdit?: () => void;
  onEscape?: () => void;
  onClear?: () => void;
  isPaletteOpen?: boolean;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onCommandSelect?: () => void;
  activeDescendantId?: string;
  onCursorChange?: (pos: number) => void;
  /** Callback when files are selected via the paperclip button. */
  onAttach?: (files: File[]) => void;
  /** Custom placeholder text for the textarea. Defaults to "Send a message...". */
  placeholder?: string;
  /** Overlay element rendered in place of the native placeholder (e.g. animated hints). */
  placeholderOverlay?: React.ReactNode;
  /** Navigate up through the message queue (shell-history style). */
  onQueueNavigateUp?: () => void;
  /** Navigate down through the message queue (shell-history style). */
  onQueueNavigateDown?: () => void;
  /** Whether the queue has items (enables arrow key navigation). */
  queueHasItems?: boolean;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    value,
    onChange,
    onSubmit,
    isStreaming,
    isUploading = false,
    sessionBusy = false,
    editingQueueItem = false,
    queueDepth = 0,
    onStop,
    onQueue,
    onSaveEdit,
    onCancelEdit,
    onEscape,
    onClear,
    isPaletteOpen,
    onArrowUp,
    onArrowDown,
    onCommandSelect,
    activeDescendantId,
    onCursorChange,
    onAttach,
    placeholder = 'Send a message...',
    placeholderOverlay,
    onQueueNavigateUp,
    onQueueNavigateDown,
    queueHasItems = false,
  },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastEscapeRef = useRef(0);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    focusAt: (pos: number) => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    },
  }));

  // Auto-focus on mount so the textarea is ready for input after AnimatePresence
  // transitions (e.g. returning from interactive tool-approval mode).
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const [isFocused, setIsFocused] = useState(false);
  const isMobile = useIsMobile();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape while streaming stops generation (highest priority — matches Claude Code CLI behavior)
      if (e.key === 'Escape' && isStreaming) {
        onStop?.();
        return;
      }

      // Escape while editing a queue item cancels the edit (priority over normal Escape)
      if (e.key === 'Escape' && editingQueueItem) {
        onCancelEdit?.();
        return;
      }

      if (e.key === 'Escape') {
        const now = Date.now();
        if (isPaletteOpen) {
          onEscape?.();
          lastEscapeRef.current = now;
        } else if (value.trim() && now - lastEscapeRef.current < 500) {
          onClear?.();
          lastEscapeRef.current = 0;
        } else {
          onEscape?.();
          lastEscapeRef.current = now;
        }
        return;
      }

      // --- Queue navigation (takes priority over palette when queue has items and palette is closed) ---
      if (!isPaletteOpen && queueHasItems) {
        if (e.key === 'ArrowUp') {
          const textarea = textareaRef.current;
          const isAtStart = !textarea || textarea.selectionStart === 0;
          const isEmpty = !value.trim();
          if (isEmpty || isAtStart) {
            e.preventDefault();
            onQueueNavigateUp?.();
            return;
          }
        }
        if (e.key === 'ArrowDown') {
          const textarea = textareaRef.current;
          const isAtEnd = !textarea || textarea.selectionStart === textarea.value.length;
          if (editingQueueItem && isAtEnd) {
            e.preventDefault();
            onQueueNavigateDown?.();
            return;
          }
        }
      }

      // --- Palette-open interceptions ---
      if (isPaletteOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onArrowDown?.();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onArrowUp?.();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onCommandSelect?.();
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          onCommandSelect?.();
          return;
        }
      }

      // --- Default behavior (palette closed) ---
      // Desktop: Enter submits/queues/saves; Shift+Enter for newline
      // Mobile: Enter inserts newline, submit via button only
      if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
        e.preventDefault();
        // Priority: edit save > queue > submit
        if (editingQueueItem && value.trim()) {
          onSaveEdit?.();
        } else if (isStreaming && value.trim()) {
          onQueue?.();
        } else if (!isStreaming && !sessionBusy && value.trim()) {
          onSubmit();
        }
      }
    },
    [
      isStreaming,
      isMobile,
      value,
      onSubmit,
      onStop,
      onEscape,
      onClear,
      isPaletteOpen,
      onArrowUp,
      onArrowDown,
      onCommandSelect,
      editingQueueItem,
      onQueue,
      onSaveEdit,
      onCancelEdit,
      queueHasItems,
      onQueueNavigateUp,
      onQueueNavigateDown,
      sessionBusy,
    ]
  );

  const handleFocus = useCallback(() => setIsFocused(true), []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (isPaletteOpen) {
      onEscape?.();
    }
  }, [isPaletteOpen, onEscape]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      onCursorChange?.(e.target.selectionStart);
      // Auto-resize textarea
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
      }
    },
    [onChange, onCursorChange]
  );

  const handleSelect = useCallback(() => {
    if (textareaRef.current) {
      onCursorChange?.(textareaRef.current.selectionStart);
    }
  }, [onCursorChange]);

  // Smoothly shrink textarea back to single-line height after submit clears value
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || value !== '') return;
    const currentHeight = textarea.scrollHeight;
    const targetHeight = 24; // matches min-h-[24px]
    if (currentHeight <= targetHeight) return;
    // Snapshot current height, enable transition, then animate to target
    textarea.style.height = `${currentHeight}px`;
    textarea.style.transition = 'height 200ms ease';
    requestAnimationFrame(() => {
      textarea.style.height = `${targetHeight}px`;
    });
    const onEnd = () => {
      textarea.style.transition = '';
      textarea.style.height = '';
    };
    textarea.addEventListener('transitionend', onEnd, { once: true });
    return () => textarea.removeEventListener('transitionend', onEnd);
  }, [value]);

  const hasText = value.trim().length > 0;
  // Combined loading flag: uploading files is also a "loading" state for submission
  const isLoading = isStreaming || isUploading;
  // Only server lock disables the textarea — streaming alone keeps it editable
  const isInputDisabled = sessionBusy;
  // Clear works whenever there's text, regardless of streaming state
  const showClear = hasText && !sessionBusy;

  const SendIcon = isMobile ? ArrowUp : CornerDownLeft;

  // Four-state button machine: the correct action depends on context
  const buttonState: ButtonState = (() => {
    if (editingQueueItem && hasText) return 'update';
    if (isStreaming && hasText) return 'queue';
    if (isLoading) return 'stop';
    if (hasText) return 'send';
    return 'hidden';
  })();
  const showButton = buttonState !== 'hidden';

  const buttonConfig = {
    send: {
      icon: SendIcon,
      className: 'bg-primary text-primary-foreground hover:bg-primary/90',
      label: 'Send message',
      onClick: onSubmit,
    },
    stop: {
      icon: Square,
      className: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      label: 'Stop generating',
      onClick: onStop,
    },
    queue: {
      icon: Clock,
      className: 'bg-muted text-muted-foreground hover:bg-muted/80',
      label: 'Queue message',
      onClick: onQueue,
    },
    update: {
      icon: Check,
      className: 'bg-primary text-primary-foreground hover:bg-primary/90',
      label: 'Save edit',
      onClick: onSaveEdit,
    },
    hidden: {
      icon: SendIcon,
      className: '',
      label: '',
      onClick: undefined,
    },
  } satisfies Record<
    ButtonState,
    { icon: React.ElementType; className: string; label: string; onClick: (() => void) | undefined }
  >;

  const config = buttonConfig[buttonState];
  const ButtonIcon = config.icon;

  return (
    <div className="flex flex-col gap-1.5">
      {sessionBusy && (
        <div className="px-1 text-xs text-amber-600 dark:text-amber-500">
          Session is busy. Please wait...
        </div>
      )}
      {editingQueueItem && (
        <div className="text-muted-foreground px-0.5 text-xs">
          Editing message{queueDepth > 0 ? ' \u2014' : ''}
        </div>
      )}
      <div
        className={cn(
          'border-input bg-background flex items-end gap-1.5 rounded-md border p-1.5 shadow-xs transition-[color,box-shadow]',
          isFocused && 'border-ring ring-ring/75 ring-[1px]',
          editingQueueItem && 'border-primary/40',
          !onAttach && 'pl-3'
        )}
      >
        {onAttach && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) onAttach(files);
                // Reset so the same file can be re-selected after removal
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-50"
              aria-label="Attach file"
            >
              <Paperclip className="size-4" />
            </button>
          </>
        )}
        <div className="relative min-h-[24px] flex-1">
          {!hasText && placeholderOverlay}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onSelect={handleSelect}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={
              isPaletteOpen
                ? activeDescendantId?.startsWith('file-')
                  ? 'file-palette-listbox'
                  : 'command-palette-listbox'
                : undefined
            }
            aria-expanded={isPaletteOpen ?? false}
            aria-activedescendant={isPaletteOpen ? activeDescendantId : undefined}
            placeholder={placeholderOverlay ? '' : placeholder}
            className="max-h-[200px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-sm focus:outline-none"
            rows={1}
            disabled={isInputDisabled}
          />
        </div>
        <motion.button
          animate={{ opacity: showClear ? 0.5 : 0, scale: showClear ? 1 : 0.8 }}
          transition={{ duration: 0.15 }}
          whileHover={showClear ? { opacity: 1 } : undefined}
          onClick={onClear}
          disabled={!showClear}
          type="button"
          className={cn(
            'text-muted-foreground hover:text-foreground shrink-0 rounded-lg p-1 transition-colors',
            !showClear && 'pointer-events-none'
          )}
          aria-label="Clear message"
        >
          <X className="size-(--size-icon-sm)" />
        </motion.button>
        {/* Dedicated stop button — visible when streaming + text (queue state) so the
            user can always stop without clearing input. Hidden when the main button is
            already the stop button (no text) to avoid redundancy. */}
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
        <div className="relative">
          <motion.button
            animate={{ opacity: showButton ? 1 : 0, scale: showButton ? 1 : 0.8 }}
            transition={{ duration: 0.15 }}
            whileHover={showButton && !sessionBusy ? { scale: 1.1 } : undefined}
            whileTap={showButton && !sessionBusy ? { scale: 0.9 } : undefined}
            onClick={config.onClick}
            disabled={!showButton || (buttonState === 'send' && sessionBusy)}
            className={cn(
              'shrink-0 rounded-lg p-1.5 transition-colors max-md:p-2',
              config.className,
              (!showButton || (buttonState === 'send' && sessionBusy)) &&
                'pointer-events-none opacity-50'
            )}
            aria-label={config.label}
          >
            <ButtonIcon className="size-(--size-icon-sm)" />
          </motion.button>
          {queueDepth > 0 && buttonState === 'queue' && (
            <span className="bg-foreground text-background absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium">
              {queueDepth}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
