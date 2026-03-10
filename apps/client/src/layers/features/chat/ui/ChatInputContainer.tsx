import { useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useDropzone } from 'react-dropzone';
import type { RefObject } from 'react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { ChatStatusSection } from './ChatStatusSection';
import { FileChipBar } from './FileChipBar';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import type { useInputAutocomplete } from '../model/use-input-autocomplete';
import type { PendingFile } from '../model/use-file-upload';

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
  /** Files staged for upload. */
  pendingFiles: PendingFile[];
  /** Called when new files are selected via drop, paste, or the paperclip button. */
  onFilesSelected: (files: File[]) => void;
  /** Called when a pending file chip is dismissed. */
  onFileRemove: (id: string) => void;
  /** Whether an upload batch is in flight. */
  isUploading: boolean;
}

/** Container for chat input, autocomplete palettes, drag-and-drop, and status chips. */
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
  pendingFiles,
  onFilesSelected,
  onFileRemove,
  isUploading,
}: ChatInputContainerProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onFilesSelected(acceptedFiles);
      }
    },
    [onFilesSelected]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const items = Array.from(e.clipboardData.items);
      const files = items
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        onFilesSelected(files);
      }
    },
    [onFilesSelected]
  );

  return (
    <div
      {...getRootProps()}
      onPaste={handlePaste}
      className="chat-input-container bg-surface relative m-2 rounded-xl border p-2"
    >
      {/* Hidden dropzone input — react-dropzone requires this */}
      <input {...getInputProps()} />

      <AnimatePresence>
        {isDragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="bg-primary/10 border-primary absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed"
          >
            <p className="text-primary text-sm font-medium">Drop files to attach</p>
          </motion.div>
        )}
      </AnimatePresence>

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

      {pendingFiles.length > 0 && (
        <FileChipBar files={pendingFiles} onRemove={onFileRemove} />
      )}

      <ChatInput
        ref={chatInputRef}
        value={input}
        onChange={autocomplete.handleInputChange}
        onSubmit={handleSubmit}
        isLoading={status === 'streaming' || isUploading}
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
        onAttach={onFilesSelected}
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
