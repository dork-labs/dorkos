import { AnimatePresence } from 'motion/react';
import type { RefObject } from 'react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { ChatStatusSection } from './ChatStatusSection';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import type { useInputAutocomplete } from '../model/use-input-autocomplete';

interface ChatInputContainerProps {
  chatInputRef: RefObject<ChatInputHandle | null>;
  input: string;
  autocomplete: ReturnType<typeof useInputAutocomplete>;
  handleSubmit: () => void;
  status: 'idle' | 'streaming' | 'error';
  sessionBusy: boolean;
  stop: () => void;
  setInput: (value: string) => void;
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
}

/** Container for chat input, autocomplete palettes, and status chips. */
export function ChatInputContainer({
  chatInputRef,
  input,
  autocomplete,
  handleSubmit,
  status,
  sessionBusy,
  stop,
  setInput,
  sessionId,
  sessionStatus,
}: ChatInputContainerProps) {
  return (
    <div className="chat-input-container bg-surface relative m-2 rounded-xl border p-2">
      <AnimatePresence>
        {autocomplete.commands.show && (
          <CommandPalette
            filteredCommands={autocomplete.commands.filtered}
            selectedIndex={autocomplete.commands.selectedIndex}
            onSelect={autocomplete.handleCommandSelect}
          />
        )}
        {autocomplete.files.show && (
          <FilePalette
            filteredFiles={autocomplete.files.filtered}
            selectedIndex={autocomplete.files.selectedIndex}
            onSelect={autocomplete.handleFileSelect}
          />
        )}
      </AnimatePresence>

      <ChatInput
        ref={chatInputRef}
        value={input}
        onChange={autocomplete.handleInputChange}
        onSubmit={handleSubmit}
        isLoading={status === 'streaming'}
        sessionBusy={sessionBusy}
        onStop={stop}
        onEscape={autocomplete.dismissPalettes}
        onClear={() => {
          setInput('');
          autocomplete.dismissPalettes();
        }}
        isPaletteOpen={autocomplete.isPaletteOpen}
        onArrowUp={autocomplete.handleArrowUp}
        onArrowDown={autocomplete.handleArrowDown}
        onCommandSelect={autocomplete.handleKeyboardSelect}
        activeDescendantId={autocomplete.activeDescendantId}
        onCursorChange={autocomplete.handleCursorChange}
      />

      <ChatStatusSection
        sessionId={sessionId}
        sessionStatus={sessionStatus}
        isStreaming={status === 'streaming'}
        onChipClick={autocomplete.handleChipClick}
      />
    </div>
  );
}
