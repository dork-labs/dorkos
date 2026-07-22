import { useRef, useCallback, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { motion } from 'motion/react';
import { X, Paperclip } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { useInputKeyboard } from './use-input-keyboard';
import { useTextareaResize } from './use-textarea-resize';
import { InputActionButton } from './InputActionButton';

export interface ChatInputHandle {
  focus: () => void;
  focusAt: (pos: number) => void;
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Agent is streaming a response. */
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
  /**
   * Whether the message can be sent. When `false`, the send button reads
   * disabled and does nothing while the input stays typeable — used when the
   * send target is not ready yet (e.g. the default agent's path has not resolved
   * from the registry). Defaults to `true`.
   */
  canSubmit?: boolean;
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
    canSubmit = true,
  },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const isMobile = useIsMobile();

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    focusAt: (pos: number) => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    },
  }));

  // Auto-focus on mount (e.g. returning from interactive tool-approval mode)
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useInputKeyboard({
    textareaRef,
    value,
    isStreaming,
    isMobile,
    sessionBusy,
    editingQueueItem,
    isPaletteOpen,
    queueHasItems,
    onSubmit,
    onStop,
    onEscape,
    onClear,
    onArrowUp,
    onArrowDown,
    onCommandSelect,
    onQueue,
    onSaveEdit,
    onCancelEdit,
    onQueueNavigateUp,
    onQueueNavigateDown,
  });

  const resize = useTextareaResize(textareaRef, value);

  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (isPaletteOpen) onEscape?.();
  }, [isPaletteOpen, onEscape]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      onCursorChange?.(e.target.selectionStart);
      resize();
    },
    [onChange, onCursorChange, resize]
  );

  const handleSelect = useCallback(() => {
    if (textareaRef.current) onCursorChange?.(textareaRef.current.selectionStart);
  }, [onCursorChange]);

  const hasText = value.trim().length > 0;
  const showClear = hasText && !sessionBusy;

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
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center rounded-md px-1.5 py-1 transition-colors disabled:opacity-50"
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
            // The visual placeholder may render as an overlay (AnimatedPlaceholder),
            // which empties the native placeholder attr — the aria-label keeps the
            // combobox's accessible name stable in both modes.
            aria-label={placeholder}
            placeholder={placeholderOverlay ? '' : placeholder}
            className="block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-sm focus:outline-none"
            rows={1}
            disabled={sessionBusy}
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
        <InputActionButton
          hasText={hasText}
          isStreaming={isStreaming}
          isUploading={isUploading}
          sessionBusy={sessionBusy}
          submitDisabled={!canSubmit}
          editingQueueItem={editingQueueItem}
          queueDepth={queueDepth}
          isMobile={isMobile}
          onSubmit={onSubmit}
          onStop={onStop}
          onQueue={onQueue}
          onSaveEdit={onSaveEdit}
        />
      </div>
    </div>
  );
});
