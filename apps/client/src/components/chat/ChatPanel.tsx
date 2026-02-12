import { useState, useMemo, useEffect, useCallback } from 'react';
import { AnimatePresence } from 'motion/react';
import { useChatSession } from '../../hooks/use-chat-session';
import { useCommands } from '../../hooks/use-commands';
import { useTaskState } from '../../hooks/use-task-state';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { TaskListPanel } from './TaskListPanel';
import { CommandPalette } from '../commands/CommandPalette';
import { StatusLine } from '../status/StatusLine';
import type { CommandEntry } from '@lifeos/shared/types';

interface ChatPanelProps {
  sessionId: string;
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
}

export function ChatPanel({ sessionId, transformContent }: ChatPanelProps) {
  const taskState = useTaskState(sessionId);
  const { messages, input, setInput, handleSubmit, status, error, stop, isLoadingHistory, sessionStatus } =
    useChatSession(sessionId, { transformContent, onTaskEvent: taskState.handleTaskEvent });
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { data: registry } = useCommands();
  const allCommands = registry?.commands ?? [];

  const filteredCommands = useMemo(() => {
    if (!commandQuery) return allCommands;
    const q = commandQuery.toLowerCase();
    return allCommands.filter((cmd) => {
      const searchText = `${cmd.fullCommand} ${cmd.description}`.toLowerCase();
      return searchText.includes(q);
    });
  }, [allCommands, commandQuery]);

  // Reset selectedIndex when filter changes or palette opens/closes
  useEffect(() => {
    setSelectedIndex(0);
  }, [commandQuery, showCommands]);

  // Clamp selectedIndex when filteredCommands shrinks
  useEffect(() => {
    if (filteredCommands.length > 0 && selectedIndex >= filteredCommands.length) {
      setSelectedIndex(filteredCommands.length - 1);
    }
  }, [filteredCommands.length, selectedIndex]);

  function handleInputChange(value: string) {
    setInput(value);
    // Detect slash command trigger
    const match = value.match(/(^|\s)\/(\w*)$/);
    if (match) {
      setShowCommands(true);
      setCommandQuery(match[2]);
    } else {
      setShowCommands(false);
    }
  }

  function handleCommandSelect(cmd: CommandEntry) {
    setInput(cmd.fullCommand + ' ');
    setShowCommands(false);
  }

  const handleArrowDown = useCallback(() => {
    setSelectedIndex((prev) =>
      filteredCommands.length === 0 ? 0 : (prev + 1) % filteredCommands.length
    );
  }, [filteredCommands.length]);

  const handleArrowUp = useCallback(() => {
    setSelectedIndex((prev) =>
      filteredCommands.length === 0
        ? 0
        : (prev - 1 + filteredCommands.length) % filteredCommands.length
    );
  }, [filteredCommands.length]);

  const handleKeyboardCommandSelect = useCallback(() => {
    if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
      handleCommandSelect(filteredCommands[selectedIndex]);
    } else {
      setShowCommands(false);
    }
  }, [filteredCommands, selectedIndex]);

  const activeDescendantId =
    showCommands && filteredCommands.length > 0
      ? `command-item-${selectedIndex}`
      : undefined;

  return (
    <div className="flex flex-col h-full">
      {isLoadingHistory ? (
        <div className="flex-1 flex items-center justify-center">
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
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground text-base">Start a conversation</p>
            <p className="text-muted-foreground/60 text-sm mt-2">Type a message below to begin</p>
          </div>
        </div>
      ) : (
        <MessageList messages={messages} sessionId={sessionId} status={status} />
      )}

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

      <div className="relative border-t p-4">
        <AnimatePresence>
          {showCommands && (
            <CommandPalette
              filteredCommands={filteredCommands}
              selectedIndex={selectedIndex}
              onSelect={handleCommandSelect}
              onClose={() => setShowCommands(false)}
            />
          )}
        </AnimatePresence>

        <ChatInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isLoading={status === 'streaming'}
          onStop={stop}
          onEscape={() => setShowCommands(false)}
          isPaletteOpen={showCommands}
          onArrowUp={handleArrowUp}
          onArrowDown={handleArrowDown}
          onCommandSelect={handleKeyboardCommandSelect}
          activeDescendantId={activeDescendantId}
        />

        <StatusLine
          sessionId={sessionId}
          sessionStatus={sessionStatus}
          isStreaming={status === 'streaming'}
        />
      </div>
    </div>
  );
}
