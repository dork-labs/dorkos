import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X, ChevronDown } from 'lucide-react';
import type { SubagentPart } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { toolStatus } from './message/message-variants';

interface SubagentBlockProps {
  part: SubagentPart;
}

/** Format duration from milliseconds to human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Build a tool usage summary string from subagent progress metrics. */
function buildToolSummary(part: SubagentPart): string | null {
  const segments: string[] = [];
  if (part.toolUses) {
    segments.push(`${part.toolUses} tool ${part.toolUses === 1 ? 'call' : 'calls'}`);
  }
  if (part.durationMs) {
    segments.push(formatDuration(part.durationMs));
  }
  return segments.length > 0 ? segments.join(' \u00b7 ') : null;
}

/** Collapsible inline block displaying a subagent's lifecycle status. */
export function SubagentBlock({ part }: SubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: <Loader2 className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status: 'running' }))} />,
    complete: <Check className={cn('size-(--size-icon-xs)', toolStatus({ status: 'complete' }))} />,
    error: <X className={cn('size-(--size-icon-xs)', toolStatus({ status: 'error' }))} />,
  }[part.status];

  const toolSummary = buildToolSummary(part);
  const hasExpandableContent = toolSummary || part.summary || part.lastToolName;

  return (
    <div
      className="bg-muted/50 hover:border-border mt-px rounded-msg-tool border text-sm shadow-msg-tool transition-all duration-150 first:mt-1 hover:shadow-msg-tool-hover"
      data-testid="subagent-block"
      data-task-id={part.taskId}
      data-status={part.status}
    >
      <button
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1"
        aria-expanded={hasExpandableContent ? expanded : undefined}
        aria-label={`Subagent: ${part.description}`}
      >
        {statusIcon}
        <span className="text-3xs font-mono truncate">{part.description}</span>
        {toolSummary && (
          <span className="text-3xs text-muted-foreground ml-1 shrink-0">{toolSummary}</span>
        )}
        {hasExpandableContent && (
          <motion.div
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="ml-auto"
          >
            <ChevronDown className="size-(--size-icon-xs)" />
          </motion.div>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasExpandableContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 pt-1 pb-3 space-y-1">
              {part.lastToolName && part.status === 'running' && (
                <p className="text-3xs text-muted-foreground">
                  Last tool: <span className="font-mono">{part.lastToolName}</span>
                </p>
              )}
              {part.summary && (
                <pre className="text-xs whitespace-pre-wrap overflow-x-auto">
                  {part.summary}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
