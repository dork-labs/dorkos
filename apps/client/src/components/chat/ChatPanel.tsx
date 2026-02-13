import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useChatSession } from '../../hooks/use-chat-session';
import { useCommands } from '../../hooks/use-commands';
import { useTaskState } from '../../hooks/use-task-state';
import { useSessionId } from '../../hooks/use-session-id';
import { useSessionStatus } from '../../hooks/use-session-status';
import { useDirectoryState } from '../../hooks/use-directory-state';
import { fuzzyMatch } from '../../lib/fuzzy-match';
import { MessageList } from './MessageList';
import type { MessageListHandle, ScrollState } from './MessageList';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { TaskListPanel } from './TaskListPanel';
import { CommandPalette } from '../commands/CommandPalette';
import { FilePalette } from '../files/FilePalette';
import type { FileEntry } from '../files/FilePalette';
import { ShortcutChips } from './ShortcutChips';
import { StatusLine } from '../status/StatusLine';
import { useFiles } from '../../hooks/use-files';
import { useAppStore } from '../../stores/app-store';
import type { CommandEntry } from '@lifeos/shared/types';

interface ChatPanelProps {
  sessionId: string;
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
}

export function ChatPanel({ sessionId, transformContent }: ChatPanelProps) {
  const [, setSessionId] = useSessionId();
  const messageListRef = useRef<MessageListHandle>(null);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const taskState = useTaskState(sessionId);
  const { messages, input, setInput, handleSubmit, status, error, stop, isLoadingHistory, sessionStatus, streamStartTime, estimatedTokens, isTextStreaming } =
    useChatSession(sessionId, {
      transformContent,
      onTaskEvent: taskState.handleTaskEvent,
      onSessionIdChange: setSessionId,
    });
  const { permissionMode } = useSessionStatus(sessionId, sessionStatus, status === 'streaming');
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [slashTriggerPos, setSlashTriggerPos] = useState(-1);

  // File autocomplete state
  const [showFiles, setShowFiles] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
  const [fileTriggerPos, setFileTriggerPos] = useState(-1);
  const [cursorPos, setCursorPos] = useState(0);

  // Scroll overlay state (Tasks #7, #8, #9)
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevMessageCountRef = useRef(messages.length);

  const handleScrollStateChange = useCallback((state: ScrollState) => {
    setIsAtBottom(state.isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
    setIsAtBottom(true);
    setHasNewMessages(false);
  }, []);

  // Detect new messages arriving when user is scrolled up
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (messages.length > prevCount && !isAtBottom) {
      setHasNewMessages(true);
    }
  }, [messages.length, isAtBottom]);

  // Reset hasNewMessages when user scrolls to bottom
  useEffect(() => {
    if (isAtBottom) {
      setHasNewMessages(false);
    }
  }, [isAtBottom]);

  const showShortcutChips = useAppStore((s) => s.showShortcutChips);
  const [cwd] = useDirectoryState();
  const { data: registry } = useCommands(cwd);
  const allCommands = registry?.commands ?? [];
  const { data: fileList } = useFiles(cwd);

  const filteredCommands = useMemo(() => {
    if (!commandQuery) return allCommands;
    return allCommands
      .map((cmd) => {
        const searchText = `${cmd.fullCommand} ${cmd.description}`;
        const result = fuzzyMatch(commandQuery, searchText);
        return { cmd, ...result };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.cmd);
  }, [allCommands, commandQuery]);

  // Build FileEntry list from raw file paths (extract directories as unique prefixes)
  const allFileEntries = useMemo(() => {
    if (!fileList?.files) return [];
    const entries: FileEntry[] = [];
    const seenDirs = new Set<string>();
    for (const filePath of fileList.files) {
      const lastSlash = filePath.lastIndexOf('/');
      const directory = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
      const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
      entries.push({ path: filePath, filename, directory, isDirectory: false });
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/') + '/';
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({
            path: dir,
            filename: parts[i - 1] + '/',
            directory: i > 1 ? parts.slice(0, i - 1).join('/') + '/' : '',
            isDirectory: true,
          });
        }
      }
    }
    return entries;
  }, [fileList]);

  const filteredFiles = useMemo(() => {
    if (!showFiles) return [];
    if (!fileQuery) return allFileEntries.slice(0, 50).map((e) => ({ ...e, indices: [] as number[] }));
    return allFileEntries
      .map((entry) => ({ ...entry, ...fuzzyMatch(fileQuery, entry.path) }))
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }, [allFileEntries, fileQuery, showFiles]);

  // Reset selectedIndex when filter changes or palette opens/closes
  useEffect(() => {
    setSelectedIndex(0);
  }, [commandQuery, showCommands]);

  useEffect(() => {
    setFileSelectedIndex(0);
  }, [fileQuery, showFiles]);

  // Clamp selectedIndex when filteredCommands shrinks
  useEffect(() => {
    if (filteredCommands.length > 0 && selectedIndex >= filteredCommands.length) {
      setSelectedIndex(filteredCommands.length - 1);
    }
  }, [filteredCommands.length, selectedIndex]);

  // Clamp fileSelectedIndex when filteredFiles shrinks
  useEffect(() => {
    if (filteredFiles.length > 0 && fileSelectedIndex >= filteredFiles.length) {
      setFileSelectedIndex(filteredFiles.length - 1);
    }
  }, [filteredFiles.length, fileSelectedIndex]);

  function detectTrigger(value: string, cursor: number) {
    const textToCursor = value.slice(0, cursor);

    // Check for @ file trigger first
    const fileMatch = textToCursor.match(/(^|\s)@([\w.\/:-]*)$/);
    if (fileMatch) {
      setShowFiles(true);
      setFileQuery(fileMatch[2]);
      setFileTriggerPos((fileMatch.index ?? 0) + fileMatch[1].length);
      setShowCommands(false);
      return;
    }

    // Check for / command trigger
    const cmdMatch = textToCursor.match(/(^|\s)\/([\w:-]*)$/);
    if (cmdMatch) {
      setShowCommands(true);
      setCommandQuery(cmdMatch[2]);
      setSlashTriggerPos((cmdMatch.index ?? 0) + cmdMatch[1].length);
      setShowFiles(false);
      return;
    }

    setShowFiles(false);
    setShowCommands(false);
  }

  function handleInputChange(value: string) {
    setInput(value);
    detectTrigger(value, cursorPos || value.length);
  }

  const handleCursorChange = useCallback((pos: number) => {
    setCursorPos(pos);
    detectTrigger(input, pos);
  }, [input]);

  function handleCommandSelect(cmd: CommandEntry) {
    const before = input.slice(0, slashTriggerPos);
    setInput(before + cmd.fullCommand + ' ');
    setShowCommands(false);
  }

  function handleFileSelect(entry: FileEntry) {
    const before = input.slice(0, fileTriggerPos);
    const after = input.slice(fileTriggerPos + 1 + fileQuery.length); // +1 for @
    if (entry.isDirectory) {
      const newValue = before + '@' + entry.path + after;
      setInput(newValue);
      const newCursor = before.length + 1 + entry.path.length;
      setCursorPos(newCursor);
      setFileQuery(entry.path);
      setFileSelectedIndex(0);
    } else {
      setInput(before + '@' + entry.path + ' ' + after);
      setShowFiles(false);
    }
  }

  const handleArrowDown = useCallback(() => {
    if (showFiles) {
      setFileSelectedIndex((prev) =>
        filteredFiles.length === 0 ? 0 : (prev + 1) % filteredFiles.length
      );
    } else {
      setSelectedIndex((prev) =>
        filteredCommands.length === 0 ? 0 : (prev + 1) % filteredCommands.length
      );
    }
  }, [showFiles, filteredFiles.length, filteredCommands.length]);

  const handleArrowUp = useCallback(() => {
    if (showFiles) {
      setFileSelectedIndex((prev) =>
        filteredFiles.length === 0 ? 0 : (prev - 1 + filteredFiles.length) % filteredFiles.length
      );
    } else {
      setSelectedIndex((prev) =>
        filteredCommands.length === 0
          ? 0
          : (prev - 1 + filteredCommands.length) % filteredCommands.length
      );
    }
  }, [showFiles, filteredFiles.length, filteredCommands.length]);

  const handleKeyboardSelect = useCallback(() => {
    if (showFiles) {
      if (filteredFiles.length > 0 && fileSelectedIndex < filteredFiles.length) {
        handleFileSelect(filteredFiles[fileSelectedIndex]);
      } else {
        setShowFiles(false);
      }
    } else if (showCommands) {
      if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
        handleCommandSelect(filteredCommands[selectedIndex]);
      } else {
        setShowCommands(false);
      }
    }
  }, [showFiles, showCommands, filteredFiles, fileSelectedIndex, filteredCommands, selectedIndex]);

  const handleChipClick = useCallback((trigger: string) => {
    const existingTrigger = input.match(/(^|\s)([/@])([\w.\/:-]*)$/);
    let newValue: string;

    if (existingTrigger) {
      const triggerChar = existingTrigger[2];
      const queryText = existingTrigger[3];
      const triggerStart = (existingTrigger.index ?? 0) + existingTrigger[1].length;

      if (triggerChar === trigger && !queryText) {
        // Toggle: same chip clicked again with no query — remove trigger and close palette
        const prefix = input.slice(0, triggerStart);
        // Also remove trailing space we may have added before the trigger
        newValue = prefix.endsWith(' ') && triggerStart > 0 ? prefix.slice(0, -1) : prefix;
        setInput(newValue);
        setShowFiles(false);
        setShowCommands(false);
        requestAnimationFrame(() => chatInputRef.current?.focusAt(newValue.length));
        return;
      }
      // Different trigger or has query text — replace with new trigger
      newValue = input.slice(0, triggerStart) + trigger;
    } else if (input.length > 0 && !input.endsWith(' ')) {
      newValue = input + ' ' + trigger;
    } else {
      newValue = input + trigger;
    }

    setInput(newValue);
    detectTrigger(newValue, newValue.length);
    // Focus textarea with cursor after the trigger so typing filters immediately
    requestAnimationFrame(() => chatInputRef.current?.focusAt(newValue.length));
  }, [input, setInput]);

  const isPaletteOpen = showCommands || showFiles;

  const activeDescendantId = showFiles && filteredFiles.length > 0
    ? `file-item-${fileSelectedIndex}`
    : showCommands && filteredCommands.length > 0
      ? `command-item-${selectedIndex}`
      : undefined;

  return (
    <div className="flex flex-col h-full">
      <div className="relative flex-1 min-h-0">
        {isLoadingHistory ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <div className="flex gap-1">
                <span className="h-2 w-2 rounded-full bg-muted-foreground" style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: '0s' }} />
                <span className="h-2 w-2 rounded-full bg-muted-foreground" style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: '0.2s' }} />
                <span className="h-2 w-2 rounded-full bg-muted-foreground" style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: '0.4s' }} />
              </div>
              Loading conversation...
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-muted-foreground text-base">Start a conversation</p>
              <p className="text-muted-foreground/60 text-sm mt-2">Type a message below to begin</p>
            </div>
          </div>
        ) : (
          <MessageList
            ref={messageListRef}
            messages={messages}
            sessionId={sessionId}
            status={status}
            isTextStreaming={isTextStreaming}
            onScrollStateChange={handleScrollStateChange}
            streamStartTime={streamStartTime}
            estimatedTokens={estimatedTokens}
            permissionMode={permissionMode}
          />
        )}

        {/* "New messages" pill — centered above scroll button */}
        <AnimatePresence>
          {hasNewMessages && !isAtBottom && (
            <motion.button
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.2 }}
              onClick={scrollToBottom}
              className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-foreground text-background text-xs font-medium px-3 py-1.5 shadow-sm cursor-pointer hover:bg-foreground/90 transition-colors"
              role="status"
              aria-live="polite"
            >
              New messages
            </motion.button>
          )}
        </AnimatePresence>

        {/* Scroll-to-bottom button — right-aligned, fixed above input */}
        <AnimatePresence>
          {!isAtBottom && messages.length > 0 && !isLoadingHistory && (
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.15 }}
              onClick={scrollToBottom}
              className="absolute bottom-4 right-4 rounded-full bg-background border shadow-sm p-2 hover:shadow-md transition-shadow"
              aria-label="Scroll to bottom"
            >
              <ArrowDown className="size-(--size-icon-md)" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <TaskListPanel
        tasks={taskState.tasks}
        activeForm={taskState.activeForm}
        isCollapsed={taskState.isCollapsed}
        onToggleCollapse={taskState.toggleCollapse}
      />

      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="chat-input-container relative border-t p-4">
        <AnimatePresence>
          {showCommands && (
            <CommandPalette
              filteredCommands={filteredCommands}
              selectedIndex={selectedIndex}
              onSelect={handleCommandSelect}
            />
          )}
          {showFiles && (
            <FilePalette
              filteredFiles={filteredFiles}
              selectedIndex={fileSelectedIndex}
              onSelect={handleFileSelect}
            />
          )}
        </AnimatePresence>

        <ChatInput
          ref={chatInputRef}
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isLoading={status === 'streaming'}
          onStop={stop}
          onEscape={() => { setShowCommands(false); setShowFiles(false); }}
          onClear={() => { setInput(''); setShowCommands(false); setShowFiles(false); }}
          isPaletteOpen={isPaletteOpen}
          onArrowUp={handleArrowUp}
          onArrowDown={handleArrowDown}
          onCommandSelect={handleKeyboardSelect}
          activeDescendantId={activeDescendantId}
          onCursorChange={handleCursorChange}
        />

        <AnimatePresence>
          {showShortcutChips && (
            <ShortcutChips onChipClick={handleChipClick} />
          )}
        </AnimatePresence>

        <StatusLine
          sessionId={sessionId}
          sessionStatus={sessionStatus}
          isStreaming={status === 'streaming'}
        />
      </div>
    </div>
  );
}
