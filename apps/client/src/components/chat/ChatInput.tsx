import { useRef, useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CornerDownLeft, Square } from 'lucide-react';
import { cn } from '../../lib/utils';

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
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isLoading && value.trim()) {
          onSubmit();
        }
      }
    },
    [isLoading, value, onSubmit, onEscape, isPaletteOpen, onArrowUp, onArrowDown, onCommandSelect]
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

  const hasText = value.trim().length > 0;

  return (
    <div
      className={cn(
        'relative rounded-lg border transition-colors duration-150',
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
        className="w-full resize-none bg-transparent px-3 py-2 pr-10 text-sm focus:outline-none min-h-[40px] max-h-[200px]"
        rows={1}
        disabled={isLoading}
      />
      <div className="absolute right-2 bottom-1.5">
        <AnimatePresence mode="wait">
          {isLoading ? (
            <motion.button
              key="stop"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={onStop}
              className="rounded-md bg-destructive p-1.5 max-md:p-2.5 text-destructive-foreground hover:bg-destructive/90"
              aria-label="Stop generating"
            >
              <Square className="size-[--size-icon-sm]" />
            </motion.button>
          ) : hasText ? (
            <motion.button
              key="send"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              onClick={onSubmit}
              className="rounded-md bg-primary p-1.5 max-md:p-2.5 text-primary-foreground hover:bg-primary/90"
              aria-label="Send message"
            >
              <CornerDownLeft className="size-[--size-icon-sm]" />
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
