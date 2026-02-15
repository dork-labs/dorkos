import { useRef, useCallback, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { motion } from 'motion/react';
import { ArrowUp, CornerDownLeft, Square, X } from 'lucide-react';
import { cn, useIsMobile } from '@/layers/shared/lib';

export interface ChatInputHandle {
  focus: () => void;
  focusAt: (pos: number) => void;
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  sessionBusy?: boolean;
  onStop?: () => void;
  onEscape?: () => void;
  onClear?: () => void;
  isPaletteOpen?: boolean;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onCommandSelect?: () => void;
  activeDescendantId?: string;
  onCursorChange?: (pos: number) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  value,
  onChange,
  onSubmit,
  isLoading,
  sessionBusy = false,
  onStop,
  onEscape,
  onClear,
  isPaletteOpen,
  onArrowUp,
  onArrowDown,
  onCommandSelect,
  activeDescendantId,
  onCursorChange,
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  const [isFocused, setIsFocused] = useState(false);
  const isMobile = useIsMobile();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
      // Desktop: Enter submits, Shift+Enter for newline
      // Mobile: Enter inserts newline, submit via button only
      if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
        e.preventDefault();
        if (!isLoading && value.trim()) {
          onSubmit();
        }
      }
    },
    [isLoading, isMobile, value, onSubmit, onEscape, onClear, isPaletteOpen, onArrowUp, onArrowDown, onCommandSelect]
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
  const showButton = isLoading || hasText;
  const showClear = hasText && !isLoading && !sessionBusy;
  const SendIcon = isMobile ? ArrowUp : CornerDownLeft;
  const Icon = isLoading ? Square : SendIcon;
  const isDisabled = isLoading || sessionBusy;

  return (
    <div className="flex flex-col gap-1.5">
      {sessionBusy && (
        <div className="text-xs text-amber-600 dark:text-amber-500 px-1">
          Session is busy. Please wait...
        </div>
      )}
      <div
        className={cn(
          'flex items-end gap-1.5 rounded-xl border p-1.5 pl-3 transition-colors duration-150',
          isFocused ? 'border-ring' : 'border-border'
        )}
      >
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
          aria-controls={isPaletteOpen ? (activeDescendantId?.startsWith('file-') ? 'file-palette-listbox' : 'command-palette-listbox') : undefined}
          aria-expanded={isPaletteOpen ?? false}
          aria-activedescendant={isPaletteOpen ? activeDescendantId : undefined}
          placeholder="Message Claude..."
          className="flex-1 resize-none bg-transparent py-0.5 text-sm focus:outline-none min-h-[24px] max-h-[200px]"
          rows={1}
          disabled={isDisabled}
        />
      <motion.button
        animate={{ opacity: showClear ? 0.5 : 0, scale: showClear ? 1 : 0.8 }}
        transition={{ duration: 0.15 }}
        whileHover={showClear ? { opacity: 1 } : undefined}
        onClick={onClear}
        disabled={!showClear}
        type="button"
        className={cn(
          'shrink-0 rounded-lg p-1 transition-colors text-muted-foreground hover:text-foreground',
          !showClear && 'pointer-events-none'
        )}
        aria-label="Clear message"
      >
        <X className="size-(--size-icon-sm)" />
      </motion.button>
        <motion.button
          animate={{ opacity: showButton ? 1 : 0, scale: showButton ? 1 : 0.8 }}
          transition={{ duration: 0.15 }}
          whileHover={showButton && !sessionBusy ? { scale: 1.1 } : undefined}
          whileTap={showButton && !sessionBusy ? { scale: 0.9 } : undefined}
          onClick={isLoading ? onStop : onSubmit}
          disabled={!showButton || sessionBusy}
          className={cn(
            'shrink-0 rounded-lg p-1.5 max-md:p-2 transition-colors',
            isLoading
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
            (!showButton || sessionBusy) && 'pointer-events-none opacity-50'
          )}
          aria-label={isLoading ? 'Stop generating' : 'Send message'}
        >
          <Icon className="size-(--size-icon-sm)" />
        </motion.button>
      </div>
    </div>
  );
});
