import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../model/use-chat-session';
import { cn } from '@/layers/shared/lib';
import { UiActionChip, parseUiActionMessage } from '@/layers/features/gen-ui';
import { parseFilePrefix } from '../../lib/parse-file-prefix';
import { formatCompactionLabel } from '../../lib/format-compaction';
import { FileAttachmentList } from './FileAttachmentList';
import { OutputRenderer } from './OutputRenderer';

/**
 * Renders user message content based on messageType.
 * Handles plain text, command (monospace), local-command output (terminal-style),
 * and compaction (a labelled rule, expandable only when the boundary carries a
 * summary to expand — a log-backed runtime's does not).
 */
export function UserMessageContent({ message }: { message: ChatMessage }) {
  const [compactionExpanded, setCompactionExpanded] = useState(false);
  const parsed = useMemo(() => parseFilePrefix(message.content), [message.content]);
  // A widget interaction arrives as a `<ui_action>` block in a plain user turn
  // (live optimistic copy and reloaded transcript alike) — render it as a calm
  // interaction chip instead of the raw XML.
  const uiAction = useMemo(() => parseUiActionMessage(message.content), [message.content]);
  if (uiAction) return <UiActionChip action={uiAction} />;

  if (message.messageType === 'command') {
    // Wraps rather than truncates: the command sits in the full content column
    // now, so a long command with arguments can show all of itself.
    return (
      <div className="text-msg-command-fg font-mono text-sm break-words">{message.content}</div>
    );
  }

  // Output of a local slash command (/context, /usage, /rename, …). Rendered
  // across the full content column (see SessionMessage) via the shared tool-output
  // renderer so ANSI, JSON, and plain text all display correctly (DOR-126).
  if (message.messageType === 'local_command_output') {
    return <OutputRenderer content={message.content} toolName="" />;
  }

  if (message.messageType === 'compaction') {
    const label = formatCompactionLabel(message.compactMetadata);
    // Claude's boundary annotates a summary record, so there is something to
    // open. A log-backed runtime reconstructs the boundary from the event
    // stream, which carries no summary at all — so the rule is still drawn (it
    // is what marks where the history above was summarized away) but without a
    // control that would open onto nothing (DOR-1215).
    const summary = message.content.trim();
    const rule = <div className="bg-border/40 h-px flex-1" />;

    if (summary.length === 0) {
      return (
        <div
          data-testid="compaction-row"
          className="text-msg-compaction-fg flex w-full items-center gap-2 text-xs"
        >
          {rule}
          <span>{label}</span>
          {rule}
        </div>
      );
    }

    return (
      <div className="w-full" data-testid="compaction-row">
        <button
          onClick={() => setCompactionExpanded(!compactionExpanded)}
          className="text-msg-compaction-fg flex w-full items-center gap-2 text-xs"
        >
          {rule}
          <ChevronRight
            className={cn(
              'size-3 transition-transform duration-200',
              compactionExpanded && 'rotate-90'
            )}
          />
          <span>{label}</span>
          {rule}
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
