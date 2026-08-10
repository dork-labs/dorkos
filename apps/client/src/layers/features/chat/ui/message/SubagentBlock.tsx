import { useEffect, useRef, useState } from 'react';
import type { BackgroundTaskPart, BackgroundTaskStatus } from '@dorkos/shared/types';
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

/**
 * Pick the header glyph for a background task's status.
 *
 * Three of the five map straight through. The other two are endings that are not
 * failures, and they take DIFFERENT glyphs because they are different facts:
 *
 * - `stopped` — something stopped it, which is a real ending somebody observed.
 *   The tick, as before.
 * - `untracked` — DorkOS lost sight of it and does not know how it ended, or
 *   whether it has (DOR-1108). The muted dash: a tick here would report a
 *   success nobody witnessed, which is the exact claim this status exists to
 *   avoid, and a cross would report a failure just as invented.
 */
function toIconStatus(status: BackgroundTaskStatus): ToolIconStatus {
  if (status === 'untracked') return 'neutral';
  if (status === 'stopped') return 'complete';
  return status;
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
  // The one ending that needs explaining rather than just marking, so it counts
  // as content even when the task left nothing else behind (DOR-1108).
  const untracked = part.status === 'untracked';
  const hasExpandableContent = Boolean(
    toolSummary || part.summary || part.lastToolName || subagentText || untracked
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
          {getToolStatusIcon(toIconStatus(part.status))}
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
        {/* Says what DorkOS knows and stops there. It cannot see this task any
            more, and it has no way to find out how it ended — claiming either
            outcome would be a guess dressed as a result. */}
        {untracked && (
          <p className="text-3xs text-muted-foreground" data-testid="subagent-untracked">
            DorkOS lost track of this one when the agent finished. It may still be running.
          </p>
        )}
      </div>
    </CollapsibleCard>
  );
}
