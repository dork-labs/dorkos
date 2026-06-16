import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../model/use-chat-session';
import { cn } from '@/layers/shared/lib';
import { parseFilePrefix } from '../../lib/parse-file-prefix';
import { formatCompactionLabel } from '../../lib/format-compaction';
import { FileAttachmentList } from './FileAttachmentList';
import { OutputRenderer } from './OutputRenderer';

/**
 * Renders user message content based on messageType.
 * Handles plain text, command (monospace), local-command output (terminal-style),
 * and compaction (expandable).
 */
export function UserMessageContent({ message }: { message: ChatMessage }) {
  const [compactionExpanded, setCompactionExpanded] = useState(false);
  const parsed = useMemo(() => parseFilePrefix(message.content), [message.content]);

  if (message.messageType === 'command') {
    return <div className="text-msg-command-fg truncate font-mono text-sm">{message.content}</div>;
  }

  // Output of a local slash command (/context, /usage, /rename, …). Rendered
  // full-width (see MessageItem) via the shared tool-output renderer so ANSI,
  // JSON, and plain text all display correctly (DOR-126).
  if (message.messageType === 'local_command_output') {
    return <OutputRenderer content={message.content} toolName="" />;
  }

  if (message.messageType === 'compaction') {
    return (
      <div className="w-full">
        <button
          onClick={() => setCompactionExpanded(!compactionExpanded)}
          className="text-msg-compaction-fg flex w-full items-center gap-2 text-xs"
        >
          <div className="bg-border/40 h-px flex-1" />
          <ChevronRight
            className={cn(
              'size-3 transition-transform duration-200',
              compactionExpanded && 'rotate-90'
            )}
          />
          <span>{formatCompactionLabel(message.compactMetadata)}</span>
          <div className="bg-border/40 h-px flex-1" />
        </button>
        {compactionExpanded && (
          <div className="text-msg-compaction-fg mt-2 text-xs whitespace-pre-wrap">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {parsed.files.length > 0 && <FileAttachmentList files={parsed.files} />}
      {parsed.textContent && (
        <div className="break-words whitespace-pre-wrap">{parsed.textContent}</div>
      )}
    </div>
  );
}
