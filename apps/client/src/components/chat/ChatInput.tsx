import { useRef, useCallback, useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { ArrowUp, CornerDownLeft, Square } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useIsMobile } from '../../hooks/use-is-mobile';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  onStop?: () => void;
  onEscape?: () => void;
  isPaletteOpen?: boolean;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onCommandSelect?: () => void;
  activeDescendantId?: string;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  isLoading,
  onStop,
  onEscape,
  isPaletteOpen,
  onArrowUp,
  onArrowDown,
  onCommandSelect,
  activeDescendantId,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const isMobile = useIsMobile();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape always fires (palette or no palette)
      if (e.key === 'Escape') {
        onEscape?.();
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
    [isLoading, isMobile, value, onSubmit, onEscape, isPaletteOpen, onArrowUp, onArrowDown, onCommandSelect]
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
      // Auto-resize textarea
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
      }
    },
    [onChange]
  );

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
  const SendIcon = isMobile ? ArrowUp : CornerDownLeft;
  const Icon = isLoading ? Square : SendIcon;

  return (
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
        role="combobox"
        aria-autocomplete="list"
        aria-controls="command-palette-listbox"
        aria-expanded={isPaletteOpen ?? false}
        aria-activedescendant={isPaletteOpen ? activeDescendantId : undefined}
        placeholder="Message Claude..."
        className="flex-1 resize-none bg-transparent py-0.5 text-sm focus:outline-none min-h-[24px] max-h-[200px]"
        rows={1}
        disabled={isLoading}
      />
      <motion.button
        animate={{ opacity: showButton ? 1 : 0, scale: showButton ? 1 : 0.8 }}
        transition={{ duration: 0.15 }}
        whileHover={showButton ? { scale: 1.1 } : undefined}
        whileTap={showButton ? { scale: 0.9 } : undefined}
        onClick={isLoading ? onStop : onSubmit}
        disabled={!showButton}
        className={cn(
          'shrink-0 rounded-lg p-1.5 max-md:p-2 transition-colors',
          isLoading
            ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
          !showButton && 'pointer-events-none'
        )}
        aria-label={isLoading ? 'Stop generating' : 'Send message'}
      >
        <Icon className="size-(--size-icon-sm)" />
      </motion.button>
    </div>
  );
}
