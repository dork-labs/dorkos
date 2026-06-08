import { useEffect, useRef, useState } from 'react';
import type { BackgroundTaskPart } from '@dorkos/shared/types';
import { getToolStatusIcon, CollapsibleCard, type ToolIconStatus } from '../primitives';

interface SubagentBlockProps {
  part: BackgroundTaskPart;
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

/** Build a tool usage summary string from background task progress metrics. */
function buildToolSummary(part: BackgroundTaskPart): string | null {
  const segments: string[] = [];
  if (part.toolUses) {
    segments.push(`${part.toolUses} tool ${part.toolUses === 1 ? 'call' : 'calls'}`);
  }
  if (part.durationMs) {
    segments.push(formatDuration(part.durationMs));
  }
  return segments.length > 0 ? segments.join(' \u00b7 ') : null;
}

/** Collapsible inline block displaying a background task's lifecycle status. */
export function SubagentBlock({ part }: SubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const streamRef = useRef<HTMLPreElement>(null);

  const toolSummary = buildToolSummary(part);
  const subagentText = part.subagentText;
  const hasExpandableContent = Boolean(
    toolSummary || part.summary || part.lastToolName || subagentText
  );

  // Tail the live subagent output: pin to the bottom as new text streams in.
  // The pre only mounts while expanded, so this is a no-op when collapsed.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [subagentText]);

  return (
    <CollapsibleCard
      expanded={expanded}
      onToggle={() => hasExpandableContent && setExpanded(!expanded)}
      hideChevron={!hasExpandableContent}
      ariaLabel={`Background task: ${part.description}`}
      data-testid="subagent-block"
      data-task-id={part.taskId}
      data-status={part.status}
      header={
        <>
          {getToolStatusIcon(
            (part.status === 'stopped' ? 'complete' : part.status) as ToolIconStatus
          )}
          <span className="text-3xs truncate font-mono">{part.description}</span>
          {toolSummary && (
            <span className="text-3xs text-muted-foreground ml-1 shrink-0">{toolSummary}</span>
          )}
        </>
      }
    >
      <div className="space-y-1.5">
        {subagentText && (
          <div className="space-y-1">
            <p className="text-3xs text-muted-foreground/70 tracking-wide uppercase">
              Subagent output
            </p>
            <pre
              ref={streamRef}
              className="text-foreground/90 bg-muted/50 max-h-64 overflow-y-auto rounded-md p-2 text-xs break-words whitespace-pre-wrap"
              data-testid="subagent-text"
            >
              {subagentText}
            </pre>
          </div>
        )}
        {part.lastToolName && part.status === 'running' && (
          <p className="text-3xs text-muted-foreground">
            Last tool: <span className="font-mono">{part.lastToolName}</span>
          </p>
        )}
        {part.summary && (
          <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{part.summary}</pre>
        )}
      </div>
    </CollapsibleCard>
  );
}
