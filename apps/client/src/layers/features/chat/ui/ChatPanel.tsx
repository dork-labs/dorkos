import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { PanInfo } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useChatSession } from '../model/use-chat-session';
import { useCommands } from '@/layers/entities/command';
import { useTaskState } from '../model/use-task-state';
import { useCommandPalette } from '../model/use-command-palette';
import { useFileAutocomplete } from '../model/use-file-autocomplete';
import { useSessionId, useSessionStatus, useDirectoryState } from '@/layers/entities/session';
import { useIsMobile, useInteractiveShortcuts, useAppStore } from '@/layers/shared/model';
import { playNotificationSound } from '@/layers/shared/lib';
import { MessageList } from './MessageList';
import type { MessageListHandle, ScrollState } from './MessageList';
import { ChatInput } from './ChatInput';
import type { ChatInputHandle } from './ChatInput';
import { TaskListPanel } from './TaskListPanel';
import { CelebrationOverlay } from './CelebrationOverlay';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import type { FileEntry } from '@/layers/features/files';
import { ShortcutChips } from './ShortcutChips';
import { DragHandle } from './DragHandle';
import { StatusLine } from '@/layers/features/status';
import { useFiles } from '@/layers/features/files';
import { useCelebrations } from '../model/use-celebrations';
import type { InteractiveToolHandle } from './MessageItem';
import type { TaskUpdateEvent } from '@dorkos/shared/types';

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
  const celebrations = useCelebrations();
  const enableNotificationSound = useAppStore((s) => s.enableNotificationSound);

  const handleTaskEventWithCelebrations = useCallback(
    (event: TaskUpdateEvent) => {
      taskState.handleTaskEvent(event);
      const projectedTasks = taskState.tasks.map((t) =>
        t.id === event.task.id ? { ...t, ...event.task } : t
      );
      celebrations.handleTaskEvent(event, projectedTasks);
    },
    [taskState, celebrations]
  );

  const {
    messages,
    input,
    setInput,
    handleSubmit,
    status,
    error,
    sessionBusy,
    stop,
    isLoadingHistory,
    sessionStatus,
    streamStartTime,
    estimatedTokens,
    isTextStreaming,
    isWaitingForUser,
    waitingType,
    activeInteraction,
  } = useChatSession(sessionId, {
    transformContent,
    onTaskEvent: handleTaskEventWithCelebrations,
    onSessionIdChange: setSessionId,
    onStreamingDone: useCallback(() => {
      if (enableNotificationSound) {
        playNotificationSound();
      }
    }, [enableNotificationSound]),
  });
  const { permissionMode } = useSessionStatus(sessionId, sessionStatus, status === 'streaming');

  // Interactive tool shortcut wiring
  const activeToolHandleRef = useRef<InteractiveToolHandle | null>(null);
  const [focusedOptionIndex, setFocusedOptionIndex] = useState(0);
  const [activeOptionCount, setActiveOptionCount] = useState(0);

  const handleToolRef = useCallback((handle: InteractiveToolHandle | null) => {
    activeToolHandleRef.current = handle;
    setActiveOptionCount(handle && 'getOptionCount' in handle ? handle.getOptionCount() : 0);
  }, []);

  useEffect(() => {
    setFocusedOptionIndex(0);
    setActiveOptionCount(0);
  }, [activeInteraction?.toolCallId]);

  const activeInteractionForShortcuts = useMemo(() => {
    if (!activeInteraction) return null;
    return {
      type: activeInteraction.interactiveType as 'approval' | 'question',
      toolCallId: activeInteraction.toolCallId,
    };
  }, [activeInteraction]);

  useInteractiveShortcuts({
    activeInteraction: activeInteractionForShortcuts,
    onApprove: useCallback(() => {
      const handle = activeToolHandleRef.current;
      if (handle && 'approve' in handle) handle.approve();
    }, []),
    onDeny: useCallback(() => {
      const handle = activeToolHandleRef.current;
      if (handle && 'deny' in handle) handle.deny();
    }, []),
    onToggleOption: useCallback((index: number) => {
      const handle = activeToolHandleRef.current;
      if (handle && 'toggleOption' in handle) {
        handle.toggleOption(index);
        setFocusedOptionIndex(index);
      }
    }, []),
    onNavigateOption: useCallback((direction: 'up' | 'down') => {
      setFocusedOptionIndex((prev) => {
        const handle = activeToolHandleRef.current;
        const count = handle && 'getOptionCount' in handle ? handle.getOptionCount() : 0;
        if (count === 0) return prev;
        if (direction === 'up') return prev <= 0 ? count - 1 : prev - 1;
        return prev >= count - 1 ? 0 : prev + 1;
      });
    }, []),
    onNavigateQuestion: useCallback((direction: 'prev' | 'next') => {
      const handle = activeToolHandleRef.current;
      if (handle && 'navigateQuestion' in handle) {
        handle.navigateQuestion(direction);
        setFocusedOptionIndex(0);
        setActiveOptionCount(handle.getOptionCount());
      }
    }, []),
    onSubmit: useCallback(() => {
      const handle = activeToolHandleRef.current;
      if (handle && 'submit' in handle) handle.submit();
    }, []),
    optionCount: activeOptionCount,
    focusedIndex: focusedOptionIndex,
  });

  const [cursorPos, setCursorPos] = useState(0);

  // Scroll overlay state
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

  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (messages.length > prevCount && !isAtBottom) {
      setHasNewMessages(true);
    }
  }, [messages.length, isAtBottom]);

  useEffect(() => {
    if (isAtBottom) {
      setHasNewMessages(false);
    }
  }, [isAtBottom]);

  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [showHint, setShowHint] = useState(() => {
    if (!isMobile) return false;
    const count = parseInt(localStorage.getItem('dorkos-gesture-hint-count') || '0', 10);
    return count < 3;
  });

  useEffect(() => {
    if (!showHint) return;
    const timer = setTimeout(() => {
      setShowHint(false);
      const count = parseInt(localStorage.getItem('dorkos-gesture-hint-count') || '0', 10);
      localStorage.setItem('dorkos-gesture-hint-count', String(count + 1));
    }, 4000);
    return () => clearTimeout(timer);
  }, [showHint]);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    const count = parseInt(localStorage.getItem('dorkos-gesture-hint-count') || '0', 10);
    localStorage.setItem('dorkos-gesture-hint-count', String(count + 1));
  }, []);

  const SWIPE_THRESHOLD = 80;
  const VELOCITY_THRESHOLD = 500;
  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const { offset, velocity } = info;
    if (offset.y > SWIPE_THRESHOLD || velocity.y > VELOCITY_THRESHOLD) {
      setCollapsed(true);
    } else if (offset.y < -SWIPE_THRESHOLD || velocity.y < -VELOCITY_THRESHOLD) {
      setCollapsed(false);
    }
  };

  const setIsStreaming = useAppStore((s) => s.setIsStreaming);
  const setIsWaitingForUser = useAppStore((s) => s.setIsWaitingForUser);
  const setActiveForm = useAppStore((s) => s.setActiveForm);

  useEffect(() => {
    setIsStreaming(status === 'streaming');
    return () => setIsStreaming(false);
  }, [status, setIsStreaming]);

  useEffect(() => {
    setIsWaitingForUser(isWaitingForUser);
    return () => setIsWaitingForUser(false);
  }, [isWaitingForUser, setIsWaitingForUser]);

  useEffect(() => {
    setActiveForm(taskState.activeForm);
    return () => setActiveForm(null);
  }, [taskState.activeForm, setActiveForm]);

  const showShortcutChips = useAppStore((s) => s.showShortcutChips);
  const [cwd] = useDirectoryState();
  const { data: registry } = useCommands(cwd);
  const allCommands = useMemo(() => registry?.commands ?? [], [registry]);
  const { data: fileList } = useFiles(cwd);

  // Build FileEntry list from raw file paths
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

  const cmdPalette = useCommandPalette({
    commands: allCommands,
    input,
    cursorPos,
  });

  const fileComplete = useFileAutocomplete({
    fileEntries: allFileEntries,
    input,
    cursorPos,
  });

  function detectTrigger(value: string, cursor: number) {
    // Check @ file trigger first
    if (fileComplete.detectFileTrigger(value, cursor)) {
      cmdPalette.setShowCommands(false);
      return;
    }
    // Then / command trigger
    if (cmdPalette.detectCommandTrigger(value, cursor)) {
      fileComplete.setShowFiles(false);
      return;
    }
    fileComplete.setShowFiles(false);
    cmdPalette.setShowCommands(false);
  }

  function handleInputChange(value: string) {
    setInput(value);
    detectTrigger(value, cursorPos || value.length);
  }

  const handleCursorChange = useCallback(
    (pos: number) => {
      setCursorPos(pos);
      detectTrigger(input, pos);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detectTrigger is component-scoped
    [input]
  );

  function handleCommandSelect(cmd: import('@dorkos/shared/types').CommandEntry) {
    const newValue = cmdPalette.handleCommandSelect(cmd);
    setInput(newValue);
  }

  function handleFileSelect(entry: FileEntry) {
    const result = fileComplete.handleFileSelect(entry);
    setInput(result.newValue);
    if (result.newCursorPos !== undefined) {
      setCursorPos(result.newCursorPos);
    }
  }

  const handleArrowDown = useCallback(() => {
    if (fileComplete.showFiles) {
      fileComplete.handleArrowDown();
    } else {
      cmdPalette.handleArrowDown();
    }
  }, [fileComplete.showFiles, fileComplete.handleArrowDown, cmdPalette.handleArrowDown]);

  const handleArrowUp = useCallback(() => {
    if (fileComplete.showFiles) {
      fileComplete.handleArrowUp();
    } else {
      cmdPalette.handleArrowUp();
    }
  }, [fileComplete.showFiles, fileComplete.handleArrowUp, cmdPalette.handleArrowUp]);

  const handleKeyboardSelect = useCallback(() => {
    if (fileComplete.showFiles) {
      const result = fileComplete.handleKeyboardSelect();
      if (result) {
        setInput(result.newValue);
        if (result.newCursorPos !== undefined) {
          setCursorPos(result.newCursorPos);
        }
      }
    } else if (cmdPalette.showCommands) {
      const newValue = cmdPalette.handleKeyboardSelect();
      if (newValue) {
        setInput(newValue);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hook returns are stable
  }, [fileComplete.showFiles, cmdPalette.showCommands]);

  const handleChipClick = useCallback(
    (trigger: string) => {
      const existingTrigger = input.match(/(^|\s)([/@])([\w./:-]*)$/);
      let newValue: string;

      if (existingTrigger) {
        const triggerChar = existingTrigger[2];
        const queryText = existingTrigger[3];
        const triggerStart = (existingTrigger.index ?? 0) + existingTrigger[1].length;

        if (triggerChar === trigger && !queryText) {
          const prefix = input.slice(0, triggerStart);
          newValue = prefix.endsWith(' ') && triggerStart > 0 ? prefix.slice(0, -1) : prefix;
          setInput(newValue);
          fileComplete.setShowFiles(false);
          cmdPalette.setShowCommands(false);
          requestAnimationFrame(() => chatInputRef.current?.focusAt(newValue.length));
          return;
        }
        newValue = input.slice(0, triggerStart) + trigger;
      } else if (input.length > 0 && !input.endsWith(' ')) {
        newValue = input + ' ' + trigger;
      } else {
        newValue = input + trigger;
      }

      setInput(newValue);
      detectTrigger(newValue, newValue.length);
      requestAnimationFrame(() => chatInputRef.current?.focusAt(newValue.length));
    },
    [input, setInput]
  );

  const isPaletteOpen = cmdPalette.showCommands || fileComplete.showFiles;

  const activeDescendantId =
    fileComplete.showFiles && fileComplete.filteredFiles.length > 0
      ? `file-item-${fileComplete.fileSelectedIndex}`
      : cmdPalette.showCommands && cmdPalette.filteredCommands.length > 0
        ? `command-item-${cmdPalette.selectedIndex}`
        : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        {isLoadingHistory ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <div className="flex gap-1">
                <span
                  className="bg-muted-foreground h-2 w-2 rounded-full"
                  style={{
                    animation: 'typing-dot 1.4s ease-in-out infinite',
                    animationDelay: '0s',
                  }}
                />
                <span
                  className="bg-muted-foreground h-2 w-2 rounded-full"
                  style={{
                    animation: 'typing-dot 1.4s ease-in-out infinite',
                    animationDelay: '0.2s',
                  }}
                />
                <span
                  className="bg-muted-foreground h-2 w-2 rounded-full"
                  style={{
                    animation: 'typing-dot 1.4s ease-in-out infinite',
                    animationDelay: '0.4s',
                  }}
                />
              </div>
              Loading conversation...
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-muted-foreground text-base">Start a conversation</p>
              <p className="text-muted-foreground/60 mt-2 text-sm">Type a message below to begin</p>
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
            isWaitingForUser={isWaitingForUser}
            waitingType={waitingType ?? undefined}
            activeToolCallId={activeInteraction?.toolCallId ?? null}
            onToolRef={handleToolRef}
            focusedOptionIndex={focusedOptionIndex}
          />
        )}

        <AnimatePresence>
          {hasNewMessages && !isAtBottom && (
            <motion.button
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.2 }}
              onClick={scrollToBottom}
              className="bg-foreground text-background hover:bg-foreground/90 absolute bottom-16 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium shadow-sm transition-colors"
              role="status"
              aria-live="polite"
            >
              New messages
            </motion.button>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {!isAtBottom && messages.length > 0 && !isLoadingHistory && (
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.15 }}
              onClick={scrollToBottom}
              className="bg-background absolute right-4 bottom-4 rounded-full border p-2 shadow-sm transition-shadow hover:shadow-md"
              aria-label="Scroll to bottom"
            >
              <ArrowDown className="size-(--size-icon-md)" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <CelebrationOverlay
        celebration={celebrations.activeCelebration}
        onComplete={celebrations.clearCelebration}
      />

      <TaskListPanel
        tasks={taskState.tasks}
        activeForm={taskState.activeForm}
        isCollapsed={taskState.isCollapsed}
        onToggleCollapse={taskState.toggleCollapse}
        celebratingTaskId={celebrations.celebratingTaskId}
        onCelebrationComplete={celebrations.clearCelebration}
      />

      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="chat-input-container relative border-t p-4">
        <AnimatePresence>
          {cmdPalette.showCommands && (
            <CommandPalette
              filteredCommands={cmdPalette.filteredCommands}
              selectedIndex={cmdPalette.selectedIndex}
              onSelect={handleCommandSelect}
            />
          )}
          {fileComplete.showFiles && (
            <FilePalette
              filteredFiles={fileComplete.filteredFiles}
              selectedIndex={fileComplete.fileSelectedIndex}
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
          sessionBusy={sessionBusy}
          onStop={stop}
          onEscape={() => {
            cmdPalette.setShowCommands(false);
            fileComplete.setShowFiles(false);
          }}
          onClear={() => {
            setInput('');
            cmdPalette.setShowCommands(false);
            fileComplete.setShowFiles(false);
          }}
          isPaletteOpen={isPaletteOpen}
          onArrowUp={handleArrowUp}
          onArrowDown={handleArrowDown}
          onCommandSelect={handleKeyboardSelect}
          activeDescendantId={activeDescendantId}
          onCursorChange={handleCursorChange}
        />

        {isMobile && (
          <>
            <motion.div
              animate={showHint ? { y: [0, 8, 0] } : undefined}
              transition={showHint ? { duration: 1.2, repeat: 2 } : undefined}
            >
              <DragHandle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
            </motion.div>
            <AnimatePresence>
              {showHint && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={dismissHint}
                  className="text-muted-foreground cursor-pointer text-center text-xs"
                >
                  Swipe to collapse
                </motion.p>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  className="overflow-hidden"
                  drag="y"
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={0.2}
                  onDragEnd={handleDragEnd}
                  style={{ touchAction: 'pan-y' }}
                >
                  {showShortcutChips && <ShortcutChips onChipClick={handleChipClick} />}
                  <StatusLine
                    sessionId={sessionId}
                    sessionStatus={sessionStatus}
                    isStreaming={status === 'streaming'}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        {!isMobile && (
          <>
            <AnimatePresence>
              {showShortcutChips && <ShortcutChips onChipClick={handleChipClick} />}
            </AnimatePresence>
            <StatusLine
              sessionId={sessionId}
              sessionStatus={sessionStatus}
              isStreaming={status === 'streaming'}
            />
          </>
        )}
      </div>
    </div>
  );
}
